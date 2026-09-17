import type { Context, Hono } from "hono";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import {
    requireTokenMinter,
    requireValidVideoId,
    requireVerifiedCheck,
} from "../guards.ts";
import type { HonoVariables } from "../../lib/types/HonoVariables.ts";

const DownloadWidgetSchema = z.union([
    z.object({ label: z.string(), ext: z.string() }).strict(),
    z.object({ itag: z.number(), ext: z.string() }).strict(),
]);

type DownloadWidget = z.infer<typeof DownloadWidgetSchema>;

export default function getDownloadHandler(app: Hono) {
    async function handler(c: Context<{ Variables: HonoVariables }>) {
        const body = await c.req.formData();

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

        const title = body.get("title");

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

        if (
            !(title && videoId &&
                DownloadWidgetSchema.safeParse(downloadWidgetData).success)
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
            return await app.request(
                `${config.server.base_path}/api/v1/captions/${videoId}?${captionsQuery.toString()}`,
            );
        } else {
            const itag = downloadWidgetData.itag;
            const ext = downloadWidgetData.ext;
            const filename = `${title}-${videoId}.${ext}`;

            const urlQueriesForLatestVersion = new URLSearchParams();
            urlQueriesForLatestVersion.set("id", videoId);
            urlQueriesForLatestVersion.set("check", check || "");
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
