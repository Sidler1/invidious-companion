import { assertEquals } from "./deps.ts";
import { Hono } from "hono";
import type { HonoVariables } from "../lib/types/HonoVariables.ts";
import readiness from "../routes/readiness.ts";

Deno.test("Readiness endpoint - returns 503 when dependencies missing", async () => {
    const app = new Hono<{ Variables: HonoVariables }>();
    // Don't set innertubeClient or config — simulates not-ready state
    app.route("/readyz", readiness);

    const res = await app.request("/readyz");
    assertEquals(res.status, 503);
    const body = await res.json();
    assertEquals(body.ready, false);
});

Deno.test("Readiness endpoint - returns 200 when all dependencies present", async () => {
    const app = new Hono<{ Variables: HonoVariables }>();
    app.use("*", async (c, next) => {
        c.set("config" as never, { server: {} } as never);
        c.set("innertubeClient" as never, { fake: true } as never);
        await next();
    });
    app.route("/readyz", readiness);

    const res = await app.request("/readyz");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ready, true);
    assertEquals(body.checks.config_loaded, true);
    assertEquals(body.checks.innertube_client, true);
});

const HOUR_MS = 60 * 60 * 1000;

function appWithSession(
    { minter, lastMintOkMs }: { minter: boolean; lastMintOkMs: number },
) {
    const app = new Hono<{ Variables: HonoVariables }>();
    app.use("*", async (c, next) => {
        c.set(
            "config" as never,
            {
                server: {},
                jobs: {
                    youtube_session: {
                        po_token_enabled: true,
                        session_lifetime_hours: 6,
                    },
                },
            } as never,
        );
        c.set("innertubeClient" as never, { fake: true } as never);
        c.set(
            "tokenMinter" as never,
            (minter ? () => Promise.resolve("t") : undefined) as never,
        );
        c.set("lastMintOkMs" as never, lastMintOkMs as never);
        await next();
    });
    app.route("/readyz", readiness);
    return app;
}

Deno.test("Readiness endpoint - ready when the minter minted within the session lifetime", async () => {
    const app = appWithSession({ minter: true, lastMintOkMs: Date.now() });

    const res = await app.request("/readyz");

    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.checks.token_minter, true);
    assertEquals(body.checks.token_mint_fresh, true);
});

Deno.test("Readiness endpoint - not ready when the last mint is older than the session lifetime", async () => {
    const app = appWithSession({
        minter: true,
        lastMintOkMs: Date.now() - 7 * HOUR_MS,
    });

    const res = await app.request("/readyz");

    assertEquals(res.status, 503);
    const body = await res.json();
    assertEquals(body.checks.token_mint_fresh, false);
});

Deno.test("Readiness endpoint - not ready without a token minter when PO tokens are enabled", async () => {
    const app = appWithSession({ minter: false, lastMintOkMs: Date.now() });

    const res = await app.request("/readyz");

    assertEquals(res.status, 503);
    const body = await res.json();
    assertEquals(body.checks.token_minter, false);
});
