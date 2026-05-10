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
                        console.warn(`[WARN] Failed to generate IPv6 from block ${ipv6Block}. Disabling IPv6 rotation permanently.`);
                        ipv6Enabled = false;
                    }
                }

                try {
                    client = Deno.createHttpClient(clientOptions);
                } catch (err: any) {
                    if (clientOptions.localAddress && (err.message?.includes("Cannot assign requested address") || err.code === 99)) {
                        console.warn("[WARN] IPv6 bind failed (address not available on this host). Disabling IPv6 rotation permanently.");
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
