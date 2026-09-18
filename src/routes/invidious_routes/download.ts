import type { Context, Hono } from "hono";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import {
    requireTokenMinter,
    requireValidVideoId,
    requireVerifiedCheck,
} from "../guards.ts";
import type { HonoVariables } from "../../lib/types/HonoVariables.ts";
import { attachmentContentDisposition } from "../../lib/helpers/contentDisposition.ts";

// Invidious' download widget sends, for the itag branch, a mime subtype
// (mp4, webm, m4a) that gets spliced into a filename / query param, so it's
// bounded to a strict format. For the label (captions) branch it sends
// "<languageCode>.vtt" (e.g. "en.vtt", "es-419.vtt", "zh-Hans.vtt") — that
// value is never used downstream, so only its length is bounded.
const ItagExtensionSchema = z.string().regex(/^[a-z0-9]{1,5}$/);
const LabelExtensionSchema = z.string().max(64);
const MAX_TITLE_LENGTH = 256;

const DownloadWidgetSchema = z.union([
    z.object({ label: z.string().min(1).max(256), ext: LabelExtensionSchema })
        .strict(),
    z.object({ itag: z.number().int().positive(), ext: ItagExtensionSchema })
        .strict(),
]);

type DownloadWidget = z.infer<typeof DownloadWidgetSchema>;

export default function getDownloadHandler(app: Hono) {
    async function handler(c: Context<{ Variables: HonoVariables }>) {
        let body: FormData;
        try {
            body = await c.req.formData();
        } catch {
            throw new HTTPException(400, {
                res: new Response("Invalid form data."),
            });
        }

        const rawVideoId = body.get("id")?.toString();
        if (rawVideoId == undefined) {
            throw new HTTPException(400, {
                res: new Response("Please specify the video ID"),
            });
        }
        const videoId = requireValidVideoId(rawVideoId);

        const config = c.get("config");
        const check = c.req.query("check");

        requireTokenMinter(c);
        await requireVerifiedCheck(c, videoId);

        const title = body.get("title")?.toString();

        let downloadWidgetData: DownloadWidget;

        try {
            downloadWidgetData = JSON.parse(
                body.get("download_widget")?.toString() || "",
            );
        } catch {
            throw new HTTPException(400, {
                res: new Response("Invalid download_widget json"),
            });
        }

        const isValidTitle = !!title && title.length <= MAX_TITLE_LENGTH;
        if (
            !isValidTitle ||
            !DownloadWidgetSchema.safeParse(downloadWidgetData).success
        ) {
            throw new HTTPException(400, {
                res: new Response("Invalid form data required for download"),
            });
        }

        if ("label" in downloadWidgetData) {
            const captionsQuery = new URLSearchParams();
            captionsQuery.set("label", downloadWidgetData.label);
            // Forward the check param so the internal captions request also
            // passes verifyRequest when verify_requests is enabled.
            if (check) captionsQuery.set("check", check);
            const captionsResponse = await app.request(
                `${config.server.base_path}/api/v1/captions/${videoId}?${captionsQuery.toString()}`,
            );
            // The captions route is shared with the player's <track> element,
            // so it must not mark its own response as an attachment. Add the
            // header here instead, where we know the request came from the
            // download widget — which is also the only place that knows the
            // filename, since `ext` ("<lang>.vtt") never reaches that route.
            // Only a successful response is a file; a 404 body is not.
            if (!captionsResponse.ok) {
                return captionsResponse;
            }
            const headers = new Headers(captionsResponse.headers);
            headers.set(
                "content-disposition",
                attachmentContentDisposition(
                    `${title}-${videoId}.${downloadWidgetData.ext}`,
                ),
            );
            return new Response(captionsResponse.body, {
                status: captionsResponse.status,
                statusText: captionsResponse.statusText,
                headers,
            });
        } else {
            const itag = downloadWidgetData.itag;
            const ext = downloadWidgetData.ext;
            const filename = `${title}-${videoId}.${ext}`;

            const urlQueriesForLatestVersion = new URLSearchParams();
            urlQueriesForLatestVersion.set("id", videoId);
            // Forward the check param so the internal latest_version request
            // also passes verifyRequest when verify_requests is enabled,
            // matching the captions branch above.
            if (check) urlQueriesForLatestVersion.set("check", check);
            urlQueriesForLatestVersion.set("itag", itag.toString());
            // "title" for compatibility with how Invidious sets the content disposition header
            // in /videoplayback and /latest_version
            urlQueriesForLatestVersion.set(
                "title",
                filename,
            );
            urlQueriesForLatestVersion.set("local", "true");

            return await app.request(
                `${config.server.base_path}/latest_version?${urlQueriesForLatestVersion.toString()}`,
            );
        }
    }

    return handler;
}
