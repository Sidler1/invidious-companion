import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
    youtubePlayerParsing,
    youtubeVideoInfo,
} from "../../lib/helpers/youtubePlayerHandling.ts";
import { encryptQuery } from "../../lib/helpers/encryptQuery.ts";
import {
    requireTokenMinter,
    requireValidVideoId,
    requireVerifiedCheck,
} from "../guards.ts";
import { assertPlayable } from "../../lib/helpers/playability.ts";
import type { HonoVariables } from "../../lib/types/HonoVariables.ts";

const PRIVATE_PARAM_NAMES = ["pot", "ip"];

const latestVersion = new Hono<{ Variables: HonoVariables }>();

latestVersion.get("/", async (c) => {
    const { itag, id, local, title } = c.req.query();
    c.header("access-control-allow-origin", "*");

    if (!id || !itag) {
        throw new HTTPException(400, {
            res: new Response("Please specify the itag and video ID."),
        });
    }

    const videoId = requireValidVideoId(id);

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
    const streamingData = videoInfo.streaming_data;
    const availableFormats = streamingData?.formats.concat(
        streamingData.adaptive_formats,
    );

    // Without this guard the handler would fall through without returning a
    // response, surfacing as an opaque "context not finalized" 500.
    if (!availableFormats) {
        throw new HTTPException(500, {
            res: new Response("No streaming data available for: " + videoId),
        });
    }

    const numericItag = Number(itag);
    const selectedItagFormat = availableFormats?.filter((i) =>
        i.itag == numericItag
    );
    if (selectedItagFormat?.length === 0) {
        throw new HTTPException(400, {
            res: new Response("No itag found."),
        });
    } else if (selectedItagFormat) {
        // Always offer original audio if possible
        // This may be changed due to https://github.com/iv-org/invidious/issues/5501
        const itagUrl = selectedItagFormat.find((itag) =>
            itag.is_original
        )?.url as string || selectedItagFormat[0].url as string;
        const itagUrlParsed = new URL(itagUrl);
        const queryParams = new URLSearchParams(itagUrlParsed.search);
        let urlToRedirect = itagUrlParsed.toString();

        if (local) {
            queryParams.set("host", itagUrlParsed.host);
            if (config.server.encrypt_query_params) {
                const privateParams = [...queryParams].filter(([key]) =>
                    PRIVATE_PARAM_NAMES.includes(key)
                );
                let encryptedParams: string;
                try {
                    encryptedParams = await encryptQuery(
                        JSON.stringify(privateParams),
                        config,
                    );
                } catch {
                    throw new HTTPException(500, {
                        res: new Response("Failed to encrypt query."),
                    });
                }

                for (const param of PRIVATE_PARAM_NAMES) {
                    queryParams.delete(param);
                }

                queryParams.set("enc", "true");
                queryParams.set("data", encryptedParams);
            }
            urlToRedirect = config.server.base_path + itagUrlParsed.pathname +
                "?" +
                queryParams.toString();
        }

        if (title) urlToRedirect += `&title=${encodeURIComponent(title)}`;

        return c.redirect(urlToRedirect);
    }
});

export default latestVersion;
