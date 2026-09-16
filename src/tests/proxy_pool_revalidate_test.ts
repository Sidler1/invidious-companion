import { assertEquals } from "./deps.ts";

Deno.test({
    name:
        "proxy pool revalidation - concurrent requests share one probe per cooled-down proxy",
    fn: async () => {
        const originalFetch = globalThis.fetch;
        const originalCreateHttpClient = Deno.createHttpClient;
        const originalDateNow = Date.now;
        const originalSecret = Deno.env.get("SERVER_SECRET_KEY");
        let now = 1_000_000;
        let createdClients = 0;
        const probesByClient = new Map<number, number>();
        let requestCount = 0;
        // proxy2 fails its first two health probes so the pool can't pin to
        // it while proxy1 is still being driven to its 3-failure blacklist
        // threshold (ensureActiveProxy sticks to whichever proxy last probed
        // healthy, so proxy2 must stay unhealthy until proxy1 is blacklisted,
        // or the pool would fail over to proxy2 after the first failure and
        // never revisit proxy1 again).
        let proxy2ProbeAttempts = 0;

        Date.now = () => now;
        Deno.createHttpClient = (() => {
            createdClients += 1;
            return { __clientId: createdClients } as unknown as Deno.HttpClient;
        }) as typeof Deno.createHttpClient;

        globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            const clientId =
                (init as RequestInit & { client?: { __clientId?: number } })
                    ?.client?.__clientId || 0;
            const url = String(input);
            if (url.includes("generate_204")) {
                probesByClient.set(
                    clientId,
                    (probesByClient.get(clientId) || 0) + 1,
                );
                if (clientId === 2 && proxy2ProbeAttempts < 2) {
                    proxy2ProbeAttempts += 1;
                    return Promise.resolve(
                        new Response("unavailable", { status: 500 }),
                    );
                }
                // Probes are slow so concurrent callers overlap.
                return new Promise((resolve) =>
                    setTimeout(
                        () =>
                            resolve(
                                new Response(JSON.stringify({ status: "OK" }), {
                                    status: 200,
                                    headers: {
                                        "content-type": "application/json",
                                    },
                                }),
                            ),
                        20,
                    )
                );
            }
            requestCount += 1;
            // Client 1 (proxy1) is always blocked so it gets blacklisted;
            // client 2 (proxy2) always works once it's selected.
            if (clientId === 1) {
                return Promise.resolve(
                    new Response(
                        "<html>please sign in to confirm you're not a bot</html>",
                        {
                            status: 403,
                            headers: { "content-type": "text/html" },
                        },
                    ),
                );
            }
            return Promise.resolve(
                new Response(JSON.stringify({ playabilityStatus: "OK" }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
            );
        }) as typeof fetch;

        try {
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
                        proxies: [
                            "http://u:p@proxy1:8080",
                            "http://u:p@proxy2:8080",
                        ],
                    },
                },
            };
            const fetchClient = getFetchClient(testConfig);

            // Three blocked responses on proxy1 blacklist it (proxy2 stays
            // unavailable via its own failing probes until proxy1 crosses the
            // threshold, so every one of these three requests actually
            // re-contacts proxy1 instead of sticking to a working proxy2).
            await fetchClient("http://example.com/1");
            await fetchClient("http://example.com/2");
            await fetchClient("http://example.com/3");
            const probesBefore = probesByClient.get(1) || 0;

            // Cooldown expires; five concurrent requests arrive at once.
            now += 3_600_001;
            await Promise.all([
                fetchClient("http://example.com/a"),
                fetchClient("http://example.com/b"),
                fetchClient("http://example.com/c"),
                fetchClient("http://example.com/d"),
                fetchClient("http://example.com/e"),
            ]);

            // Exactly one cooldown probe for proxy1, not five.
            assertEquals((probesByClient.get(1) || 0) - probesBefore, 1);
            assertEquals(requestCount >= 8, true);
        } finally {
            Date.now = originalDateNow;
            globalThis.fetch = originalFetch;
            Deno.createHttpClient = originalCreateHttpClient;
            if (originalSecret === undefined) {
                Deno.env.delete("SERVER_SECRET_KEY");
            } else {
                Deno.env.set("SERVER_SECRET_KEY", originalSecret);
            }
        }
    },
});
