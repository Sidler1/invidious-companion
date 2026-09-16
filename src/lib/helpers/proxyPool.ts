import type { RetryOptions } from "@std/async";
import type { Config } from "./config.ts";
import type { Metrics } from "./metrics.ts";
import { CTX, logInfo, logWarn } from "./log.ts";
import { FetchGate } from "./fetchGate.ts";
import { checkYouTubeBlock, maskProxyUrl } from "./youtubeBlockDetection.ts";
import type {
    FetchFn,
    FetchInitParameterWithClient,
    FetchInputParameter,
    FetchReturn,
} from "./fetchShim.ts";

export interface ProxyPoolDeps {
    config: Config;
    retryOptions: RetryOptions;
    fetchShim: (
        config: Config,
        retryOptions: RetryOptions,
        input: FetchInputParameter,
        init?: FetchInitParameterWithClient,
        gate?: FetchGate,
    ) => FetchReturn;
    getMetrics: () => Metrics | undefined;
    getOnYouTubeBlock: () => (() => void) | undefined;
    getOnActiveProxyChange: () => ((proxyUrl: string) => void) | undefined;
}

export interface ProxyPool {
    fetch: FetchFn;
    ensureActiveProxy: (excluded?: Set<string>) => Promise<string | null>;
    rotateActiveProxy: () => Promise<string | null>;
}

const FAILURE_THRESHOLD = 3;
const BLACKLIST_MS = 3_600_000; // 1 hour
// Cooldown re-validation is a network probe. Run it at most once per
// interval and share one in-flight run between concurrent requests,
// otherwise every request that arrives after a blacklist expires
// probes the same proxy in parallel (and pays the probe latency).
// Effect: after a 1-hour blacklist expires, recovery may be delayed
// by up to this interval.
const REVALIDATE_MIN_INTERVAL_MS = 30_000;

/**
 * Failover-only proxy pool. It pins a single active proxy and routes
 * everything through it; `rotation` (round-robin | random) only decides
 * which proxy becomes active *next* after the current one is blacklisted
 * (3 failures / a detected block / a failed health probe). This is
 * deliberate: one logical session should egress from one IP so PO tokens,
 * visitor_data, and stream requests stay IP-consistent. It does NOT spread
 * load across proxies within a session (except the rate-limit-aware hop
 * when `switch_proxy_on_limit` is enabled).
 *
 * Precondition (checked by the caller): `config.networking.proxy_pool` is
 * enabled with at least one proxy.
 */
