import { assertEquals } from "./deps.ts";
import { Hono } from "hono";
import type { Innertube } from "youtubei.js";
import type { HonoVariables } from "../lib/types/HonoVariables.ts";
import type { Config } from "../lib/helpers/config.ts";
import player from "../routes/youtube_api_routes/player.ts";
import { TOKEN_MINTER_NOT_READY_MESSAGE } from "../constants.ts";

function buildApp(poTokenEnabled: boolean) {
    const config = {
        jobs: { youtube_session: { po_token_enabled: poTokenEnabled } },
        cache: { enabled: false, ttl_seconds: 0, negative_ttl_seconds: 0 },
    } as unknown as Config;
    const app = new Hono<{ Variables: HonoVariables }>();
    app.use("*", async (c, next) => {
        c.set("innertubeClient", {} as unknown as Innertube);
        c.set("tokenMinter", undefined);
        c.set("config", config);
        c.set("metrics", undefined);
        c.set("sessionGeneration", 0);
        await next();
    });
    app.route("/youtubei/v1", player);
    return app;
}

const post = (app: Hono<{ Variables: HonoVariables }>, body: string) =>
    app.request("/youtubei/v1/player", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
    });

Deno.test("POST /youtubei/v1/player body validation", async (t) => {
    const app = buildApp(false);

    await t.step("rejects malformed JSON with 400", async () => {
        const res = await post(app, "{not json");
        assertEquals(res.status, 400);
        assertEquals(await res.text(), "Invalid JSON body.");
    });

    await t.step("rejects a body without videoId with 400", async () => {
        const res = await post(app, "{}");
        assertEquals(res.status, 400);
        assertEquals(await res.text(), "Missing videoId in request body.");
    });

    await t.step("rejects a non-string videoId with 400", async () => {
        const res = await post(app, JSON.stringify({ videoId: 12345 }));
        assertEquals(res.status, 400);
        assertEquals(await res.text(), "Missing videoId in request body.");
    });

    await t.step("rejects a malformed videoId with 400", async () => {
        const res = await post(app, JSON.stringify({ videoId: "bad id!" }));
        assertEquals(res.status, 400);
        assertEquals(await res.text(), "Invalid video ID format.");
    });
});

Deno.test("POST /youtubei/v1/player reports a not-ready minter as ERROR JSON", async () => {
    const app = buildApp(true);
    const res = await post(app, JSON.stringify({ videoId: "jNQXAC9IVRw" }));

    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.playabilityStatus.status, "ERROR");
    assertEquals(json.playabilityStatus.reason, TOKEN_MINTER_NOT_READY_MESSAGE);
});
