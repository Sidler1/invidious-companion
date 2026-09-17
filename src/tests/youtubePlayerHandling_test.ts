import { assert, assertEquals } from "./deps.ts";
import type { ApiResponse, Innertube } from "youtubei.js";
import {
    trimPlayerResponse,
    youtubePlayerParsing,
} from "../lib/helpers/youtubePlayerHandling.ts";
import {
    awaitPendingCacheWrites,
    readCachedPlayerResponse,
    videoCacheKey,
} from "../lib/helpers/playerCache.ts";
import { Metrics } from "../lib/helpers/metrics.ts";
import type { Config } from "../lib/helpers/config.ts";

async function counterValue(
    counter: { get(): Promise<{ values: { value: number }[] }> },
): Promise<number> {
    return (await counter.get()).values[0]?.value ?? 0;
}

const VIDEO_ID = "abcdefghijk";

const errorResponse = (): ApiResponse => ({
    success: true,
    status_code: 200,
    data: {
        responseContext: { visitorData: "must-not-leak" },
        playabilityStatus: { status: "ERROR", reason: "Video unavailable" },
        videoDetails: { videoId: VIDEO_ID },
    },
} as ApiResponse);

function makeConfig(cacheEnabled: boolean): Config {
    return {
        cache: {
            enabled: cacheEnabled,
            ttl_seconds: 3600,
            negative_ttl_seconds: 30,
        },
    } as unknown as Config;
}

const innertubeClient = {} as unknown as Innertube;
const tokenMinter = () => Promise.resolve("pot");

Deno.test("trimPlayerResponse keeps only the public player fields", () => {
    const trimmed = trimPlayerResponse({
        responseContext: { visitorData: "x" },
        playabilityStatus: { status: "OK" },
        streamingData: { formats: [] },
        videoDetails: { videoId: VIDEO_ID },
        streamingDataClients: { formats: "WEB", adaptiveFormats: "WEB" },
    });

    assertEquals(Object.keys(trimmed).sort(), [
        "captions",
        "microformat",
        "playabilityStatus",
        "storyboards",
        "streamingData",
        "videoDetails",
    ]);
    assertEquals(
        (trimmed as Record<string, unknown>).responseContext,
        undefined,
    );
});

