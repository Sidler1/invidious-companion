import { Hono } from "hono";
import { assertEquals } from "./deps.ts";
import type { Innertube } from "youtubei.js";
import type { HonoVariables } from "../lib/types/HonoVariables.ts";
import type { TokenMinter } from "../lib/jobs/potoken.ts";
import { makeTestConfig } from "./helpers/testConfig.ts";
import dashManifest from "../routes/invidious_routes/dashManifest.ts";
import latestVersion from "../routes/invidious_routes/latestVersion.ts";
import captionsHandler from "../routes/invidious_routes/captions.ts";
import { closeKv, getKv } from "../lib/helpers/kv.ts";
import {
    awaitPendingCacheWrites,
    videoCacheKey,
    writePlayerCache,
} from "../lib/helpers/playerCache.ts";

// Route-level coverage for the guards added in Task 6: an ERROR player
// response must 403 on dash/latest_version and 404 on captions, and an OK
// response with no streaming_data must 404 on dash. `youtubePlayerParsing`
// reads its memoized KV cache BEFORE calling YouTube (see
// `src/lib/helpers/youtubePlayerHandling.ts`), so seeding that cache lets
// these routes be exercised through `app.request(...)` with no network.

const ERROR_VIDEO_ID = "errorVideo1";
const OK_NO_STREAM_VIDEO_ID = "okNoStream1";

const stubMinter =
    ((_videoId: string) => Promise.resolve("pot")) as unknown as TokenMinter;

// Minimal Innertube stub for YT.VideoInfo: `actions` only needs to exist,
// and `session.player`/`session.po_token` are unused on the cache-hit path
// these tests exercise (see the identical stub in
// youtubePlayerHandling_test.ts's OK-path case).
const stubInnertubeClient = {
    actions: {},
    session: { player: undefined, po_token: undefined },
} as unknown as Innertube;

async function buildApp() {
    const tempDir = await Deno.makeTempDir();
    const config = makeTestConfig({
        cache: { enabled: true, directory: tempDir },
        server: { verify_requests: false },
        captions: { enabled: true },
    });
    const app = new Hono<{ Variables: HonoVariables }>();
    app.use("*", async (c, next) => {
        c.set("innertubeClient", stubInnertubeClient);
        c.set("tokenMinter", stubMinter);
        c.set("config", config);
        c.set("metrics", undefined);
        c.set("sessionGeneration", 0);
        await next();
    });
    app.route("/api/manifest/dash/id", dashManifest);
    app.route("/latest_version", latestVersion);
    app.route("/api/v1/captions", captionsHandler);
    return { app, config, tempDir };
}

async function seed(
    config: ReturnType<typeof makeTestConfig>,
    videoId: string,
    payload: object,
) {
    const kv = await getKv(config);
    await writePlayerCache(kv, videoCacheKey(0, videoId), payload, 60);
    await awaitPendingCacheWrites();
}

Deno.test("route guards on a seeded ERROR player response", async (t) => {
    const { app, config, tempDir } = await buildApp();
    try {
        await seed(config, ERROR_VIDEO_ID, {
            playabilityStatus: {
                status: "ERROR",
                reason: "Video unavailable",
            },
            videoDetails: { videoId: ERROR_VIDEO_ID },
        });

        await t.step("dash manifest 403s with the legacy message", async () => {
            const res = await app.request(
                `/api/manifest/dash/id/${ERROR_VIDEO_ID}`,
            );
            assertEquals(res.status, 403);
            assertEquals(
                await res.text(),
                "The video can't be played: " + ERROR_VIDEO_ID +
                    " due to reason: Video unavailable",
            );
        });

        await t.step(
            "latest_version 403s with the legacy message",
            async () => {
                const res = await app.request(
                    `/latest_version?id=${ERROR_VIDEO_ID}&itag=18`,
                );
                assertEquals(res.status, 403);
                assertEquals(
                    await res.text(),
                    "The video can't be played: " + ERROR_VIDEO_ID +
                        " due to reason: Video unavailable",
                );
            },
        );

        await t.step("captions 404s", async () => {
            const res = await app.request(
                `/api/v1/captions/${ERROR_VIDEO_ID}`,
            );
            await res.body?.cancel();
            assertEquals(res.status, 404);
        });
    } finally {
        // Deliberate: closeKv() resets the process-global memo in
        // src/lib/helpers/kv.ts, which every test file in this process
        // shares. Other test files must not hold a getKv() handle open
        // across this file running.
        await closeKv();
        await Deno.remove(tempDir, { recursive: true });
    }
});

Deno.test("dash manifest 404s an OK response with no streaming data", async () => {
    const { app, config, tempDir } = await buildApp();
    try {
        await seed(config, OK_NO_STREAM_VIDEO_ID, {
            playabilityStatus: { status: "OK" },
            videoDetails: { videoId: OK_NO_STREAM_VIDEO_ID, title: "t" },
        });

        const res = await app.request(
            `/api/manifest/dash/id/${OK_NO_STREAM_VIDEO_ID}`,
        );
        assertEquals(res.status, 404);
        assertEquals(await res.text(), "No streaming data available.");
    } finally {
        await closeKv();
        await Deno.remove(tempDir, { recursive: true });
    }
});
