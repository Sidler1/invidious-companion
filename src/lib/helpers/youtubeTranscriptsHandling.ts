import { Innertube } from "youtubei.js";
import type { CaptionTrackData } from "youtubei.js/PlayerCaptionsTracklist";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { CTX, logWarn } from "./log.ts";

// The only origin a caption track's base_url may point at. The URL comes
// from the (cacheable) player response; without this check a manipulated
// response could receive a freshly minted, video-bound PO token.
const CAPTIONS_ALLOWED_HOST = "www.youtube.com";
const INVALID_CAPTION_URL_MESSAGE = "Invalid caption track URL.";

function createTemporalDuration(milliseconds: number) {
    return new Temporal.Duration(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        milliseconds,
    );
}

const ESCAPE_SUBSTITUTIONS = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\u200E": "&lrm;",
    "\u200F": "&rlm;",
    "\u00A0": "&nbsp;",
};

function shiftVttToCenter(vtt: string): string {
    const lines = vtt.split("\n");
    const updatedLines: string[] = [];
    const timingRegex =
        /^((?:\d{1,2}:)?\d{2}:\d{2}\.\d{3} --> (?:\d{1,2}:)?\d{2}:\d{2}\.\d{3})(.*)$/;

    for (const line of lines) {
        const match = line.match(timingRegex);
        if (match) {
            updatedLines.push(match[1]);
        } else {
            updatedLines.push(line);
        }
    }

    return updatedLines.join("\n");
}

/**
 * Build the timedtext URL for a caption track, attaching the PO token only
 * after confirming the track really points at YouTube.
 */
export function buildCaptionUrl(
    baseUrl: string,
    poToken: string,
    clientName: string,
): URL {
    let url: URL;
    try {
        url = new URL(baseUrl);
    } catch {
        throw new HTTPException(502, {
            res: new Response(INVALID_CAPTION_URL_MESSAGE),
        });
    }
    if (url.protocol !== "https:" || url.hostname !== CAPTIONS_ALLOWED_HOST) {
        throw new HTTPException(502, {
            res: new Response(INVALID_CAPTION_URL_MESSAGE),
        });
    }
    url.searchParams.set("fmt", "vtt");
    url.searchParams.set("potc", "1");
    url.searchParams.set("pot", poToken);
    url.searchParams.set("c", clientName);
    return url;
}

export async function handleTranscripts(
    innertubeClient: Innertube,
    videoId: string,
    selectedCaption: CaptionTrackData,
    poToken?: string,
    clientName?: string,
) {
    if (poToken && clientName) {
        const url = buildCaptionUrl(
            selectedCaption.base_url,
            poToken,
            clientName,
        );

        let response: Response;
        try {
            response = await innertubeClient.session.http.fetch(url, {
                method: "GET",
            });
        } catch (err) {
            // Never let the raw fetch error escape: Deno embeds the full URL
            // (including pot=) in its message.
            logWarn(
                CTX.CAPTIONS,
                `Caption fetch failed for ${videoId}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            throw new HTTPException(502, {
                res: new Response("Failed to fetch captions."),
            });
        }

        if (!response.ok) {
            // Only forward the upstream status when it's a valid HTTP error
            // code; anything else (e.g. a malformed/out-of-range status from
            // a compromised or misbehaving upstream) becomes a plain 502
            // rather than being handed to the client verbatim.
            const upstreamStatus = response.status;
            const status: ContentfulStatusCode =
                upstreamStatus >= 400 && upstreamStatus <= 599
                    ? upstreamStatus as ContentfulStatusCode
                    : 502;
            throw new HTTPException(status, {
                res: new Response("Failed to fetch captions."),
            });
        }

        const vttText = await response.text();

        if (!vttText.startsWith("WEBVTT")) {
            throw new HTTPException(404, {
                res: new Response("No valid captions found."),
            });
        }

        return shiftVttToCenter(vttText);
    } else {
        const lines: string[] = ["WEBVTT"];

        const info = await innertubeClient.getInfo(videoId);
        const transcriptInfo = await (await info.getTranscript())
            .selectLanguage(
                selectedCaption.name.text || "",
            );
        const rawTranscriptLines = transcriptInfo.transcript.content?.body
            ?.initial_segments;

        if (rawTranscriptLines == undefined) throw new HTTPException(404);

        rawTranscriptLines.forEach((line) => {
            const timestampFormatOptions = {
                style: "digital",
                minutesDisplay: "always",
                fractionalDigits: 3,
            };

            // Temporal.Duration.prototype.toLocaleString() is supposed to delegate to Intl.DurationFormat
            // which Deno does not support. However, instead of following specs and having toLocaleString return
            // the same toString() it seems to have its own implementation of Intl.DurationFormat,
            // with its options parameter type incorrectly restricted to the same as the one for Intl.DateTimeFormatOptions
            // even though they do not share the same arguments.
            //
            // The above matches the options parameter of Intl.DurationFormat, and the resulting output is as expected.
            // Until this is fixed typechecking must be disabled for the two use cases below
            //
            // See
            // https://docs.deno.com/api/web/~/Intl.DateTimeFormatOptions
            // https://docs.deno.com/api/web/~/Temporal.Duration.prototype.toLocaleString
            // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal/Duration/toLocaleString
            // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DurationFormat/DurationFormat

            const start_ms = createTemporalDuration(Number(line.start_ms))
                .round({
                    largestUnit: "year",
                    relativeTo: Temporal.PlainDateTime.from("2022-01-01"),
                    //@ts-ignore see above
                }).toLocaleString("en-US", timestampFormatOptions);

            const end_ms = createTemporalDuration(Number(line.end_ms)).round({
                largestUnit: "year",
                relativeTo: Temporal.PlainDateTime.from("2022-01-01"),
                //@ts-ignore see above
            }).toLocaleString("en-US", timestampFormatOptions);
            const timestamp = `${start_ms} --> ${end_ms}`;

            const text = (line.snippet?.text || "").replace(
                /[&<>‍‍\u200E\u200F\u00A0]/g,
                (match: string) =>
                    ESCAPE_SUBSTITUTIONS[
                        match as keyof typeof ESCAPE_SUBSTITUTIONS
                    ],
            );

            lines.push(`${timestamp}\n${text}`);
        });

        return lines.join("\n\n");
    }
}
