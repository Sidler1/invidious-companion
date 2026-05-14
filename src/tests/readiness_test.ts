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
