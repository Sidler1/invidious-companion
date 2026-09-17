import { assertEquals } from "./deps.ts";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { metricsAuthFailureCounter } from "../routes/metricsAuthFailureCounter.ts";
import { Metrics } from "../lib/helpers/metrics.ts";
import type { HonoVariables } from "../lib/types/HonoVariables.ts";
import { TEST_SECRET_KEY } from "./helpers/testConfig.ts";

Deno.test("metricsAuthFailureCounter counts bearer-auth failures on /metrics", async () => {
    const metrics = new Metrics();

    // Typed app so c.set("metrics") type-checks without main.ts's global
    // ContextVariableMap augmentation being in this test's module graph
    // (see compactLogger_test.ts for the same pattern). The real exported
    // metricsAuthFailureCounter is a `MiddlewareHandler` (default `any` Env),
    // so it slots in unchanged — same code path as production's miscRoutes.
    const app = new Hono<{ Variables: HonoVariables }>();
    app.use("*", async (c, next) => {
        c.set("metrics", metrics);
        await next();
    });
    app.use("/metrics", metricsAuthFailureCounter);
    app.use("/metrics", bearerAuth({ token: TEST_SECRET_KEY }));
    app.get("/metrics", (c) => c.text("ok"));

    // No Authorization header at all.
    const noAuth = await app.request("/metrics");
    assertEquals(noAuth.status, 401);
    assertEquals((await metrics.authFailures.get()).values[0]?.value, 1);

    // Wrong bearer token: still rejected, still counted.
    const wrongAuth = await app.request("/metrics", {
        headers: { Authorization: "Bearer wrong-token" },
    });
    assertEquals(wrongAuth.status, 401);
    assertEquals((await metrics.authFailures.get()).values[0]?.value, 2);

    // Correct token: succeeds and must not bump the counter further.
    const okAuth = await app.request("/metrics", {
        headers: { Authorization: `Bearer ${TEST_SECRET_KEY}` },
    });
    assertEquals(okAuth.status, 200);
    assertEquals((await metrics.authFailures.get()).values[0]?.value, 2);
});
