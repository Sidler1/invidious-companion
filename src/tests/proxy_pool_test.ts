import { assertEquals, assertExists, assertRejects } from "./deps.ts";

// We test the new proxy_pool config schema and basic behavior

Deno.test("proxy_pool config parsing - disabled by default", () => {
    const defaults = {
        enabled: false,
        rotation: "round-robin",
        health_check: true,
        proxies: [],
    };
    assertEquals(defaults.enabled, false);
});

Deno.test("proxy_pool config parsing - enabled with proxies", () => {
    const raw = {
        networking: {
            proxy_pool: {
                enabled: true,
                rotation: "round-robin",
                health_check: true,
                proxies: [
                    "http://user:pass@proxy1:8080",
                    "http://user:pass@proxy2:8080",
                ],
            },
        },
    };

    assertEquals(raw.networking.proxy_pool.enabled, true);
    assertEquals(raw.networking.proxy_pool.rotation, "round-robin");
    assertEquals(raw.networking.proxy_pool.proxies.length, 2);
});

Deno.test({
    name: "getFetchClient with proxy_pool - basic creation (no real network)",
    fn: async () => {
        Deno.env.set("SERVER_SECRET_KEY", "aaaaaaaaaaaaaaaa");
        const { getFetchClient } = await import(
            "../lib/helpers/getFetchClient.ts"
        );
        const { parseConfig } = await import("../lib/helpers/config.ts");

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
                    proxies: ["http://user:pass@127.0.0.1:1"],
                },
            },
        };

        const fetchClient = getFetchClient(testConfig);
        assertExists(fetchClient);
    },
    sanitizeResources: false, // HttpClients are created internally and not closed in this unit test
});

Deno.test({
    name:
        "getFetchClient with proxy_pool - keeps using one healthy proxy across calls",
    fn: async () => {
        const originalFetch = globalThis.fetch;
        const originalCreateHttpClient = Deno.createHttpClient;
        let createdClients = 0;
        const usedClientIds: number[] = [];

        Deno.createHttpClient = (() => {
            createdClients += 1;
            return { __clientId: createdClients } as unknown as Deno.HttpClient;
        }) as typeof Deno.createHttpClient;

        globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            const clientId =
                (init as RequestInit & { client?: { __clientId?: number } })
                    ?.client?.__clientId;
            usedClientIds.push(clientId || 0);
            const url = String(input);

            if (url.includes("generate_204")) {
                return Promise.resolve(
                    new Response(
                        JSON.stringify({ status: "OK" }),
                        {
                            status: 200,
                            headers: { "content-type": "application/json" },
                        },
                    ),
                );
            }

            return Promise.resolve(
                new Response(
                    JSON.stringify({ playabilityStatus: { status: "OK" } }),
                    {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    },
                ),
            );
        }) as typeof fetch;

        try {
            const { getFetchClient } = await import(
                "../lib/helpers/getFetchClient.ts"
            );
            const { parseConfig } = await import("../lib/helpers/config.ts");
            Deno.env.set("SERVER_SECRET_KEY", "aaaaaaaaaaaaaaaa");

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
                        proxies: [
                            "http://u:p@proxy1:8080",
                            "http://u:p@proxy2:8080",
                        ],
                    },
                },
            };

            const fetchClient = getFetchClient(testConfig);
            const result1 = await fetchClient("http://example.com/a");
            const result2 = await fetchClient("http://example.com/b");

            assertEquals(result1.status, 200);
            assertEquals(result2.status, 200);
            assertEquals(usedClientIds, [1, 1, 1]);
        } finally {
            globalThis.fetch = originalFetch;
            Deno.createHttpClient = originalCreateHttpClient;
        }
    },
});

Deno.test({
    name:
        "getFetchClient with proxy_pool - fails over to another proxy within the same request when a block is detected",
    fn: async () => {
        const originalFetch = globalThis.fetch;
        const originalCreateHttpClient = Deno.createHttpClient;
        let createdClients = 0;
        const requestCountsByClient = new Map<number, number>();
        const usedClientIds: number[] = [];
        const requestClientIds: number[] = [];

        Deno.createHttpClient = (() => {
            createdClients += 1;
            return { __clientId: createdClients } as unknown as Deno.HttpClient;
        }) as typeof Deno.createHttpClient;

        globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            const clientId =
                (init as RequestInit & { client?: { __clientId?: number } })
                    ?.client?.__clientId || 0;
            usedClientIds.push(clientId);
            const url = String(input);

            if (url.includes("generate_204")) {
                return Promise.resolve(
                    new Response(
                        JSON.stringify({ status: "OK" }),
                        {
                            status: 200,
                            headers: { "content-type": "application/json" },
                        },
                    ),
                );
            }

            const currentCount = (requestCountsByClient.get(clientId) || 0) + 1;
            requestCountsByClient.set(clientId, currentCount);
            requestClientIds.push(clientId);

            if (clientId === 1 && currentCount <= 3) {
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            playabilityStatus: {
                                status: "LOGIN_REQUIRED",
                                reason: "Sign in to confirm you're not a bot",
                                subreason: "This helps protect our community.",
                            },
                        }),
                        {
                            status: 200,
                            headers: { "content-type": "application/json" },
                        },
                    ),
                );
            }

            return Promise.resolve(
                new Response(
                    JSON.stringify({ playabilityStatus: { status: "OK" } }),
                    {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    },
                ),
            );
        }) as typeof fetch;

        try {
            const { getFetchClient } = await import(
                "../lib/helpers/getFetchClient.ts"
            );
            const { parseConfig } = await import("../lib/helpers/config.ts");
            Deno.env.set("SERVER_SECRET_KEY", "aaaaaaaaaaaaaaaa");

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
                        proxies: [
                            "http://u:p@proxy1:8080",
                            "http://u:p@proxy2:8080",
                        ],
                    },
                },
            };

            const fetchClient = getFetchClient(testConfig);
            await fetchClient("http://example.com/1");
            await fetchClient("http://example.com/2");
            await fetchClient("http://example.com/3");
            const result = await fetchClient("http://example.com/4");
            const body = await result.text();

            assertEquals(result.status, 200);
            assertEquals(body.includes('"status":"OK"'), true);
            // proxy1 returns a bot-block on its first request, so the request
            // fails over to proxy2 in-flight (rather than returning the block).
            // proxy2 then becomes the sticky active proxy for the rest.
            assertEquals(requestClientIds, [1, 2, 2, 2, 2]);
            assertEquals(usedClientIds.includes(2), true);
        } finally {
            globalThis.fetch = originalFetch;
            Deno.createHttpClient = originalCreateHttpClient;
        }
    },
});

