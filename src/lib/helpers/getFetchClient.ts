import type { RetryOptions } from "@std/async";
import type { Config } from "./config.ts";
import type { Metrics } from "./metrics.ts";
import { generateRandomIPv6 } from "./ipv6Rotation.ts";
import { CTX, logInfo, logWarn } from "./log.ts";
import { FetchGate } from "./fetchGate.ts";
import { checkYouTubeBlock, maskProxyUrl } from "./youtubeBlockDetection.ts";
import {
    type FetchFn,
    type FetchInitParameterWithClient,
    type FetchInputParameter,
    fetchShim as rawFetchShim,
} from "./fetchShim.ts";

export type {
    FetchFn,
    FetchInitParameterWithClient,
    FetchInputParameter,
    FetchReturn,
} from "./fetchShim.ts";
export { buildFetchSignal } from "./fetchShim.ts";

// Process-wide latch: if generating an IPv6 source address ever fails (host
// has no IPv6 support), we disable rotation permanently rather than retrying
// on every request. Intentionally one-way — recovery requires a restart.
let ipv6Enabled = true;

/**
 * Singleton cache: ensures getFetchClient(config) returns the SAME fetch
 * function (with shared proxy pool state, round-robin index, health tracking)
 * no matter how many times it's called across the codebase.
 *
 * Before this fix, every call to getFetchClient() created a brand-new set of
 * HttpClients, round-robin state, and health tracking — meaning proxy pool
 * state was never shared between main.ts, potoken.ts, and videoPlaybackProxy.ts.
 */
let cachedFetchFn: FetchFn | null = null;
let cachedConfigRef: Config | null = null;

// Module-level metrics handle. Set on the first call that provides it (from
// main.ts at startup) and shared by all internal helpers in this isolate.
// Note: the PO-token worker runs in a separate isolate and has no metrics.
let metricsRef: Metrics | undefined;

// Invoked (in the main isolate only) when a YouTube anti-bot block is detected
// and could not be worked around within the request. main.ts registers a
// debounced handler that proactively regenerates the session.
let onYouTubeBlock: (() => void) | undefined;
export function setOnYouTubeBlock(cb: () => void): void {
    onYouTubeBlock = cb;
}

// Invoked (main isolate only) whenever the proxy pool's active egress proxy
// changes AND switch_proxy_on_limit is enabled. main.ts uses it to swap in the
// per-proxy session (visitor_data + PO token) bound to the new egress IP, so a
// rate-limit-driven hop keeps the session IP-consistent. Not fired when the
// flag is off — the pool then behaves as pure failover, unchanged.
let onActiveProxyChange: ((proxyUrl: string) => void) | undefined;
export function setOnActiveProxyChange(cb: (proxyUrl: string) => void): void {
    onActiveProxyChange = cb;
}

// When the proxy pool is active, this points at its proxy selector so the
// session bootstrap (PO-token worker) can be pinned to the same egress IP the
// request path is using. Null when no pool is configured.
let poolActiveProxySelector:
    | ((excluded?: Set<string>) => Promise<string | null>)
    | null = null;

// When the proxy pool is active, advances the pinned egress proxy to a fresh
// healthy one (see rotateSessionEgressProxy). Null when no pool is configured.
let rotateActiveEgressProxy: (() => Promise<string | null>) | null = null;

/**
 * Resolve the egress proxy the current session should use, so the PO-token
 * worker can attest from the same IP the player/stream requests go through.
 * Returns the pool's active proxy when a pool is configured, otherwise the
 * single configured proxy (or null for direct/IPv6).
 */
export async function getSessionEgressProxy(
    config: Config,
): Promise<string | null> {
    // Ensure the pool (and its selector) has been initialised.
    getFetchClient(config);
    if (poolActiveProxySelector) {
        return await poolActiveProxySelector();
    }
    return config.networking.proxy ?? null;
}

/**
 * Advance the session's egress proxy to a *different* healthy proxy in the
 * pool, returning the newly-pinned proxy URL. Used by the startup PO-token
 * bootstrap to sweep the pool for a non-blocked IP between attempts: a single
 * detected block is only one of the three failures needed to blacklist a
 * proxy, so without this the bootstrap would keep re-pinning (and re-attesting
 * through) the same blocked proxy. Returns the single configured proxy / null
 * when no pool is in use (nothing to rotate).
 */
export async function rotateSessionEgressProxy(
    config: Config,
): Promise<string | null> {
    // Ensure the pool (and its rotator) has been initialised.
    getFetchClient(config);
    if (rotateActiveEgressProxy) {
        return await rotateActiveEgressProxy();
    }
    return config.networking.proxy ?? null;
}

// Process-wide outbound rate limiter (built from config.networking.rate_limit).
let fetchGate: FetchGate | undefined;

