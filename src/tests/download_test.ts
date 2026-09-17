import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { assert, assertEquals } from "./deps.ts";
import getDownloadHandler from "../routes/invidious_routes/download.ts";
import type { HonoVariables } from "../lib/types/HonoVariables.ts";
import type { TokenMinter } from "../lib/jobs/potoken.ts";
import type { Config } from "../lib/helpers/config.ts";
import { makeTestConfig } from "./helpers/testConfig.ts";
import { makeCheck } from "./helpers/check.ts";

const VIDEO_ID = "jNQXAC9IVRw";
const DOWNLOAD_MAX_BODY_BYTES = 64 * 1024;
const stubMinter =
    ((_videoId: string) => Promise.resolve("pot")) as unknown as TokenMinter;

function buildApp(config: Config = makeTestConfig()) {
    const app = new Hono<{ Variables: HonoVariables }>();
    app.use("*", async (c, next) => {
        c.set("config", config);
        c.set("tokenMinter", stubMinter);
        c.set("metrics", undefined);
        await next();
    });
    // Stub the sibling routes the dispatcher forwards to; echo what they got,
    // including the forwarded `check` (when present) so tests can assert it
    // was passed through unchanged.
    app.get(
        "/companion/api/v1/captions/:videoId",
        (c) => {
            const check = c.req.query("check");
            const suffix = check ? ` check=${check}` : "";
            return c.text(
                `captions ${c.req.param("videoId")} ${
                    c.req.query("label")
                }${suffix}`,
            );
        },
    );
    app.get(
        "/companion/latest_version",
        (c) => c.text(`latest ${new URL(c.req.url).search}`),
    );
    app.post(
        "/companion/download",
        bodyLimit({ maxSize: DOWNLOAD_MAX_BODY_BYTES }),
        getDownloadHandler(app as unknown as Hono),
    );
    return app;
}

function formRequest(
    fields: Record<string, string>,
    query = "",
): Request {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
        form.set(key, value);
    }
    return new Request(`http://localhost/companion/download${query}`, {
        method: "POST",
        body: form,
    });
}

Deno.test("download rejects a non-multipart body with 400", async () => {
    const app = buildApp();
    const res = await app.request("http://localhost/companion/download", {
        method: "POST",
        body: "x",
        headers: { "content-type": "text/plain" },
    });
    assertEquals(res.status, 400);
    assertEquals(await res.text(), "Invalid form data.");
});

Deno.test("download requires the video id", async () => {
    const app = buildApp();
    const res = await app.request(formRequest({ title: "t" }));
    assertEquals(res.status, 400);
    assertEquals(await res.text(), "Please specify the video ID");
});

Deno.test("download dispatches a caption label to the captions route", async () => {
    const app = buildApp();
    const res = await app.request(formRequest({
        id: VIDEO_ID,
        title: "My Video",
        download_widget: JSON.stringify({ label: "English", ext: "en.vtt" }),
    }));
    assertEquals(res.status, 200);
    assertEquals(await res.text(), `captions ${VIDEO_ID} English`);
});

Deno.test("download dispatches a regional caption label to the captions route", async () => {
    const app = buildApp();
    const res = await app.request(formRequest({
        id: VIDEO_ID,
        title: "My Video",
        download_widget: JSON.stringify({
            label: "Spanish (Latin America)",
            ext: "es-419.vtt",
        }),
    }));
    assertEquals(res.status, 200);
    assertEquals(
        await res.text(),
        `captions ${VIDEO_ID} Spanish (Latin America)`,
    );
});

Deno.test("download dispatches an itag to latest_version with local=true", async () => {
    const app = buildApp();
    const res = await app.request(formRequest({
        id: VIDEO_ID,
        title: "My Video",
        download_widget: JSON.stringify({ itag: 18, ext: "mp4" }),
    }));
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.startsWith("latest ?"));
    const params = new URLSearchParams(body.slice("latest ".length));
    assertEquals(params.get("id"), VIDEO_ID);
    assertEquals(params.get("itag"), "18");
    assertEquals(params.get("local"), "true");
    assertEquals(params.get("title"), `My Video-${VIDEO_ID}.mp4`);
});

Deno.test("download rejects an itag-branch extension with unexpected characters", async () => {
    const app = buildApp();
    const res = await app.request(formRequest({
        id: VIDEO_ID,
        title: "My Video",
        download_widget: JSON.stringify({ itag: 18, ext: "MP4!" }),
    }));
    assertEquals(res.status, 400);
    assertEquals(await res.text(), "Invalid form data required for download");
});

Deno.test("download rejects an over-long label-branch extension", async () => {
    const app = buildApp();
    const res = await app.request(formRequest({
        id: VIDEO_ID,
        title: "My Video",
        download_widget: JSON.stringify({
            label: "English",
            ext: "x".repeat(65),
        }),
    }));
    assertEquals(res.status, 400);
    assertEquals(await res.text(), "Invalid form data required for download");
});

Deno.test("download rejects an over-long title", async () => {
    const app = buildApp();
    const res = await app.request(formRequest({
        id: VIDEO_ID,
        title: "x".repeat(300),
        download_widget: JSON.stringify({ itag: 18, ext: "mp4" }),
    }));
    assertEquals(res.status, 400);
    assertEquals(await res.text(), "Invalid form data required for download");
});

Deno.test("download rejects unparsable download_widget json", async () => {
    const app = buildApp();
    const res = await app.request(formRequest({
        id: VIDEO_ID,
        title: "t",
        download_widget: "{not json",
    }));
    assertEquals(res.status, 400);
    assertEquals(await res.text(), "Invalid download_widget json");
});

Deno.test("download rejects a body over the 64 KiB cap with 413", async () => {
    const app = buildApp();
    const res = await app.request(formRequest({
        id: VIDEO_ID,
        // Padding well past the cap; body-limit reads the stream up front
        // since this multipart body carries no Content-Length header.
        title: "x".repeat(DOWNLOAD_MAX_BODY_BYTES + 1024),
        download_widget: JSON.stringify({ itag: 18, ext: "mp4" }),
    }));
    assertEquals(res.status, 413);
});

Deno.test("download forwards a verified check to the captions route", async () => {
    const config = makeTestConfig({ server: { verify_requests: true } });
    const app = buildApp(config);
    const check = await makeCheck(VIDEO_ID, config);
    const res = await app.request(formRequest({
        id: VIDEO_ID,
        title: "My Video",
        download_widget: JSON.stringify({ label: "English", ext: "en.vtt" }),
    }, `?check=${encodeURIComponent(check)}`));
    assertEquals(res.status, 200);
    assertEquals(
        await res.text(),
        `captions ${VIDEO_ID} English check=${check}`,
    );
});

Deno.test("download forwards a verified check to the latest_version route", async () => {
    const config = makeTestConfig({ server: { verify_requests: true } });
    const app = buildApp(config);
    const check = await makeCheck(VIDEO_ID, config);
    const res = await app.request(formRequest({
        id: VIDEO_ID,
        title: "My Video",
        download_widget: JSON.stringify({ itag: 18, ext: "mp4" }),
    }, `?check=${encodeURIComponent(check)}`));
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.startsWith("latest ?"));
    const params = new URLSearchParams(body.slice("latest ".length));
    assertEquals(params.get("check"), check);
});
