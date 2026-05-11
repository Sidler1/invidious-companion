import { retry, type RetryOptions } from "@std/async";
import type { Config } from "./config.ts";
import { generateRandomIPv6 } from "./ipv6Rotation.ts";

type FetchInputParameter = Parameters<typeof fetch>[0];
type FetchInitParameterWithClient =
    | RequestInit
    | RequestInit & { client: Deno.HttpClient };
type FetchReturn = ReturnType<typeof fetch>;

let ipv6Enabled = true;

const YOUTUBE_BLOCK_SIGNALS = [
    "unusual traffic",
    "protect our community",
    "please sign in to confirm you're not a bot",
    "captcha",
];

export const getFetchClient = (config: Config): {
    (
        input: FetchInputParameter,
        init?: FetchInitParameterWithClient,
    ): FetchReturn;
} => {
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

        const getNextProxy = (): string | null => {
            if (healthyProxies.size === 0) return null;
            const candidates = Array.from(healthyProxies);
            if (proxyPool.rotation === "random") {
                return candidates[
                    Math.floor(Math.random() * candidates.length)
                ];
            }
            for (let i = 0; i < candidates.length; i++) {
                const idx = (rrIndex + i) % candidates.length;
                const p = candidates[idx];
                const lastBlacklist = lastBlacklistTime.get(p) || 0;
                if (Date.now() - lastBlacklist > BLACKLIST_MS) {
                    rrIndex = (idx + 1) % candidates.length;
                    return p;
                }
            }
            return candidates[0];
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

        return async (input: FetchInputParameter, init?: RequestInit) => {
            const proxyUrl = getNextProxy() || proxyPool.proxies[0];
            const client = proxyClients.get(proxyUrl)!;

            try {
                const fetchRes = await fetchShim(config, retryOptions, input, {
                    client,
                    headers: init?.headers,
                    method: init?.method,
                    body: init?.body,
                });

                let isBlocked = fetchRes.status === 403 ||
                    fetchRes.status === 429;

                // Only check body on non-200 responses (more conservative)
                if (isBlocked && fetchRes.body) {
                    const reader = fetchRes.body.getReader();
                    const { value } = await reader.read();
                    if (value) {
                        const text = new TextDecoder().decode(
                            value.slice(0, 60000),
                        ).toLowerCase();
                        if (
                            YOUTUBE_BLOCK_SIGNALS.some((s) => text.includes(s))
                        ) {
                            isBlocked = true;
                        }
                    }
                }

                if (isBlocked) {
                    markProxyFailure(proxyUrl);
                } else {
                    markProxySuccess(proxyUrl);
                }

                return new Response(fetchRes.body, {
                    status: fetchRes.status,
                    headers: fetchRes.headers,
                });
            } catch (e) {
                markProxyFailure(proxyUrl);
                throw e;
            }
        };
    }

    // Single proxy / IPv6 path (unchanged)
    if (proxyAddress || (ipv6Block && ipv6Enabled)) {
        const reusableClient = proxyAddress && !ipv6Block
            ? Deno.createHttpClient({ proxy: { url: proxyAddress } })
            : undefined;

        return async (input: FetchInputParameter, init?: RequestInit) => {
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
            return new Response(fetchRes.body, {
                status: fetchRes.status,
                headers: fetchRes.headers,
            });
        };
    }

    return (input: FetchInputParameter, init?: FetchInitParameterWithClient) =>
        fetchShim(config, retryOptions, input, init);
};

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