// Adapter: keeps the module-level gate and the retry metric out of fetchShim.ts.
function fetchShim(
    config: Config,
    retryOptions: RetryOptions,
    input: FetchInputParameter,
    init?: FetchInitParameterWithClient,
    gate?: FetchGate,
) {
    return rawFetchShim(
        config,
        retryOptions,
        input,
        init,
        gate ?? fetchGate,
        () => metricsRef?.upstreamRetries.inc(),
    );
}

export const getFetchClient = (config: Config, metrics?: Metrics): FetchFn => {
    if (metrics) metricsRef = metrics;

    // Return cached instance if the same config object is used
    if (cachedFetchFn && cachedConfigRef === config) {
        return cachedFetchFn;
    }

    const proxyAddress = config.networking.proxy;
    const ipv6Block = config.networking.ipv6_block;

    const fetchMaxAttempts = config.networking.fetch?.retry?.times;
    const fetchInitialDebounce = config.networking.fetch?.retry
        ?.initial_debounce;
    const fetchDebounceMultiplier = config.networking.fetch?.retry
        ?.debounce_multiplier;
    const retryOptions: RetryOptions = {
        maxAttempts: fetchMaxAttempts,
        minTimeout: fetchInitialDebounce,
        multiplier: fetchDebounceMultiplier,
        jitter: 0,
    };

    // (Re)build the outbound rate limiter for this config.
    const rl = config.networking.rate_limit;
    fetchGate = rl?.enabled
        ? new FetchGate(rl.max_concurrent, rl.min_interval_ms)
        : undefined;

    // The proxy pool is FAILOVER-ONLY, not load-balancing. It pins a single
    // active proxy and routes everything through it; `rotation` (round-robin |
    // random) only decides which proxy becomes active *next* after the current
    // one is blacklisted (3 failures / a detected block / a failed health
    // probe). This is deliberate: one logical session should egress from one
    // IP so PO tokens, visitor_data, and stream requests stay IP-consistent.
    // It does NOT spread load across proxies within a session.
    const proxyPool = config.networking.proxy_pool;
    if (proxyPool?.enabled && proxyPool.proxies.length > 0) {
        const proxyClients = new Map<string, Deno.HttpClient>();
        const allProxyUrls = [...proxyPool.proxies]; // permanent list for recovery
        const healthyProxies = new Set(proxyPool.proxies);
        const failureCounts = new Map<string, number>();
        const lastBlacklistTime = new Map<string, number>();
        const FAILURE_THRESHOLD = 3;
        const BLACKLIST_MS = 3_600_000; // 1 hour
        // Cooldown re-validation is a network probe. Run it at most once per
        // interval and share one in-flight run between concurrent requests,
        // otherwise every request that arrives after a blacklist expires
        // probes the same proxy in parallel (and pays the probe latency).
        // Effect: after a 1-hour blacklist expires, recovery may be delayed
        // by up to this interval.
        const REVALIDATE_MIN_INTERVAL_MS = 30_000;
        let revalidateInFlight: Promise<void> | null = null;
        let lastRevalidateAt = 0;
        let activeProxyUrl: string | null = null;

        const switchProxyOnLimit = proxyPool.switch_proxy_on_limit &&
            !!rl?.enabled;

        // Per-proxy rate gates: throttle each egress IP independently rather
        // than process-wide. With these in place the shared module-level gate
        // would double-count, so it is disabled on the pool path.
        const proxyGates = new Map<string, FetchGate>();
        if (rl?.enabled) {
            fetchGate = undefined;
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
                onActiveProxyChange?.(proxyUrl);
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
                return candidates[
                    Math.floor(Math.random() * candidates.length)
                ];
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
                const response = await fetchShim(
                    config,
                    retryOptions,
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
                    metricsRef?.proxyRecoveries.inc();
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
                metricsRef?.proxyBlacklists.inc();
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

        // Expose the selector so the session bootstrap can pin to this pool's
        // active egress proxy (see getSessionEgressProxy).
        poolActiveProxySelector = ensureActiveProxy;

        // Expose a rotator so the startup bootstrap can force a hop to a fresh
        // egress IP between PO-token attempts (see rotateSessionEgressProxy).
        rotateActiveEgressProxy = async (): Promise<string | null> => {
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

        const fn: FetchFn = async (
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
                let proxyUrl = await ensureActiveProxy(excluded);
                if (!proxyUrl) break;

                // Rate-limit-aware hop: if the chosen proxy's gate is currently
                // saturated, prefer a healthy proxy that still has capacity
                // instead of queuing behind the busy one. This is what lets
                // sustained load fan out across the pool. setActiveProxy fires
                // the session swap so the new egress carries its own session.
                if (
                    switchProxyOnLimit && proxyGates.get(proxyUrl)?.saturated()
                ) {
                    const candidates = Array.from(healthyProxies).filter((p) =>
                        !excluded.has(p) && !proxyGates.get(p)?.saturated()
                    );
                    if (candidates.length > 0) {
                        const alt = candidates[rrIndex % candidates.length];
                        rrIndex = (rrIndex + 1) % candidates.length;
                        setActiveProxy(alt);
                        proxyUrl = alt;
                    }
                }
                metricsRef?.proxySelections.inc();

                const client = proxyClients.get(proxyUrl)!;

                try {
                    const fetchRes = await fetchShim(
                        config,
                        retryOptions,
                        input,
                        {
                            client,
                            headers: init?.headers,
                            method: init?.method,
                            body: init?.body,
                            redirect: init?.redirect,
                            signal: init?.signal,
                            streaming: init?.streaming,
                        },
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
                            metricsRef?.proxyBlockRetries.inc();
                        }
                        continue;
                    }

                    markProxySuccess(proxyUrl);
                    return fetchRes;
                } catch (e) {
                    metricsRef?.upstreamFailures.inc();
                    markProxyFailure(proxyUrl);
                    excluded.add(proxyUrl);
                    lastErr = e;
                }
            }

            // Exhausted attempts. A block we couldn't route around should kick
            // off a proactive session regeneration.
            if (sawBlock) onYouTubeBlock?.();
            if (lastRes) return lastRes;
            if (lastErr) throw lastErr;
            throw new Error(
                "All proxies in the pool are blacklisted or unhealthy. No healthy proxy available.",
            );
        };

        cachedFetchFn = fn;
        cachedConfigRef = config;
        return fn;
    }

    // Single proxy / IPv6 path
    if (proxyAddress || (ipv6Block && ipv6Enabled)) {
        const reusableClient = proxyAddress && !ipv6Block
            ? Deno.createHttpClient({ proxy: { url: proxyAddress } })
            : undefined;

        const fn: FetchFn = async (
            input: FetchInputParameter,
            init?: FetchInitParameterWithClient,
        ) => {
            let client: Deno.HttpClient;
            if (reusableClient) {
                client = reusableClient;
            } else {
                const clientOptions: Deno.CreateHttpClientOptions = {};
                if (proxyAddress) clientOptions.proxy = { url: proxyAddress };
                if (ipv6Block && ipv6Enabled) {
                    try {
                        clientOptions.localAddress = generateRandomIPv6(
                            ipv6Block,
                        );
                        metricsRef?.ipv6AddressGenerated.inc();
                    } catch {
                        ipv6Enabled = false;
                        metricsRef?.ipv6Fallback.inc();
                    }
                }
                client = Deno.createHttpClient(clientOptions);
            }

            let fetchRes: Response;
            try {
                fetchRes = await fetchShim(config, retryOptions, input, {
                    client,
                    ...init,
                });
            } catch (e) {
                if (!reusableClient) client.close();
                throw e;
            }
            // Per-request clients (IPv6 rotation) would otherwise never be
            // closed and leak a socket/FD per request. The client must stay
            // open until the body has been streamed, so close it only when
            // the response settles.
            if (!reusableClient) {
                fetchRes = closeClientWhenDone(fetchRes, client);
            }

            // Detect YouTube block signals even on single-proxy path.
            // Previously this detection only existed in the proxy_pool path,
            // so blocks via a single proxy or direct connection were invisible.
            const isBlocked = await checkYouTubeBlock(fetchRes);
            if (isBlocked) {
                logWarn(
                    CTX.PROXY,
                    `YouTube block detected on direct/single-proxy path — consider enabling proxy_pool`,
                );
                // No alternate egress to retry here, but a proactive session
                // regeneration may still recover (new visitor_data/PO token).
                onYouTubeBlock?.();
            }

            return fetchRes;
        };

        cachedFetchFn = fn;
        cachedConfigRef = config;
        return fn;
    }

    // No proxy path — direct fetch
    const fn: FetchFn = (
        input: FetchInputParameter,
        init?: FetchInitParameterWithClient,
    ) => fetchShim(config, retryOptions, input, init);

    cachedFetchFn = fn;
    cachedConfigRef = config;
    return fn;
};

/**
 * Tie the lifetime of a per-request HttpClient to its response: close the
 * client once the body has been fully read, cancelled, or errored. Closing
 * earlier would abort the in-flight body stream; never closing leaks a
 * socket/FD per request (fatal under IPv6 rotation, where a fresh client is
 * created for every request).
 */
function closeClientWhenDone(
    res: Response,
    client: Deno.HttpClient,
): Response {
    const close = () => {
        try {
            client.close();
        } catch {
            // Already closed.
        }
    };
    if (!res.body) {
        close();
        return res;
    }
    const monitored = res.body.pipeThrough(
        new TransformStream({ flush: close, cancel: close }),
    );
    const wrapped = new Response(monitored, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
    });
    // new Response() drops these read-only fetch metadata fields; callers
    // (e.g. youtubei.js) may inspect them.
    Object.defineProperty(wrapped, "url", { value: res.url });
    Object.defineProperty(wrapped, "redirected", { value: res.redirected });
    return wrapped;
}