Deno.test({
    name:
        "getFetchClient with proxy_pool - cooldown expiry triggers probe and failed proxy is blacklisted again",
    fn: async () => {
        const originalFetch = globalThis.fetch;
        const originalCreateHttpClient = Deno.createHttpClient;
        const originalDateNow = Date.now;
        let createdClients = 0;
        let now = 1_700_000_000_000;
        let probeCount = 0;
        let requestCount = 0;

        Date.now = () => now;

        Deno.createHttpClient = (() => {
            createdClients += 1;
            return { __clientId: createdClients } as unknown as Deno.HttpClient;
        }) as typeof Deno.createHttpClient;

        globalThis.fetch = ((input: RequestInfo | URL) => {
            const url = String(input);

            if (url.includes("generate_204")) {
                probeCount += 1;
                if (now < 1_700_000_000_000 + 3_600_001) {
                    return Promise.resolve(
                        new Response(
                            JSON.stringify({ status: "OK" }),
                            {
                                status: 200,
                                headers: { "content-type": "application/json" },
                            },
                        ),
                    );
                }
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            playabilityStatus: {
                                status: "LOGIN_REQUIRED",
                                reason: "Sign in to confirm you're not a bot",
                                subreason: "This helps protect our community.",
                            },
                        }),
                        {
                            status: 200,
                            headers: { "content-type": "application/json" },
                        },
                    ),
                );
            }

            requestCount += 1;
            return Promise.resolve(
                new Response(
                    JSON.stringify({
                        playabilityStatus: {
                            status: "LOGIN_REQUIRED",
                            reason: "Sign in to confirm you're not a bot",
                            subreason: "This helps protect our community.",
                        },
                    }),
                    {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    },
                ),
            );
        }) as typeof fetch;

        try {
            const { getFetchClient } = await import(
                "../lib/helpers/getFetchClient.ts"
            );
            const { parseConfig } = await import("../lib/helpers/config.ts");
            Deno.env.set("SERVER_SECRET_KEY", "aaaaaaaaaaaaaaaa");

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

            await fetchClient("http://example.com/1");
            await fetchClient("http://example.com/2");
            await fetchClient("http://example.com/3");

            now += 3_600_001;

            await assertRejects(
                () => fetchClient("http://example.com/4"),
                Error,
                "No healthy proxy available",
            );

            assertEquals(requestCount, 3);
            assertEquals(probeCount >= 2, true);
        } finally {
            Date.now = originalDateNow;
            globalThis.fetch = originalFetch;
            Deno.createHttpClient = originalCreateHttpClient;
        }
    },
});

Deno.test({
    name:
        "rotateSessionEgressProxy - advances the pinned egress proxy to a different one",
    fn: async () => {
        const originalFetch = globalThis.fetch;
        const originalCreateHttpClient = Deno.createHttpClient;

        Deno.createHttpClient = (() => {
            return {} as unknown as Deno.HttpClient;
        }) as typeof Deno.createHttpClient;

        // Every probe (generate_204) reports healthy, so both proxies stay in
        // rotation and the rotator must move off the pinned one by exclusion.
        globalThis.fetch = (() => {
            return Promise.resolve(
                new Response(JSON.stringify({ status: "OK" }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
            );
        }) as typeof fetch;

        try {
            const { getSessionEgressProxy, rotateSessionEgressProxy } =
                await import("../lib/helpers/getFetchClient.ts");
            const { parseConfig } = await import("../lib/helpers/config.ts");
            Deno.env.set("SERVER_SECRET_KEY", "aaaaaaaaaaaaaaaa");

            const config = await parseConfig();
            const proxies = [
                "http://u:p@proxy-a:8080",
                "http://u:p@proxy-b:8080",
            ];
            const testConfig = {
                ...config,
                networking: {
                    ...config.networking,
                    proxy_pool: {
                        enabled: true,
                        rotation: "round-robin" as const,
                        health_check: true,
                        switch_proxy_on_limit: false,
                        proxies,
                    },
                },
            };

            const first = await getSessionEgressProxy(testConfig);
            const second = await rotateSessionEgressProxy(testConfig);

            assertExists(first);
            assertExists(second);
            assertEquals(proxies.includes(first!), true);
            assertEquals(proxies.includes(second!), true);
            // The whole point of rotation: land on a different egress IP.
            assertEquals(first === second, false);
        } finally {
            globalThis.fetch = originalFetch;
            Deno.createHttpClient = originalCreateHttpClient;
        }
    },
    sanitizeResources: false,
});
