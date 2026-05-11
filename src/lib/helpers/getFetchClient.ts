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

// Known YouTube block / bot detection signals (expanded for better detection)
const YOUTUBE_BLOCK_SIGNALS = [
    "unusual traffic",
    "protect our community",
    "please sign in to confirm you're not a bot",
    "captcha",
    "sorry",
    "we're sorry",
    "something went wrong",
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
        const failureTimes = new Map<string, number>();
        const COOLDOWN_MS = 300_000;

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
            for (let i = 0; i < candidates.length; i++) {
                const idx = (rrIndex + i) % candidates.length;
                const p = candidates[idx];
                const lastFail = failureTimes.get(p) || 0;
                if (Date.now() - lastFail > COOLDOWN_MS) {
                    rrIndex = (idx + 1) % candidates.length;
                    return p;
                }
            }
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

                // === IMPROVED BLOCK DETECTION ===
                let isBlocked = fetchRes.status === 403 || fetchRes.status === 429;

                // Check body even on 200 responses (YouTube often returns 200 + block page)
                if (fetchRes.body) {
                    const reader = fetchRes.body.getReader();
                    const { value } = await reader.read();

                    if (value) {
                        const text = new TextDecoder().decode(value.slice(0, 80000)).toLowerCase();

                        if (YOUTUBE_BLOCK_SIGNALS.some(signal => text.includes(signal))) {
                            isBlocked = true;
                        }
                    }
                }

                if (isBlocked) {
                    markProxyFailure(proxyUrl);
                    console.warn(`[WARN] Proxy blocked by YouTube (${proxyUrl}). Rotating...`);
                }

                return new Response(fetchRes.body, {
                    status: fetchRes.status,
                    headers: fetchRes.headers,
                });
            } catch (e) {
                markProxyFailure(proxyUrl);
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
                    } catch {}
                }
                throw e;
            }
        };
    }

    // Single proxy / IPv6 path (unchanged for compatibility)
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
                        clientOptions.localAddress = generateRandomIPv6(ipv6Block);
                    } catch (err) {
                        console.warn(`[WARN] Failed to generate IPv6. Disabling rotation.`);
                        ipv6Enabled = false;
                    }
                }

                try {
                    client = Deno.createHttpClient(clientOptions);
                } catch (err: unknown) {
                    if (clientOptions.localAddress && err?.toString().includes("Cannot assign requested address")) {
                        console.warn("[WARN] IPv6 bind failed. Disabling rotation.");
                        ipv6Enabled = false;
                        delete clientOptions.localAddress;
                        client = Deno.createHttpClient(clientOptions);
                    } else {
                        throw err;
                    }
                }
            }

            const fetchRes = await fetchShim(config, retryOptions, input, { client, ...init });

            if (reusableClient) {
                return new Response(fetchRes.body, {
                    status: fetchRes.status,
                    headers: fetchRes.headers,
                });
            }

            const originalBody = fetchRes.body;
            if (!originalBody) {
                client.close();
                return new Response(null, { status: fetchRes.status, headers: fetchRes.headers });
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

    const callFetch = () => fetch(input, {
        signal: fetchTimeout ? AbortSignal.timeout(Number(fetchTimeout)) : null,
        ...(init || {}),
    });

    return fetchRetry ? retry(callFetch, retryOptions) : callFetch();
}
