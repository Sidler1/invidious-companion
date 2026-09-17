import { Hono } from "hono";
import { assertEquals } from "./deps.ts";
import {
    requireTokenMinter,
    requireValidVideoId,
    requireVerifiedCheck,
} from "../routes/guards.ts";
import type { HonoVariables } from "../lib/types/HonoVariables.ts";
import type { TokenMinter } from "../lib/jobs/potoken.ts";
import { TOKEN_MINTER_NOT_READY_MESSAGE } from "../constants.ts";
import { makeTestConfig } from "./helpers/testConfig.ts";
import { makeCheck } from "./helpers/check.ts";

const VIDEO_ID = "jNQXAC9IVRw";
const stubMinter =
    ((_videoId: string) => Promise.resolve("pot")) as unknown as TokenMinter;

function buildApp(
    options: { verifyRequests: boolean; minter: TokenMinter | undefined },
) {
    const config = makeTestConfig({
        server: { verify_requests: options.verifyRequests },
    });
    const app = new Hono<{ Variables: HonoVariables }>();
    app.use("*", async (c, next) => {
        c.set("config", config);
        c.set("tokenMinter", options.minter);
        c.set("metrics", undefined);
        await next();
    });
    app.get("/g/:videoId", async (c) => {
        const videoId = requireValidVideoId(c.req.param("videoId"));
        requireTokenMinter(c);
        await requireVerifiedCheck(c, videoId);
        return c.text("ok");
    });
    return { app, config };
}

async function expect(
    res: Response,
    status: number,
    body: string,
) {
    assertEquals(res.status, status);
    assertEquals(await res.text(), body);
}

Deno.test("guards reject a malformed video id with 400", async () => {
    const { app } = buildApp({ verifyRequests: false, minter: stubMinter });
    await expect(
        await app.request("/g/not-a-valid-id!"),
        400,
        "Invalid video ID format.",
    );
});

Deno.test("guards answer 503 while the token minter is not ready", async () => {
    const { app } = buildApp({ verifyRequests: false, minter: undefined });
    await expect(
        await app.request(`/g/${VIDEO_ID}`),
        503,
        TOKEN_MINTER_NOT_READY_MESSAGE,
    );
});

Deno.test("guards skip verification when verify_requests is off", async () => {
    const { app } = buildApp({ verifyRequests: false, minter: stubMinter });
    await expect(await app.request(`/g/${VIDEO_ID}`), 200, "ok");
});

Deno.test("guards require a check parameter when verify_requests is on", async () => {
    const { app } = buildApp({ verifyRequests: true, minter: stubMinter });
    await expect(await app.request(`/g/${VIDEO_ID}`), 400, "No check ID.");
});

Deno.test("guards reject an empty check parameter", async () => {
    const { app } = buildApp({ verifyRequests: true, minter: stubMinter });
    await expect(
        await app.request(`/g/${VIDEO_ID}?check=`),
        400,
        "ID incorrect.",
    );
});

Deno.test("guards reject a check signed for another video", async () => {
    const { app, config } = buildApp({
        verifyRequests: true,
        minter: stubMinter,
    });
    const check = await makeCheck("dQw4w9WgXcQ", config);
    await expect(
        await app.request(`/g/${VIDEO_ID}?check=${check}`),
        400,
        "ID incorrect.",
    );
});

Deno.test("guards accept a valid check", async () => {
    const { app, config } = buildApp({
        verifyRequests: true,
        minter: stubMinter,
    });
    const check = await makeCheck(VIDEO_ID, config);
    await expect(await app.request(`/g/${VIDEO_ID}?check=${check}`), 200, "ok");
});
