import { assertEquals } from "./deps.ts";

/**
 * Drive checkYouTubeBlock through the direct fetch path: no proxy, no pool,
 * so getFetchClient calls globalThis.fetch and, on a detected block, fires
 * the onYouTubeBlock hook. Counting hook calls is the observable.
 */
async function blockDetected(response: Response): Promise<boolean> {
    const originalFetch = globalThis.fetch;
    const originalSecret = Deno.env.get("SERVER_SECRET_KEY");
    let hookCalls = 0;
    try {
        Deno.env.set("SERVER_SECRET_KEY", "aaaaaaaaaaaaaaaa");
        const { getFetchClient, setOnYouTubeBlock } = await import(
            "../lib/helpers/getFetchClient.ts"
        );
        const { parseConfig } = await import("../lib/helpers/config.ts");
        // Fresh object so the singleton is rebuilt; a single proxy URL
        // selects the single-proxy path (the only non-pool path that runs
        // checkYouTubeBlock). No connection is made: fetch is mocked.
        const base = await parseConfig();
        const config = {
            ...base,
            networking: {
                ...base.networking,
                proxy: "http://u:p@127.0.0.1:1",
                ipv6_block: null,
                proxy_pool: { ...base.networking.proxy_pool, enabled: false },
            },
        };
        globalThis.fetch = (() => Promise.resolve(response)) as typeof fetch;
        setOnYouTubeBlock(() => {
            hookCalls += 1;
        });

        const fetchClient = getFetchClient(config);
        const res = await fetchClient(
            "https://www.youtube.com/youtubei/v1/player",
        );
        await res.body?.cancel().catch(() => {});
        return hookCalls > 0;
    } finally {
        globalThis.fetch = originalFetch;
        const { setOnYouTubeBlock } = await import(
            "../lib/helpers/getFetchClient.ts"
        );
        setOnYouTubeBlock(() => {});
        if (originalSecret === undefined) {
            Deno.env.delete("SERVER_SECRET_KEY");
        } else {
            Deno.env.set("SERVER_SECRET_KEY", originalSecret);
        }
    }
}

Deno.test({
    name: "checkYouTubeBlock",
    fn: async (t) => {
        await t.step(
            "403 text/plain without a signal is not a block",
            async () => {
                assertEquals(
                    await blockDetected(
                        new Response("", {
                            status: 403,
                            headers: { "content-type": "text/plain" },
                        }),
                    ),
                    false,
                );
            },
        );

        await t.step("429 html without a signal is not a block", async () => {
            assertEquals(
                await blockDetected(
                    new Response("<html>slow down</html>", {
                        status: 429,
                        headers: { "content-type": "text/html" },
                    }),
                ),
                false,
            );
        });

        await t.step("403 html with 'unusual traffic' is a block", async () => {
            assertEquals(
                await blockDetected(
                    new Response(
                        "<html>Our systems have detected unusual traffic</html>",
                        {
                            status: 403,
                            headers: { "content-type": "text/html" },
                        },
                    ),
                ),
                true,
            );
        });

        await t.step(
            "200 json with 'protect our community' is a block",
            async () => {
                assertEquals(
                    await blockDetected(
                        new Response(
                            JSON.stringify({
                                playabilityStatus: {
                                    subreason:
                                        "This helps protect our community.",
                                },
                            }),
                            {
                                status: 200,
                                headers: { "content-type": "application/json" },
                            },
                        ),
                    ),
                    true,
                );
            },
        );

        await t.step(
            "403 video/mp4 is never inspected and never a block",
            async () => {
                assertEquals(
                    await blockDetected(
                        new Response("unusual traffic", {
                            status: 403,
                            headers: { "content-type": "video/mp4" },
                        }),
                    ),
                    false,
                );
            },
        );
    },
    // The single-proxy path creates one Deno.HttpClient per config; it is
    // reused, never closed in this unit test.
    sanitizeResources: false,
});
