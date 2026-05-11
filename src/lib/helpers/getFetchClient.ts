import { retry, type RetryOptions } from "@std/async";
import type { Config } from "./config.ts";
import { generateRandomIPv6 } from "./ipv6Rotation.ts";

type FetchInputParameter = Parameters<typeof fetch>[0];
type FetchInitParameterWithClient =
    | RequestInit
    | RequestInit & { client: Deno.HttpClient };
type FetchReturn = ReturnType<typeof fetch>;
type FetchFn = (
    input: FetchInputParameter,
    init?: FetchInitParameterWithClient,
) => FetchReturn;

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

export const getFetchClient = (config: Config): FetchFn => {
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

    const proxyPool = config.networking.proxy_pool;
    if (proxyPool?.enabled && proxyPool.proxies.length > 0) {
        const proxyClients = new Map<string, Deno.HttpClient>();
        const allProxyUrls = [...proxyPool.proxies]; // permanent list for recovery
        const healthyProxies = new Set(proxyPool.proxies);
        const failureCounts = new Map<string, number>();
        const lastBlacklistTime = new Map<string, number>();
        const FAILURE_THRESHOLD = 3;
        const BLACKLIST_MS = 3_600_000; // 1 hour

        for (const proxyUrl of proxyPool.proxies) {
            try {
                proxyClients.set(
                    proxyUrl,
                    Deno.createHttpClient({ proxy: { url: proxyUrl } }),
                );
            } catch (e) {
                console.warn(
                    `[WARN] Failed to init proxy: ${proxyUrl}\n[ERROR] ${e}`,
                );
                healthyProxies.delete(proxyUrl);
            }
        }

        let rrIndex = 0;

        const recoverProxies = (): void => {
            // ALWAYS check blacklisted proxies for cooldown expiry.
            // Previously this only ran when healthyProxies.size === 0,
            // meaning individual proxies never recovered until the entire pool was dead.
            const now = Date.now();
            for (const proxyUrl of allProxyUrls) {
                if (healthyProxies.has(proxyUrl)) continue;
                const lastBlacklist = lastBlacklistTime.get(proxyUrl) || 0;
                if (now - lastBlacklist > BLACKLIST_MS) {
                    console.log(
                        `[RECOVER] Proxy recovered after cooldown: ${proxyUrl}`,
                    );
                    healthyProxies.add(proxyUrl);
                    failureCounts.set(proxyUrl, 0);
                }
            }
        };

        const getNextProxy = (): string | null => {
            // Always attempt recovery before selecting a proxy
            recoverProxies();
            if (healthyProxies.size === 0) return null;
            const candidates = Array.from(healthyProxies);
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

        const markProxyFailure = (proxyUrl: string) => {
            if (!proxyPool.health_check) return;
            const count = (failureCounts.get(proxyUrl) || 0) + 1;
            failureCounts.set(proxyUrl, count);

            if (count >= FAILURE_THRESHOLD) {
                console.warn(
                    `[BLACKLIST] Proxy blacklisted for 1h: ${proxyUrl} (after ${count} failures)`,
                );
                healthyProxies.delete(proxyUrl);
                lastBlacklistTime.set(proxyUrl, Date.now());
            }
        };

        const markProxySuccess = (proxyUrl: string) => {
            failureCounts.set(proxyUrl, 0);
        };

        const fn: FetchFn = async (
            input: FetchInputParameter,
            init?: FetchInitParameterWithClient,
        ) => {
            const proxyUrl = getNextProxy();
            if (!proxyUrl) {
                // All proxies blacklisted and none recovered — fail explicitly
                throw new Error(
                    "All proxies in the pool are blacklisted. No healthy proxy available.",
                );
            }
            const client = proxyClients.get(proxyUrl)!;

            try {
                const fetchRes = await fetchShim(config, retryOptions, input, {
                    client,
                    headers: init?.headers,
                    method: init?.method,
                    body: init?.body,
                });

                const isBlocked = await checkYouTubeBlock(fetchRes);

                if (isBlocked) {
                    markProxyFailure(proxyUrl);
                } else {
                    markProxySuccess(proxyUrl);
                }

                return fetchRes;
            } catch (e) {
                markProxyFailure(proxyUrl);
                throw e;
            }
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
                    } catch {
                        ipv6Enabled = false;
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
                console.warn(
                    `[WARN] YouTube block detected via single-proxy/direct path for ${input}. ` +
                        "Consider enabling proxy_pool for automatic failover.",
                );
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
 * Works on both 403/429 responses AND 200 responses that contain
 * "protect our community" or similar block messages in the body.
 *
 * Uses response.clone() to peek at the body without consuming the original,
 * so the caller can still read the response stream normally.
 *
 * Returns true if a block signal is detected, false otherwise.
 */
async function checkYouTubeBlock(response: Response): Promise<boolean> {
    // Fast path: 403/429 status codes almost always indicate blocks
    if (response.status === 403 || response.status === 429) {
        // Additionally check the body for known YouTube block signals.
        // YouTube sometimes returns 403 with an HTML page containing
        // "protect our community" instead of a proper API error.
        try {
            const cloned = response.clone();
            const bodyText = await cloned.text();
            const lowerBody = bodyText.slice(0, 60000).toLowerCase();
            if (YOUTUBE_BLOCK_SIGNALS.some((s) => lowerBody.includes(s))) {
                return true;
            }
        } catch {
            // Can't read body — fall back to status-based detection
        }
        return true;
    }

    // YouTube also returns 200 OK with block messages in the response body
    // (especially for Innertube API calls that return playabilityStatus errors).
    // This is the case for the "This helps protect our community" message.
    if (response.status === 200) {
        try {
            const cloned = response.clone();
            const bodyText = await cloned.text();
            const lowerBody = bodyText.slice(0, 60000).toLowerCase();
            if (YOUTUBE_BLOCK_SIGNALS.some((s) => lowerBody.includes(s))) {
                return true;
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
    const callFetch = () =>
        fetch(input, {
            signal: fetchTimeout
                ? AbortSignal.timeout(Number(fetchTimeout))
                : null,
            ...(init || {}),
        });
    return fetchRetry ? retry(callFetch, retryOptions) : callFetch();
}
