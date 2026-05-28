import { retry, type RetryOptions } from "@std/async";
import type { Config } from "./config.ts";
import type { Metrics } from "./metrics.ts";
import { generateRandomIPv6 } from "./ipv6Rotation.ts";
import { CTX, logInfo, logWarn } from "./log.ts";

type FetchInputParameter = Parameters<typeof fetch>[0];
type FetchInitParameterWithClient =
    | RequestInit
    | RequestInit & { client: Deno.HttpClient };
type FetchReturn = ReturnType<typeof fetch>;
type FetchFn = (
    input: FetchInputParameter,
    init?: FetchInitParameterWithClient,
) => FetchReturn;

// Process-wide latch: if generating an IPv6 source address ever fails (host
// has no IPv6 support), we disable rotation permanently rather than retrying
// on every request. Intentionally one-way — recovery requires a restart.
let ipv6Enabled = true;

const YOUTUBE_BLOCK_SIGNALS = [
    "unusual traffic",
    "protect our community",
    "please sign in to confirm you're not a bot",
    "captcha",
];

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

// When the proxy pool is active, this points at its proxy selector so the
// session bootstrap (PO-token worker) can be pinned to the same egress IP the
// request path is using. Null when no pool is configured.
let poolActiveProxySelector:
    | ((excluded?: Set<string>) => Promise<string | null>)
    | null = null;

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

// Process-wide outbound rate limiter (built from config.networking.rate_limit).
let fetchGate: FetchGate | undefined;

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
        let activeProxyUrl: string | null = null;

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

        const revalidateCooldownProxies = async (): Promise<void> => {
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
            activeProxyUrl = proxyUrl;
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
                const proxyUrl = await ensureActiveProxy(excluded);
                if (!proxyUrl) break;
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
                        },
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

            const fetchRes = await fetchShim(config, retryOptions, input, {
                client,
                ...init,
            });

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
 * Check if a YouTube response contains bot detection signals.
 *
 * IMPORTANT: Only checks API/HTML responses (JSON, HTML, text content types).
 * Video CDN responses (video/mp4, application/octet-stream) are NEVER checked
 * because:
 * 1. YouTube's CDN legitimately returns 403 for unsupported request patterns
 *    (e.g., expired URLs, invalid ranges) — these are NOT bot blocks
 * 2. Reading video response bodies would buffer entire videos into memory (OOM)
 * 3. Treating video CDN 403s as bot blocks would falsely blacklist proxies
 *
 * For 403/429 on API responses: checks the body for known block signals.
 * For 200 on API responses: checks for block messages in the JSON body
 * (e.g., "protect our community" in playabilityStatus).
 *
 * Returns true if a bot block signal is detected, false otherwise.
 */
async function checkYouTubeBlock(response: Response): Promise<boolean> {
    // Only check text-based content types (API responses, HTML pages).
    // Skip binary content (video streams, media files) entirely —
    // a 403 on a video stream is NOT a bot block, it's a CDN error.
    const contentType = (response.headers.get("content-type") || "")
        .toLowerCase();
    const isTextContent = contentType.includes("json") ||
        contentType.includes("html") ||
        contentType.includes("text");

    if (!isTextContent) {
        return false;
    }

    // 403/429 on API responses — almost always indicates a bot block
    if (response.status === 403 || response.status === 429) {
        try {
            const cloned = response.clone();
            const reader = cloned.body?.getReader();
            if (reader) {
                const { value } = await reader.read();
                reader.releaseLock();
                if (value) {
                    const text = new TextDecoder().decode(value.slice(0, 8192))
                        .toLowerCase();
                    if (YOUTUBE_BLOCK_SIGNALS.some((s) => text.includes(s))) {
                        return true;
                    }
                }
            }
        } catch {
            // Can't read body — fall back to status-based detection
        }
        return true;
    }

    // YouTube also returns 200 OK with block messages in JSON API responses
    // (especially for Innertube API calls that return playabilityStatus errors).
    // This is the case for the "This helps protect our community" message.
    if (response.status === 200) {
        try {
            const cloned = response.clone();
            const reader = cloned.body?.getReader();
            if (reader) {
                const { value } = await reader.read();
                reader.releaseLock();
                if (value) {
                    const text = new TextDecoder().decode(value.slice(0, 8192))
                        .toLowerCase();
                    if (YOUTUBE_BLOCK_SIGNALS.some((s) => text.includes(s))) {
                        return true;
                    }
                }
            }
        } catch {
            // Can't read body — assume not blocked
        }
    }

    return false;
}

function fetchShim(
    config: Config,
    retryOptions: RetryOptions,
    input: FetchInputParameter,
    init?: FetchInitParameterWithClient,
): FetchReturn {
    const fetchTimeout = config.networking.fetch?.timeout_ms;
    const fetchRetry = config.networking.fetch?.retry?.enabled;
    let attempt = 0;
    const callFetch = () => {
        // Every invocation after the first is a retry.
        if (attempt++ > 0) metricsRef?.upstreamRetries.inc();
        const doFetch = () =>
            fetch(input, {
                signal: fetchTimeout
                    ? AbortSignal.timeout(Number(fetchTimeout))
                    : null,
                ...(init || {}),
            });
        return fetchGate ? fetchGate.run(doFetch) : doFetch();
    };
    return fetchRetry ? retry(callFetch, retryOptions) : callFetch();
}

/**
 * Best-effort outbound rate limiter. Caps the number of concurrent in-flight
 * requests and optionally enforces a minimum spacing between request starts.
 * Shared process-wide; combined with the failover-only proxy pool this
 * throttles how hard the single active egress IP is hit.
 */
class FetchGate {
    private active = 0;
    private readonly waiters: Array<() => void> = [];
    private nextStart = 0;

    constructor(
        private readonly maxConcurrent: number,
        private readonly minIntervalMs: number,
    ) {}

    async run<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }

    private async acquire(): Promise<void> {
        if (this.active >= this.maxConcurrent) {
            await new Promise<void>((resolve) => this.waiters.push(resolve));
        }
        this.active++;
        if (this.minIntervalMs > 0) {
            const now = Date.now();
            const startAt = Math.max(now, this.nextStart);
            this.nextStart = startAt + this.minIntervalMs;
            const wait = startAt - now;
            if (wait > 0) {
                await new Promise((resolve) => setTimeout(resolve, wait));
            }
        }
    }

    private release(): void {
        this.active--;
        const next = this.waiters.shift();
        if (next) next();
    }
}

/**
 * Mask credentials in proxy URLs for safe logging.
 * http://user:pass@1.2.3.4:8080 → http://1.2.3.4:8080
 */
function maskProxyUrl(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.username || parsed.password) {
            return `${parsed.protocol}//${parsed.host}`;
        }
        return url;
    } catch {
        return url;
    }
}
