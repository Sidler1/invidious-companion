import { Hono } from "hono";
import { FormatUtils } from "youtubei.js";
import {
    youtubePlayerParsing,
    youtubeVideoInfo,
} from "../../lib/helpers/youtubePlayerHandling.ts";
import { HTTPException } from "hono/http-exception";
import { encryptQuery } from "../../lib/helpers/encryptQuery.ts";
import {
    requireTokenMinter,
    requireValidVideoId,
    requireVerifiedCheck,
} from "../guards.ts";
import { assertPlayable } from "../../lib/helpers/playability.ts";
import type { HonoVariables } from "../../lib/types/HonoVariables.ts";

const PRIVATE_PARAM_NAMES = ["pot", "ip"];

const dashManifest = new Hono<{ Variables: HonoVariables }>();

dashManifest.get("/:videoId", async (c) => {
    const videoId = requireValidVideoId(c.req.param("videoId"));
    const { local } = c.req.query();
    c.header("access-control-allow-origin", "*");

    const innertubeClient = c.get("innertubeClient");
    const config = c.get("config");
    const metrics = c.get("metrics");
    const tokenMinter = c.get("tokenMinter");

    requireTokenMinter(c);
    await requireVerifiedCheck(c, videoId);

    const youtubePlayerResponseJson = await youtubePlayerParsing({
        innertubeClient,
        videoId,
        config,
        tokenMinter: tokenMinter!,
        metrics,
        cacheGeneration: c.get("sessionGeneration"),
    });
    // Must precede youtubeVideoInfo(): YouTube.js v18 throws for ERROR.
    assertPlayable(videoId, youtubePlayerResponseJson);
    const videoInfo = youtubeVideoInfo(
        innertubeClient,
        youtubePlayerResponseJson,
    );

    c.header("content-type", "application/dash+xml");

    if (!videoInfo.streaming_data) {
        throw new HTTPException(404, {
            res: new Response("No streaming data available."),
        });
    }

    if (videoInfo.streaming_data) {
        // video.js only support MP4 not WEBM
        videoInfo.streaming_data.adaptive_formats = videoInfo
            .streaming_data.adaptive_formats
            .filter((i) => i.mime_type.includes("mp4"));

        const player_response = videoInfo.page[0];
        // TODO: fix include storyboards in DASH manifest file
        //const storyboards = player_response.storyboards;
        const captions = player_response.captions?.caption_tracks;

        // Pre-encrypt private query params BEFORE calling FormatUtils.toDash().
        // FormatUtils.toDash() requires a SYNCHRONOUS callback (url: URL) => URL.
        // It does NOT await the callback, so an async callback would produce
        // "[object Promise]" in the URL path — causing 400 errors like:
        //   GET /companion/api/manifest/dash/id/[object%20Promise]?local=true
        //
        // Since `pot` and `ip` are session-level parameters (same across all
        // format URLs for a given video), we extract them from the first format
        // URL and pre-compute the encryption.
        let preEncryptedParams: string | null = null;

        if (local && config.server.encrypt_query_params) {
            const firstFormatUrl =
                videoInfo.streaming_data.adaptive_formats[0]?.url ||
                videoInfo.streaming_data.formats[0]?.url;

            if (firstFormatUrl) {
                const firstUrlParams = new URL(firstFormatUrl).searchParams;
                const privateParams = [...firstUrlParams.entries()].filter(
                    ([key]) => PRIVATE_PARAM_NAMES.includes(key),
                );
                if (privateParams.length > 0) {
                    try {
                        preEncryptedParams = await encryptQuery(
                            JSON.stringify(privateParams),
                            config,
                        );
                    } catch {
                        throw new HTTPException(500, {
                            res: new Response("Failed to encrypt query."),
                        });
                    }
                }
            }
        }

        const dashFile = await FormatUtils.toDash(
            videoInfo.streaming_data,
            videoInfo.page[0].video_details?.is_post_live_dvr,
            (url: URL) => {
                let dashUrl = url;
                const queryParams = new URLSearchParams(dashUrl.search);
                // Can't create URL type without host part
                queryParams.set("host", dashUrl.host);

                if (local) {
                    if (config.networking.videoplayback.ump) {
                        queryParams.set("ump", "yes");
                    }
                    if (preEncryptedParams !== null) {
                        for (const param of PRIVATE_PARAM_NAMES) {
                            queryParams.delete(param);
                        }

                        queryParams.set("enc", "true");
                        queryParams.set("data", preEncryptedParams);
                    }
                    dashUrl =
                        (config.server.base_path + dashUrl.pathname + "?" +
                            queryParams.toString()) as unknown as URL;
                    return dashUrl;
                } else {
                    return dashUrl;
                }
            },
            undefined,
            videoInfo.cpn,
            undefined,
            innertubeClient.actions,
            undefined,
            captions,
            undefined,
        );
        return c.body(dashFile);
    }
});

export default dashManifest;
