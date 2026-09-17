import { Hono } from "hono";
import { assert, assertEquals } from "./deps.ts";
import getDownloadHandler from "../routes/invidious_routes/download.ts";
import type { HonoVariables } from "../lib/types/HonoVariables.ts";
import type { TokenMinter } from "../lib/jobs/potoken.ts";
import { makeTestConfig } from "./helpers/testConfig.ts";

const VIDEO_ID = "jNQXAC9IVRw";
const stubMinter =
    ((_videoId: string) => Promise.resolve("pot")) as unknown as TokenMinter;

function buildApp() {
    const config = makeTestConfig();
    const app = new Hono<{ Variables: HonoVariables }>();
    app.use("*", async (c, next) => {
        c.set("config", config);
        c.set("tokenMinter", stubMinter);
        c.set("metrics", undefined);
        await next();
    });
    // Stub the sibling routes the dispatcher forwards to; echo what they got.
    app.get(
        "/companion/api/v1/captions/:videoId",
        (c) =>
            c.text(
                `captions ${c.req.param("videoId")} ${c.req.query("label")}`,
            ),
    );
    app.get(
        "/companion/latest_version",
        (c) => c.text(`latest ${new URL(c.req.url).search}`),
    );
    app.post("/companion/download", getDownloadHandler(app as unknown as Hono));
    return app;
}

function formRequest(fields: Record<string, string>): Request {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
        form.set(key, value);
    }
    return new Request("http://localhost/companion/download", {
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
        download_widget: JSON.stringify({ label: "English", ext: "vtt" }),
    }));
    assertEquals(res.status, 200);
    assertEquals(await res.text(), `captions ${VIDEO_ID} English`);
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

Deno.test("download rejects an extension with unexpected characters", async () => {
    const app = buildApp();
    const res = await app.request(formRequest({
        id: VIDEO_ID,
        title: "My Video",
        download_widget: JSON.stringify({ itag: 18, ext: 'mp4"; x=' }),
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