Deno.test("youtubePlayerParsing", async (t) => {
    const kv = await Deno.openKv(":memory:");

    await t.step(
        "returns the trimmed shape and records metrics for ERROR responses",
        async () => {
            const metrics = new Metrics();
            let checked = 0;
            metrics.checkInnertubeResponse = () => {
                checked++;
            };

            const result = await youtubePlayerParsing({
                innertubeClient,
                videoId: VIDEO_ID,
                config: makeConfig(true),
                tokenMinter,
                metrics,
                cacheGeneration: 1,
                deps: { playerReq: () => Promise.resolve(errorResponse()), kv },
            }) as Record<string, unknown>;

            assertEquals(
                (result.playabilityStatus as { status: string }).status,
                "ERROR",
            );
            assertEquals(result.responseContext, undefined);
            assertEquals(checked, 1);
        },
    );

    await t.step("negative-caches the ERROR response", async () => {
        await awaitPendingCacheWrites();
        const cached = await readCachedPlayerResponse(
            kv,
            videoCacheKey(1, VIDEO_ID),
        );
        assert(cached !== null, "expected a negative cache entry");
        assertEquals(
            (cached as { playabilityStatus: { status: string } })
                .playabilityStatus.status,
            "ERROR",
        );
    });

    await t.step("serves a cache hit without calling YouTube", async () => {
        let calls = 0;
        const result = await youtubePlayerParsing({
            innertubeClient,
            videoId: VIDEO_ID,
            config: makeConfig(true),
            tokenMinter,
            metrics: undefined,
            cacheGeneration: 1,
            deps: {
                playerReq: () => {
                    calls++;
                    return Promise.reject(new Error("must not be called"));
                },
                kv,
            },
        }) as Record<string, unknown>;

        assertEquals(calls, 0);
        assertEquals(
            (result.playabilityStatus as { status: string }).status,
            "ERROR",
        );
    });

    await t.step("a different generation misses the cache", async () => {
        let calls = 0;
        await youtubePlayerParsing({
            innertubeClient,
            videoId: VIDEO_ID,
            config: makeConfig(true),
            tokenMinter,
            metrics: undefined,
            cacheGeneration: 2,
            deps: {
                playerReq: () => {
                    calls++;
                    return Promise.resolve(errorResponse());
                },
                kv,
            },
        });
        assertEquals(calls, 1);
    });

    await t.step("does not touch KV when the cache is disabled", async () => {
        const isolated = await Deno.openKv(":memory:");
        let calls = 0;
        await youtubePlayerParsing({
            innertubeClient,
            videoId: VIDEO_ID,
            config: makeConfig(false),
            tokenMinter,
            metrics: undefined,
            deps: {
                playerReq: () => {
                    calls++;
                    return Promise.resolve(errorResponse());
                },
                kv: isolated,
            },
        });
        await awaitPendingCacheWrites();

        assertEquals(calls, 1);
        assertEquals(
            (await isolated.get(videoCacheKey(0, VIDEO_ID))).value,
            null,
        );
        isolated.close();
    });

    await t.step(
        "concurrent calls for different generations both fetch upstream",
        async () => {
            const isolated = await Deno.openKv(":memory:");
            let calls = 0;
            const deps = {
                playerReq: () => {
                    calls++;
                    return Promise.resolve(errorResponse());
                },
                kv: isolated,
            };

            // Same videoId, different cacheGeneration: a caller on the new
            // session generation must never be handed the old generation's
            // in-flight fetch (it would carry the old session's PO
            // token/egress IP), so both calls must hit playerReq.
            await Promise.all([
                youtubePlayerParsing({
                    innertubeClient,
                    videoId: "concurrentgenid",
                    config: makeConfig(true),
                    tokenMinter,
                    metrics: undefined,
                    cacheGeneration: 5,
                    deps,
                }),
                youtubePlayerParsing({
                    innertubeClient,
                    videoId: "concurrentgenid",
                    config: makeConfig(true),
                    tokenMinter,
                    metrics: undefined,
                    cacheGeneration: 6,
                    deps,
                }),
            ]);

            assertEquals(calls, 2);
            // Both calls negative-cache their ERROR result in the
            // background (fire-and-forget); drain those writes before
            // closing so they don't log a "Database is closed" error onto
            // a later step's output.
            await awaitPendingCacheWrites();
            isolated.close();
        },
    );

    await t.step(
        "concurrent calls for the same generation share one upstream fetch",
        async () => {
            let calls = 0;
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const callArgs = {
                innertubeClient,
                videoId: "concurrentsameid",
                // Cache disabled so there is no KV read before the
                // in-flight check: with it enabled, the async KV round-trip
                // (real I/O even for ":memory:") leaves a gap where a
                // second call issued right after the first would not yet
                // see the first's in-flight registration, making the
                // "share one fetch" assertion flaky rather than a genuine
                // test of the single-flight map.
                config: makeConfig(false),
                tokenMinter,
                metrics: undefined,
                cacheGeneration: 5,
                deps: {
                    playerReq: async () => {
                        calls++;
                        await gate;
                        return errorResponse();
                    },
                },
            };

            // No await between these two calls: with the cache disabled,
            // youtubePlayerParsing runs synchronously (no suspension point)
            // up to registering itself in the in-flight map, so the second
            // call is guaranteed to observe the first's registration.
            const first = youtubePlayerParsing(callArgs);
            const second = youtubePlayerParsing(callArgs);

            release();
            await Promise.all([first, second]);

            assertEquals(calls, 1);
        },
    );

    await t.step(
        "OK path deciphers formats, drops signatureCipher, and caches",
        async () => {
            const isolated = await Deno.openKv(":memory:");
            const metrics = new Metrics();
            const okVideoId = "okvideoid12";
            // Minimal Innertube stub for YT.VideoInfo: `actions` only needs
            // to exist (VideoInfo's constructor doesn't call it while
            // parsing formats), and `session.player` may stay undefined —
            // Format.decipher() returns `url` unchanged when it is already
            // present, without needing a real player. `signatureCipher` is
            // included on the first format purely to prove our code drops
            // it; it is not exercised by a real player-based decipher here.
            const okInnertubeClient = {
                actions: {},
                session: { player: undefined, po_token: "sess" },
            } as unknown as Innertube;

            const okResponse = (): ApiResponse => ({
                success: true,
                status_code: 200,
                data: {
                    playabilityStatus: { status: "OK" },
                    streamingData: {
                        expiresInSeconds: "21540",
                        formats: [
                            {
                                itag: 18,
                                url: "https://h/18",
                                signatureCipher: "s=AAA&sp=sig&url=" +
                                    encodeURIComponent("https://h/18"),
                            },
                        ],
                        adaptiveFormats: [
                            { itag: 137, url: "https://h/137" },
                        ],
                    },
                    streamingDataClients: {
                        formats: "WEB",
                        adaptiveFormats: "WEB",
                    },
                    videoDetails: { videoId: okVideoId },
                },
            } as ApiResponse);

            const result = await youtubePlayerParsing({
                innertubeClient: okInnertubeClient,
                videoId: okVideoId,
                config: makeConfig(true),
                tokenMinter,
                metrics,
                cacheGeneration: 9,
                deps: {
                    playerReq: () => Promise.resolve(okResponse()),
                    kv: isolated,
                },
            }) as Record<string, unknown>;

            const streamingData = result.streamingData as {
                formats: Record<string, unknown>[];
                adaptiveFormats: Record<string, unknown>[];
            };

            assert(
                (streamingData.formats[0].url as string).endsWith(
                    "&alr=no&pot=sess",
                ),
                "expected the format url to be deciphered and finalised",
            );
            assertEquals(streamingData.formats[0].signatureCipher, undefined);

            assert(
                (streamingData.adaptiveFormats[0].url as string).endsWith(
                    "&alr=no&pot=sess",
                ),
                "expected the adaptive format url to be deciphered and finalised",
            );

            assertEquals(
                await counterValue(metrics.innertubeSuccessfulRequest),
                1,
            );

            await awaitPendingCacheWrites();
            const cached = await readCachedPlayerResponse(
                isolated,
                videoCacheKey(9, okVideoId),
            );
            assert(cached !== null, "expected the OK response to be cached");

            isolated.close();
        },
    );

    kv.close();
});
