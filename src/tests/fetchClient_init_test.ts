import { assert, assertEquals } from "./deps.ts";
import { withEnv } from "./helpers/env.ts";

Deno.test({
    name:
        "proxy pool path forwards redirect, streaming and caller signal to fetch",
    fn: async () => {
        const originalFetch = globalThis.fetch;
        const originalCreateHttpClient = Deno.createHttpClient;
        const captured: RequestInit[] = [];

        Deno.createHttpClient = (() => {
            return { __clientId: 1 } as unknown as Deno.HttpClient;
        }) as typeof Deno.createHttpClient;

        globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            if (!String(input).includes("generate_204")) {
                captured.push(init ?? {});
            }
            return Promise.resolve(
                new Response(JSON.stringify({ status: "OK" }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
            );
        }) as typeof fetch;

        try {
            await withEnv(
                { SERVER_SECRET_KEY: "aaaaaaaaaaaaaaaa" },
                async () => {
                    const { getFetchClient } = await import(
                        "../lib/helpers/getFetchClient.ts"
                    );
                    const { parseConfig } = await import(
                        "../lib/helpers/config.ts"
                    );
                    const config = await parseConfig();
                    const testConfig = {
                        ...config,
                        networking: {
                            ...config.networking,
                            proxy_pool: {
                                enabled: true,
                                rotation: "round-robin" as const,
                                health_check: true,
                                switch_proxy_on_limit: false,
                                proxies: ["http://u:p@proxy1:8080"],
                            },
                        },
                    };

                    const fetchClient = getFetchClient(testConfig);
                    const controller = new AbortController();
                    await fetchClient("https://example.com/videoplayback", {
                        method: "GET",
                        redirect: "manual",
                        streaming: true,
                        signal: controller.signal,
                    });

                    assertEquals(captured.length, 1);
                    assertEquals(captured[0].redirect, "manual");
                    // streaming: the caller signal is passed through untouched.
                    assert(captured[0].signal === controller.signal);
                    // Our own flag must never reach the native fetch.
                    assertEquals("streaming" in captured[0], false);
                },
            );
        } finally {
            globalThis.fetch = originalFetch;
            Deno.createHttpClient = originalCreateHttpClient;
        }
    },
});
