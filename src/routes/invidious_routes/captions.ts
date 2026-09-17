import { Hono } from "hono";
import type { HonoVariables } from "../../lib/types/HonoVariables.ts";
import {
    youtubePlayerParsing,
    youtubeVideoInfo,
} from "../../lib/helpers/youtubePlayerHandling.ts";
import type { CaptionTrackData } from "youtubei.js/PlayerCaptionsTracklist";
import { handleTranscripts } from "../../lib/helpers/youtubeTranscriptsHandling.ts";
import { HTTPException } from "hono/http-exception";
import {
    requireTokenMinter,
    requireValidVideoId,
    requireVerifiedCheck,
} from "../guards.ts";

interface AvailableCaption {
    label: string;
    languageCode: string;
    url: string;
}

const captionsHandler = new Hono<{ Variables: HonoVariables }>();
captionsHandler.get("/:videoId", async (c) => {
    const videoId = requireValidVideoId(c.req.param("videoId"));
    const config = c.get("config");
    const metrics = c.get("metrics");
    const tokenMinter = c.get("tokenMinter");

    // Fail early if captions are disabled by the administrator.
    if (!config.captions.enabled) {
        throw new HTTPException(503, {
            res: new Response("Captions are disabled by administrator."),
        });
    }

    requireTokenMinter(c);
    await requireVerifiedCheck(c, videoId);

    metrics?.captionsRequests.inc();

    const innertubeClient = c.get("innertubeClient");

    const youtubePlayerResponseJson = await youtubePlayerParsing({
        innertubeClient,
        videoId,
        config,
        metrics,
        tokenMinter: tokenMinter!,
    });

    const videoInfo = youtubeVideoInfo(
        innertubeClient,
        youtubePlayerResponseJson,
    );

    const captionsTrackArray = videoInfo.captions?.caption_tracks;
    if (captionsTrackArray == undefined) throw new HTTPException(404);

    const label = c.req.query("label");
    const lang = c.req.query("lang");

    // Show all available captions when a specific one is not selected
    if (label == undefined && lang == undefined) {
        const invidiousAvailableCaptionsArr: AvailableCaption[] = [];

        for (const caption_track of captionsTrackArray) {
            invidiousAvailableCaptionsArr.push({
                label: caption_track.name.text || "",
                languageCode: caption_track.language_code,
                url: `${config.server.base_path}/api/v1/captions/${videoId}?label=${
                    encodeURIComponent(caption_track.name.text || "")
                }`,
            });
        }

        return c.json({ captions: invidiousAvailableCaptionsArr });
    }

    // Extract selected caption
    let match: CaptionTrackData | undefined;

    if (lang) {
        match = captionsTrackArray.find((c: CaptionTrackData) =>
            c.language_code === lang
        );
    } else {
        // Normalize like the list above does, so tracks advertised with an
        // empty label (undefined name.text) stay reachable.
        match = captionsTrackArray.find((c: CaptionTrackData) =>
            (c.name.text || "") === label
        );
    }

    if (match == undefined) throw new HTTPException(404);

    // With a PO token the caption track's timedtext URL can be fetched
    // directly; without one we fall back to the transcript endpoint.
    let poToken: string | undefined;
    let clientName: string | undefined;
    if (tokenMinter) {
        poToken = await tokenMinter(videoId);
        clientName = innertubeClient.session.context.client.clientName;
    }

    c.header("Content-Type", "text/vtt; charset=UTF-8");
    c.header("Access-Control-Allow-Origin", "*");
    return c.body(
        await handleTranscripts(
            innertubeClient,
            videoId,
            match,
            poToken,
            clientName,
        ),
    );
});

export default captionsHandler;
