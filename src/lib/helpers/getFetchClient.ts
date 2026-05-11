import { retry, type RetryOptions } from "@std/async";
import type { Config } from "./config.ts";
import { generateRandomIPv6 } from "./ipv6Rotation.ts";

type FetchInputParameter = Parameters<typeof fetch>[0];
type FetchInitParameterWithClient =
    | RequestInit
    | RequestInit & { client: Deno.HttpClient };
type FetchReturn = ReturnType<typeof fetch>;

// Module-level flag to permanently disable IPv6 rotation if it ever fails
let ipv6Enabled = true;

// Known YouTube block signals (lightweight check for faster failover)
const YOUTUBE_BLOCK_PHRASES = [
    "unusual traffic",
    "protect our community",
    "please sign in to confirm you're not a bot",
    "captcha",
    "sorry",
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

    // NEW: Multi-proxy pool support (highest priority for failover when YouTube blocks a proxy)
    // Performance-first design: 
    // - Pre-create ALL HttpClients at startup (zero per-request creation cost)
    // - O(1) average selection for round-robin/random
    // - Passive health checks with 5min cooldown (no active pings, max speed)
    // - Auto-swap on 403/429 or errors with 1 fast retry
    const proxyPool = config.networking.proxy_pool;
    if (proxyPool?.enabled && proxyPool.proxies.length > 0) {
        const proxyClients = new Map<string, Deno.HttpClient>();
        const healthyProxies = new Set(proxyPool.proxies);
        const failureTimes = new Map<string, number>(); // last failure timestamp
        const COOLDOWN_MS = 300_000; // 5 minutes - balances recovery speed vs stability

        for (const proxyUrl of proxyPool.proxies) {
            try {
                proxyClients.set(
                    proxyUrl,
                    Deno.createHttpClient({ proxy: { url: proxyUrl } }),
                );
            } catch (e) {
                console.warn(`[WARN] Failed to init proxy client for ${proxyUrl}: ${e}`);
                healthyProxies.delete(proxyUrl);
            }
        }

        let rrIndex = 0;

        const getNextProxy = (): string | null => {
            if (healthyProxies.size === 0) return null;
            const candidates = Array.from(healthyProxies);
            if (proxyPool.rotation === "random") {
                return candidates[Math.floor(Math.random() * candidates.length)];
            }
            // Round-robin preferring healthy (skip in-cooldown)
            for (let i = 0; i < candidates.length; i++) {
                const idx = (rrIndex + i) % candidates.length;
                const p = candidates[idx];
                const lastFail = failureTimes.get(p) || 0;
                if (Date.now() - lastFail > COOLDOWN_MS) {
                    rrIndex = (idx + 1) % candidates.length;
                    return p;
                }
            }
            // Fallback: use next even if cooling
            rrIndex = (rrIndex + 1) % candidates.length;
            return candidates[0];
        };

        const markProxyFailure = (proxyUrl: string) => {
            if (proxyPool.health_check) {
                failureTimes.set(proxyUrl, Date.now());
            }
        };

        return async (input: FetchInputParameter, init?: RequestInit) => {
            const proxyUrl = getNextProxy() || proxyPool.proxies[0];
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

                // Fast block detection (status + lightweight body check for YouTube-specific signals)
                let isBlocked = fetchRes.status === 403 || fetchRes.status === 429;
                if (!isBlocked && fetchRes.body) {
                    // Only peek at small prefix for perf (non-destructive)
                    const reader = fetchRes.body.getReader();
                    const { value } = await reader.read();
                    if (value) {
                        const text = new TextDecoder().decode(value.slice(0, 50000)).toLowerCase();
                        if (YOUTUBE_BLOCK_PHRASES.some(phrase => text.includes(phrase))) {
                            isBlocked = true;
                        }
                    }
                    // Note: We don't reconstruct the body here for performance.
                    // Most blocks are caught by status code. Body peek is best-effort.
                }

                if (isBlocked) {
                    markProxyFailure(proxyUrl);
                }

                // Direct response for reusable clients - minimal overhead
                return new Response(fetchRes.body, {
                    status: fetchRes.status,
                    headers: fetchRes.headers,
                });
            } catch (e) {
                markProxyFailure(proxyUrl);
                // Lightning fast failover (1 retry max to preserve perf)
                const nextProxy = getNextProxy();
                if (nextProxy && nextProxy !== proxyUrl && proxyClients.has(nextProxy)) {
                    const nextClient = proxyClients.get(nextProxy)!;
                    try {
                        const retryRes = await fetchShim(
                            config,
                            retryOptions,
                            input,
                            {
                                client: nextClient,
                                headers: init?.headers,
                                method: init?.method,
                                body: init?.body,
                            },
                        );
                        return new Response(retryRes.body, {
                            status: retryRes.status,
                            headers: retryRes.headers,
                        });
                    } catch {
                        // swallow, original error will propagate
                    }
                }
                throw e;
            }
        };
    }

    if (proxyAddress || (ipv6Block && ipv6Enabled)) {
        const reusableClient = proxyAddress && !ipv6Block
            ? Deno.createHttpClient({ proxy: { url: proxyAddress } })
            : undefined;

        return async (
            input: FetchInputParameter,
            init?: RequestInit,
        ) => {
            let client: Deno.HttpClient;

            if (reusableClient) {
                client = reusableClient;
            } else {
                const clientOptions: Deno.CreateHttpClientOptions = {};
                if (proxyAddress) {
                    clientOptions.proxy = { url: proxyAddress };
                }

                if (ipv6Block && ipv6Enabled) {
                    try {
                        clientOptions.localAddress = generateRandomIPv6(
                            ipv6Block,
                        );
                    } catch (err) {
                        console.warn(
                            `[WARN] Failed to generate IPv6 from block ${ipv6Block}. Disabling IPv6 rotation permanently.\n[ERROR] ${err}`,
                        );
                        ipv6Enabled = false;
                    }
                }

                try {
                    client = Deno.createHttpClient(clientOptions);
                } catch (err: unknown) {
                    if (
                        clientOptions.localAddress &&
                        (err?.toString().includes(
                            "Cannot assign requested address",
                        ))
                    ) {
                        console.warn(
                            "[WARN] IPv6 bind failed (address not available on this host). Disabling IPv6 rotation permanently.\n[ERROR] ${err}`,",
                        );
                        ipv6Enabled = false;
                        delete clientOptions.localAddress;
                        client = Deno.createHttpClient(clientOptions);
                    } else {
                        throw err;
                    }
                }
            }

            const fetchRes = await fetchShim(config, retryOptions, input, {
                client,
                headers: init?.headers,
                method: init?.method,
                body: init?.body,
            });

            if (reusableClient) {
                return new Response(fetchRes.body, {
                    status: fetchRes.status,
                    headers: fetchRes.headers,
                });
            }

            const originalBody = fetchRes.body;
            if (!originalBody) {
                client.close();
                return new Response(null, {
                    status: fetchRes.status,
                    headers: fetchRes.headers,
                });
            }

            const reader = originalBody.getReader();
            const wrappedBody = new ReadableStream({
                async pull(controller) {
                    const { done, value } = await reader.read();
                    if (done) {
                        controller.close();
                        client.close();
                        return;
                    }
                    controller.enqueue(value);
                },
                cancel() {
                    reader.cancel();
                    client.close();
                },
            });

            return new Response(wrappedBody, {
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
