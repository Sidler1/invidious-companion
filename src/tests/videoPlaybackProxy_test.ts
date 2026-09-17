import { Hono } from "hono";
import { assert, assertEquals } from "./deps.ts";
import { withEnv } from "./helpers/env.ts";
import type { HonoVariables } from "../lib/types/HonoVariables.ts";
import type { Config } from "../lib/helpers/config.ts";
// Type-only import: pulls in main.ts's `declare module "hono"` augmentation
// that types `config`/`metrics` on the Hono context, so `c.set(...)` below
// type-checks. Erased at runtime — main.ts's side effects never run.
import type {} from "../main.ts";

const GV_A = "rr1---sn-a.googlevideo.com";
const GV_B = "rr2---sn-b.googlevideo.com";

type FetchCall = { url: string; init: RequestInit };

/**
 * Build an app with the real videoPlaybackProxy mounted and config/metrics
 * injected, and replace globalThis.fetch with `respond`. The default config
 * has no proxy and no pool, so getFetchClient uses the direct path, which
 * calls globalThis.fetch. A fresh config object per test rebuilds the
 * getFetchClient singleton.
 */
async function withProxyApp(
    respond: (call: FetchCall, index: number) => Response,
    run: (
        app: Hono<{ Variables: HonoVariables }>,
        calls: FetchCall[],
    ) => Promise<void>,
): Promise<void> {
    const originalFetch = globalThis.fetch;
    const calls: FetchCall[] = [];
    try {
        await withEnv({ SERVER_SECRET_KEY: "aaaaaaaaaaaaaaaa" }, async () => {
            const { parseConfig } = await import("../lib/helpers/config.ts");
            const { default: videoPlaybackProxy } = await import(
                "../routes/videoPlaybackProxy.ts"
            );
            const base = await parseConfig();
            // Force the direct path regardless of PROXY / IPv6 env on the host.
            const config: Config = {
                ...base,
                networking: {
                    ...base.networking,
                    proxy: null,
                    ipv6_block: null,
                    proxy_pool: {
                        ...base.networking.proxy_pool,
                        enabled: false,
                    },
                },
            };

            globalThis.fetch = (
                (input: RequestInfo | URL, init?: RequestInit) => {
                    const call = { url: String(input), init: init ?? {} };
                    calls.push(call);
                    return Promise.resolve(respond(call, calls.length - 1));
                }
            ) as typeof fetch;

            const app = new Hono<{ Variables: HonoVariables }>();
            app.use("*", async (c, next) => {
                c.set("config", config);
                c.set("metrics", undefined);
                await next();
            });
            app.route("/videoplayback", videoPlaybackProxy);

            await run(app, calls);
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
}

function futureExpire(): string {
    return String(Math.floor(Date.now() / 1000) + 3600);
}

function videoResponse(status = 200): Response {
    return new Response("video-bytes", {
        status,
        headers: { "content-type": "video/mp4", "content-length": "11" },
    });
}

Deno.test("videoPlaybackProxy", async (t) => {
    await t.step(
        "streams a 200 through and marks the fetch as streaming",
        async () => {
            await withProxyApp(() => videoResponse(), async (app, calls) => {
                const res = await app.request(
                    `/videoplayback?host=${GV_A}&c=WEB&expire=${futureExpire()}&id=abc`,
                );
                assertEquals(res.status, 200);
                assertEquals(await res.text(), "video-bytes");
                assertEquals(res.headers.get("content-type"), "video/mp4");
                assertEquals(calls.length, 1);
                assert(
                    calls[0].url.startsWith(`https://${GV_A}/videoplayback?`),
                );
                assertEquals(calls[0].init.redirect, "manual");
            });
        },
    );

    await t.step(
        "attaches a header-phase abort signal that is not aborted once headers arrive, body still readable",
        async () => {
            await withProxyApp(() => videoResponse(), async (app, calls) => {
                const res = await app.request(
                    `/videoplayback?host=${GV_A}&c=WEB&expire=${futureExpire()}&id=abc`,
                );
                assertEquals(res.status, 200);
                assert(calls[0].init.signal instanceof AbortSignal);
                assertEquals(calls[0].init.signal?.aborted, false);
                assertEquals(await res.text(), "video-bytes");
            });
        },
    );

    await t.step(
        "returns 502 'Upstream timeout.' when headers never arrive within the configured timeout",
        async () => {
            const originalFetch = globalThis.fetch;
            try {
                await withEnv(
                    { SERVER_SECRET_KEY: "aaaaaaaaaaaaaaaa" },
                    async () => {
                        const { parseConfig } = await import(
                            "../lib/helpers/config.ts"
                        );
                        const { default: videoPlaybackProxy } = await import(
                            "../routes/videoPlaybackProxy.ts"
                        );
                        const base = await parseConfig();
                        const config: Config = {
                            ...base,
                            networking: {
                                ...base.networking,
                                proxy: null,
                                ipv6_block: null,
                                proxy_pool: {
                                    ...base.networking.proxy_pool,
                                    enabled: false,
                                },
                                fetch: {
                                    ...base.networking.fetch,
                                    timeout_ms: 1000,
                                },
                            },
                        };

                        globalThis.fetch = (
                            (
                                _input: RequestInfo | URL,
                                init?: RequestInit,
                            ) => {
                                const signal = init?.signal;
                                return new Promise<Response>(
                                    (_resolve, reject) => {
                                        signal?.addEventListener(
                                            "abort",
                                            () => {
                                                reject(
                                                    new DOMException(
                                                        "aborted",
                                                        "AbortError",
                                                    ),
                                                );
                                            },
                                        );
                                    },
                                );
                            }
                        ) as typeof fetch;

                        const app = new Hono<{ Variables: HonoVariables }>();
                        app.use("*", async (c, next) => {
                            c.set("config", config);
                            c.set("metrics", undefined);
                            await next();
                        });
                        app.route("/videoplayback", videoPlaybackProxy);

                        const res = await app.request(
                            `/videoplayback?host=${GV_A}&c=WEB&expire=${futureExpire()}&id=abc`,
                        );
                        assertEquals(res.status, 502);
                        assertEquals(await res.text(), "Upstream timeout.");
                    },
                );
            } finally {
                globalThis.fetch = originalFetch;
            }
        },
    );

    await t.step(
        "follows a googlevideo redirect and returns the final body",
        async () => {
            await withProxyApp(
                (_call, index) =>
                    index === 0
                        ? new Response(null, {
                            status: 302,
                            headers: {
                                location:
                                    `https://${GV_B}/videoplayback?id=abc&r=1`,
                            },
                        })
                        : videoResponse(),
                async (app, calls) => {
                    const res = await app.request(
                        `/videoplayback?host=${GV_A}&c=WEB&expire=${futureExpire()}&id=abc`,
                    );
                    assertEquals(res.status, 200);
                    assertEquals(await res.text(), "video-bytes");
                    assertEquals(calls.length, 2);
                    assertEquals(
                        calls[1].url,
                        `https://${GV_B}/videoplayback?id=abc&r=1`,
                    );
                },
            );
        },
    );

    await t.step("returns 502 after five redirects", async () => {
        await withProxyApp(
            () =>
                new Response(null, {
                    status: 302,
                    headers: {
                        location: `https://${GV_B}/videoplayback?id=abc`,
                    },
                }),
            async (app, calls) => {
                const res = await app.request(
                    `/videoplayback?host=${GV_A}&c=WEB&expire=${futureExpire()}&id=abc`,
                );
                assertEquals(res.status, 502);
                assertEquals(await res.text(), "Too many redirects.");
                // initial request + 5 followed redirects, then stop.
                assertEquals(calls.length, 6);
            },
        );
    });

    await t.step("returns 502 for a redirect to a foreign host", async () => {
        await withProxyApp(
            () =>
                new Response(null, {
                    status: 302,
                    headers: { location: "https://evil.com/videoplayback" },
                }),
            async (app, calls) => {
                const res = await app.request(
                    `/videoplayback?host=${GV_A}&c=WEB&expire=${futureExpire()}&id=abc`,
                );
                assertEquals(res.status, 502);
                assertEquals(await res.text(), "Invalid redirect target.");
                assertEquals(calls.length, 1);
            },
        );
    });

    await t.step(
        "passes Range through and returns 206 with content-range",
        async () => {
            await withProxyApp(
                () =>
                    new Response("art", {
                        status: 206,
                        headers: {
                            "content-type": "video/mp4",
                            "content-range": "bytes 0-2/11",
                            "content-length": "3",
                        },
                    }),
                async (app, calls) => {
                    const res = await app.request(
                        `/videoplayback?host=${GV_A}&c=WEB&expire=${futureExpire()}&id=abc`,
                        { headers: { range: "bytes=0-2" } },
                    );
                    assertEquals(res.status, 206);
                    assertEquals(
                        res.headers.get("content-range"),
                        "bytes 0-2/11",
                    );
                    const sent = new Headers(calls[0].init.headers);
                    assertEquals(sent.get("range"), "bytes=0-2");
                },
            );
        },
    );

    await t.step("rejects a non-integer expire with 400", async () => {
        await withProxyApp(() => videoResponse(), async (app, calls) => {
            const res = await app.request(
                `/videoplayback?host=${GV_A}&c=WEB&expire=abc&id=abc`,
            );
            assertEquals(res.status, 400);
            assertEquals(await res.text(), "Expired URL");
            assertEquals(calls.length, 0);
        });
    });

    await t.step("rejects a past expire with 400", async () => {
        await withProxyApp(() => videoResponse(), async (app, calls) => {
            const res = await app.request(
                `/videoplayback?host=${GV_A}&c=WEB&expire=1&id=abc`,
            );
            assertEquals(res.status, 400);
            assertEquals(await res.text(), "Expired URL");
            assertEquals(calls.length, 0);
        });
    });

    await t.step("rejects a non-googlevideo host with 400", async () => {
        await withProxyApp(() => videoResponse(), async (app, calls) => {
            const res = await app.request(
                `/videoplayback?host=rr1.googlevideo.com.evil.com&c=WEB&expire=${futureExpire()}`,
            );
            assertEquals(res.status, 400);
            assertEquals(await res.text(), "Invalid host");
            assertEquals(calls.length, 0);
        });
    });

    await t.step(
        "strips host, title, enc and data from the upstream query",
        async () => {
            await withProxyApp(() => videoResponse(), async (app, calls) => {
                const res = await app.request(
                    `/videoplayback?host=${GV_A}&c=WEB&expire=${futureExpire()}&id=abc&title=t&enc=false&data=xyz`,
                );
                assertEquals(res.status, 200);
                const upstream = new URL(calls[0].url);
                assertEquals(upstream.searchParams.has("host"), false);
                assertEquals(upstream.searchParams.has("title"), false);
                assertEquals(upstream.searchParams.has("enc"), false);
                assertEquals(upstream.searchParams.has("data"), false);
                assertEquals(upstream.searchParams.get("id"), "abc");
            });
        },
    );

    await t.step("returns 400 for an undecryptable enc payload", async () => {
        await withProxyApp(() => videoResponse(), async (app, calls) => {
            const res = await app.request(
                `/videoplayback?host=${GV_A}&c=WEB&expire=${futureExpire()}&enc=true&data=not-base64`,
            );
            assertEquals(res.status, 400);
            assertEquals(await res.text(), "Invalid encrypted data parameter");
            assertEquals(calls.length, 0);
        });
    });
});