export function createProxyPool(deps: ProxyPoolDeps): ProxyPool {
    const proxyPool = deps.config.networking.proxy_pool;
    const rl = deps.config.networking.rate_limit;

    const proxyClients = new Map<string, Deno.HttpClient>();
    const allProxyUrls = [...proxyPool.proxies]; // permanent list for recovery
    const healthyProxies = new Set(proxyPool.proxies);
    const failureCounts = new Map<string, number>();
    const lastBlacklistTime = new Map<string, number>();
    let activeProxyUrl: string | null = null;
    let revalidateInFlight: Promise<void> | null = null;
    let lastRevalidateAt = 0;

    const switchProxyOnLimit = proxyPool.switch_proxy_on_limit &&
        !!rl?.enabled;

    // Per-proxy rate gates: throttle each egress IP independently rather
    // than process-wide. The caller disables its shared gate on this path.
    const proxyGates = new Map<string, FetchGate>();
    if (rl?.enabled) {
        for (const proxyUrl of allProxyUrls) {
            proxyGates.set(
                proxyUrl,
                new FetchGate(rl.max_concurrent, rl.min_interval_ms),
            );
        }
    }

    // Set the active egress proxy, notifying main.ts on an actual change so
    // it can swap in that proxy's session. Only fires when
    // switch_proxy_on_limit is on; otherwise the pool is pure failover and
    // behaviour is unchanged.
    const setActiveProxy = (proxyUrl: string): void => {
        const changed = activeProxyUrl !== proxyUrl;
        activeProxyUrl = proxyUrl;
        if (changed && switchProxyOnLimit) {
            deps.getOnActiveProxyChange()?.(proxyUrl);
        }
    };

    for (const proxyUrl of proxyPool.proxies) {
        try {
            proxyClients.set(
                proxyUrl,
                Deno.createHttpClient({ proxy: { url: proxyUrl } }),
            );
        } catch (e) {
            logWarn(
                CTX.PROXY,
                `Failed to init: ${maskProxyUrl(proxyUrl)} — ${e}`,
            );
            healthyProxies.delete(proxyUrl);
        }
    }

    let rrIndex = 0;

    const getCooldownExpiredProxies = (): string[] => {
        const now = Date.now();
        const recovered: string[] = [];
        for (const proxyUrl of allProxyUrls) {
            if (healthyProxies.has(proxyUrl)) continue;
            const lastBlacklist = lastBlacklistTime.get(proxyUrl) || 0;
            if (now - lastBlacklist > BLACKLIST_MS) {
                recovered.push(proxyUrl);
            }
        }
        return recovered;
    };

    const getNextHealthyProxy = (
        excluded: Set<string> = new Set(),
    ): string | null => {
        if (healthyProxies.size === 0) return null;
        const candidates = Array.from(healthyProxies).filter((proxy) =>
            !excluded.has(proxy)
        );
        if (candidates.length === 0) return null;
        if (proxyPool.rotation === "random") {
            return candidates[Math.floor(Math.random() * candidates.length)];
        }
        // Round-robin
        const proxy = candidates[rrIndex % candidates.length];
        rrIndex = (rrIndex + 1) % candidates.length;
        return proxy;
    };

    const probeProxyHealth = async (proxyUrl: string): Promise<boolean> => {
        const client = proxyClients.get(proxyUrl);
        if (!client) return false;

        try {
            const response = await deps.fetchShim(
                deps.config,
                deps.retryOptions,
                "https://www.youtube.com/generate_204",
                {
                    client,
                    method: "GET",
                },
            );
            const isBlocked = await checkYouTubeBlock(response);
            return !isBlocked && response.ok;
        } catch {
            return false;
        }
    };

    const runCooldownRevalidation = async (): Promise<void> => {
        const candidates = getCooldownExpiredProxies();
        for (const proxyUrl of candidates) {
            const isHealthy = await probeProxyHealth(proxyUrl);
            if (isHealthy) {
                healthyProxies.add(proxyUrl);
                failureCounts.set(proxyUrl, 0);
                deps.getMetrics()?.proxyRecoveries.inc();
                logInfo(
                    CTX.PROXY,
                    `Recovered after cooldown and probe: ${
                        maskProxyUrl(proxyUrl)
                    }`,
                );
            } else {
                lastBlacklistTime.set(proxyUrl, Date.now());
                logWarn(
                    CTX.PROXY,
                    `Probe failed after cooldown; keeping blacklisted: ${
                        maskProxyUrl(proxyUrl)
                    }`,
                );
            }
        }
    };

    const revalidateCooldownProxies = (): Promise<void> => {
        if (revalidateInFlight) return revalidateInFlight;
        const now = Date.now();
        if (now - lastRevalidateAt < REVALIDATE_MIN_INTERVAL_MS) {
            return Promise.resolve();
        }
        lastRevalidateAt = now;
        revalidateInFlight = runCooldownRevalidation().finally(() => {
            revalidateInFlight = null;
        });
        return revalidateInFlight;
    };

    const markProxyFailure = (proxyUrl: string) => {
        if (!proxyPool.health_check) return;
        const count = (failureCounts.get(proxyUrl) || 0) + 1;
        failureCounts.set(proxyUrl, count);

        if (count >= FAILURE_THRESHOLD) {
            deps.getMetrics()?.proxyBlacklists.inc();
            logWarn(
                CTX.PROXY,
                `Blacklisted for 1h: ${
                    maskProxyUrl(proxyUrl)
                } (${count} failures)`,
            );
            healthyProxies.delete(proxyUrl);
            lastBlacklistTime.set(proxyUrl, Date.now());
            if (activeProxyUrl === proxyUrl) {
                activeProxyUrl = null;
            }
        }
    };

    const markProxySuccess = (proxyUrl: string) => {
        failureCounts.set(proxyUrl, 0);
        setActiveProxy(proxyUrl);
    };

    const ensureActiveProxy = async (
        excluded: Set<string> = new Set(),
    ): Promise<string | null> => {
        await revalidateCooldownProxies();

        if (
            activeProxyUrl && healthyProxies.has(activeProxyUrl) &&
            !excluded.has(activeProxyUrl)
        ) {
            return activeProxyUrl;
        }

        const tried = new Set<string>(excluded);
        while (tried.size < allProxyUrls.length) {
            const candidate = getNextHealthyProxy(tried);
            if (!candidate) break;
            tried.add(candidate);

            const healthy = await probeProxyHealth(candidate);
            if (healthy) {
                markProxySuccess(candidate);
                return candidate;
            }

            markProxyFailure(candidate);
            if (!healthyProxies.has(candidate)) {
                logWarn(
                    CTX.PROXY,
                    `Startup/selection probe failed: ${
                        maskProxyUrl(candidate)
                    }`,
                );
            }
        }

        return null;
    };

    const rotateActiveProxy = async (): Promise<string | null> => {
        const previous = activeProxyUrl;
        activeProxyUrl = null;
        // Exclude the proxy we were just on so we land on a different IP;
        // ensureActiveProxy health-probes the candidate before pinning it.
        const excluded = previous
            ? new Set<string>([previous])
            : new Set<string>();
        const next = await ensureActiveProxy(excluded);
        if (next) {
            logInfo(
                CTX.PROXY,
                `Rotated session egress proxy to ${maskProxyUrl(next)}`,
            );
            return next;
        }
        // No other healthy proxy (single-proxy pool, or all others
        // unhealthy): fall back to whatever is available rather than
        // leaving the session with no egress proxy.
        return await ensureActiveProxy();
    };

    // Rate-limit-aware hop: if the chosen proxy's gate is currently
    // saturated, prefer a healthy proxy that still has capacity instead of
    // queuing behind the busy one. This is what lets sustained load fan out
    // across the pool. setActiveProxy fires the session swap so the new
    // egress carries its own session.
    const pickUnsaturatedAlternative = (
        proxyUrl: string,
        excluded: Set<string>,
    ): string => {
        if (!switchProxyOnLimit || !proxyGates.get(proxyUrl)?.saturated()) {
            return proxyUrl;
        }
        const candidates = Array.from(healthyProxies).filter((p) =>
            !excluded.has(p) && !proxyGates.get(p)?.saturated()
        );
        if (candidates.length === 0) return proxyUrl;
        const alt = candidates[rrIndex % candidates.length];
        rrIndex = (rrIndex + 1) % candidates.length;
        setActiveProxy(alt);
        return alt;
    };

    const poolFetch: FetchFn = async (
        input: FetchInputParameter,
        init?: FetchInitParameterWithClient,
    ) => {
        // On a detected block, fail the current proxy over to a different
        // healthy one within the same request instead of returning the
        // blocked response. Capped so we don't burn the whole pool on one
        // request. (Player bodies are JSON strings, safe to re-send.)
        const excluded = new Set<string>();
        const maxAttempts = Math.min(Math.max(allProxyUrls.length, 1), 3);
        let lastRes: Response | undefined;
        let lastErr: unknown;
        let sawBlock = false;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const pinned = await ensureActiveProxy(excluded);
            if (!pinned) break;
            const proxyUrl = pickUnsaturatedAlternative(pinned, excluded);
            deps.getMetrics()?.proxySelections.inc();

            const client = proxyClients.get(proxyUrl)!;

            try {
                const fetchRes = await deps.fetchShim(
                    deps.config,
                    deps.retryOptions,
                    input,
                    { ...init, client },
                    proxyGates.get(proxyUrl),
                );

                const isBlocked = await checkYouTubeBlock(fetchRes);

                if (isBlocked) {
                    sawBlock = true;
                    markProxyFailure(proxyUrl);
                    excluded.add(proxyUrl);
                    logWarn(
                        CTX.PROXY,
                        `Detected YouTube anti-bot response on ${
                            maskProxyUrl(proxyUrl)
                        }; failing over to another proxy.`,
                    );
                    // Discard the superseded blocked body to avoid a leak.
                    if (lastRes) {
                        await lastRes.body?.cancel().catch(() => {});
                    }
                    lastRes = fetchRes;
                    if (attempt < maxAttempts - 1) {
                        deps.getMetrics()?.proxyBlockRetries.inc();
                    }
                    continue;
                }

                markProxySuccess(proxyUrl);
                return fetchRes;
            } catch (e) {
                // A caller-initiated abort (e.g. the video proxy's
                // header-phase timeout, or the client disconnecting) is not
                // a proxy failure — rethrow immediately without blacklisting
                // or excluding the proxy.
                const name = (e as { name?: string } | undefined)?.name;
                if (init?.signal?.aborted || name === "AbortError") {
                    throw e;
                }
                deps.getMetrics()?.upstreamFailures.inc();
                markProxyFailure(proxyUrl);
                excluded.add(proxyUrl);
                lastErr = e;
            }
        }

        // Exhausted attempts. A block we couldn't route around should kick
        // off a proactive session regeneration.
        if (sawBlock) deps.getOnYouTubeBlock()?.();
        if (lastRes) return lastRes;
        if (lastErr) throw lastErr;
        throw new Error(
            "All proxies in the pool are blacklisted or unhealthy. No healthy proxy available.",
        );
    };

    return { fetch: poolFetch, ensureActiveProxy, rotateActiveProxy };
}
