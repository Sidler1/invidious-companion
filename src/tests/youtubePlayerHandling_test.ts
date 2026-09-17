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

    kv.close();
});
