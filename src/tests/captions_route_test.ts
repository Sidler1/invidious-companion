import { Hono } from "hono";
import { assertEquals } from "./deps.ts";
import captionsHandler from "../routes/invidious_routes/captions.ts";
import type { HonoVariables } from "../lib/types/HonoVariables.ts";
import type { TokenMinter } from "../lib/jobs/potoken.ts";
import { TOKEN_MINTER_NOT_READY_MESSAGE } from "../constants.ts";
import { makeTestConfig } from "./helpers/testConfig.ts";

const VIDEO_ID = "jNQXAC9IVRw";
const stubMinter =
    ((_videoId: string) => Promise.resolve("pot")) as unknown as TokenMinter;

function buildApp(options: {
    captionsEnabled: boolean;
    minter: TokenMinter | undefined;
}) {
    const config = makeTestConfig({
        captions: { enabled: options.captionsEnabled },
        server: { verify_requests: false },
    });
    const app = new Hono<{ Variables: HonoVariables }>();
    app.use("*", async (c, next) => {
        c.set("config", config);
        c.set("tokenMinter", options.minter);
        c.set("metrics", undefined);
        await next();
    });
    app.route("/api/v1/captions", captionsHandler);
    return app;
}

Deno.test("captions route answers 503 when captions are disabled", async () => {
    const app = buildApp({ captionsEnabled: false, minter: stubMinter });
    const res = await app.request(`/api/v1/captions/${VIDEO_ID}`);
    assertEquals(res.status, 503);
    assertEquals(await res.text(), "Captions are disabled by administrator.");
});

Deno.test("captions route rejects a malformed video id with 400", async () => {
    const app = buildApp({ captionsEnabled: true, minter: stubMinter });
    const res = await app.request("/api/v1/captions/not-a-valid-id!");
    assertEquals(res.status, 400);
    assertEquals(await res.text(), "Invalid video ID format.");
});

Deno.test("captions route answers 503 while the token minter is not ready", async () => {
    const app = buildApp({ captionsEnabled: true, minter: undefined });
    const res = await app.request(`/api/v1/captions/${VIDEO_ID}`);
    assertEquals(res.status, 503);
    assertEquals(await res.text(), TOKEN_MINTER_NOT_READY_MESSAGE);
});
