import { assertEquals } from "./deps.ts";
import { withEnv } from "./helpers/env.ts";

Deno.test({
    name:
        "proxy pool revalidation - concurrent requests share one probe per cooled-down proxy",
    fn: async () => {
        const originalFetch = globalThis.fetch;
        const originalCreateHttpClient = Deno.createHttpClient;
        const originalDateNow = Date.now;
        let now = 1_000_000;
        let createdClients = 0;
        const probesByClient = new Map<number, number>();
        let requestCount = 0;
        // proxy2 fails its first two health probes so the pool can't pin to
        // it while proxy1 is still being driven to its 3-failure blacklist
        // threshold (ensureActiveProxy sticks to whichever proxy last probed
        // healthy, so proxy2 must stay unhealthy until proxy1 is blacklisted,
        // or the pool would fail over to proxy2 after the first failure and
        // never revisit proxy1 again). The same trick is reused later (reset
        // to 0) to pin proxy3 while it's driven to its own blacklist.
        let proxy2ProbeAttempts = 0;
        // proxy3 fails every probe during the proxy1 setup phase so the
        // pool's round-robin selection (which, with 3 proxies, can land on
        // proxy3 before proxy2) never pins to it prematurely. Flipped on
        // once proxy1 is safely blacklisted and it's proxy3's turn.
        let proxy3ProbeEnabled = false;

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
                if (clientId === 3 && !proxy3ProbeEnabled) {
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
            // Client 1 (proxy1) and client 3 (proxy3) are always blocked so
            // they get blacklisted; client 2 (proxy2) always works once it's
            // selected.
            if (clientId === 1 || clientId === 3) {
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
            await withEnv(
                { SERVER_SECRET_KEY: "aaaaaaaaaaaaaaaa" },
                async () => {
                    const { getFetchClient, rotateSessionEgressProxy } =
                        await import("../lib/helpers/getFetchClient.ts");
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
                                proxies: [
                                    "http://u:p@proxy1:8080",
                                    "http://u:p@proxy2:8080",
                                    "http://u:p@proxy3:8080",
                                ],
                            },
                        },
                    };
                    const fetchClient = getFetchClient(testConfig);

                    // Three blocked responses on proxy1 blacklist it. proxy2 stays
                    // unavailable via its own failing probes and proxy3 stays
                    // unavailable unconditionally, so every one of these three
                    // requests actually re-contacts proxy1 instead of the pool
                    // sticking to a working alternative.
                    await fetchClient("http://example.com/1");
                    await fetchClient("http://example.com/2");
                    await fetchClient("http://example.com/3");
                    const probesBefore = probesByClient.get(1) || 0;

                    // Blacklist proxy3 too, 20s after proxy1, so its 1-hour cooldown
                    // expires 20s after proxy1's — giving us a second, independently
                    // timed candidate to exercise the throttle against later, without
                    // disturbing the proxy1/proxy2 state above. Re-arm the same
                    // "fail twice, then succeed" gate on proxy2 (now playing the
                    // stand-in role proxy1 played above) and let proxy3's probe
                    // succeed from here on so rotateSessionEgressProxy can pin to it.
                    now = 1_020_000;
                    proxy2ProbeAttempts = 0;
                    proxy3ProbeEnabled = true;
                    await rotateSessionEgressProxy(testConfig);
                    await fetchClient("http://example.com/p3-1");
                    await fetchClient("http://example.com/p3-2");
                    await fetchClient("http://example.com/p3-3");

                    // proxy1's cooldown expires (proxy3's does not yet: it was
                    // blacklisted 20s later). Five concurrent requests arrive at
                    // once; only proxy1 is a revalidation candidate.
                    now = 1_000_000 + 3_600_001;
                    await Promise.all([
                        fetchClient("http://example.com/a"),
                        fetchClient("http://example.com/b"),
                        fetchClient("http://example.com/c"),
                        fetchClient("http://example.com/d"),
                        fetchClient("http://example.com/e"),
                    ]);

                    // Exactly one cooldown probe for proxy1, not five.
                    assertEquals(
                        (probesByClient.get(1) || 0) - probesBefore,
                        1,
                    );
                    assertEquals(requestCount >= 8, true);

                    // proxy3's cooldown has now expired too (blacklisted at
                    // 1_020_000, +1h = 4_620_000), but we're still inside the 30s
                    // throttle window measured from the batch's revalidation run
                    // above (which ran at now=4_600_001). A request here reaches
                    // ensureActiveProxy -> revalidateCooldownProxies (every
                    // fetchClient call does, unconditionally) and finds proxy3 as a
                    // genuine candidate, yet must perform zero probes because the
                    // throttle skips the run entirely.
                    const probesBeforeSkip = probesByClient.get(3) || 0;
                    now = 4_625_000;
                    await fetchClient("http://example.com/skip-window");
                    assertEquals(
                        (probesByClient.get(3) || 0) - probesBeforeSkip,
                        0,
                    );

                    // Past the 30s throttle window: the next request actually runs
                    // revalidation and probes proxy3 exactly once, recovering it.
                    now = 4_635_000;
                    await fetchClient("http://example.com/after-window");
                    assertEquals(
                        (probesByClient.get(3) || 0) - probesBeforeSkip,
                        1,
                    );
                },
            );
        } finally {
            Date.now = originalDateNow;
            globalThis.fetch = originalFetch;
            Deno.createHttpClient = originalCreateHttpClient;
        }
    },
});
