import { Hono } from "hono";
import type { HonoVariables } from "../lib/types/HonoVariables.ts";

/**
 * Readiness probe endpoint.
 *
 * Unlike the liveness probe (/healthz) which always returns OK,
 * the readiness probe checks that required dependencies and state
 * are available before accepting traffic.
 *
 * Checks:
 * - innertubeClient is set in context (YouTube session is initialized)
 * - config is loaded
 */
const readiness = new Hono<{ Variables: HonoVariables }>();

readiness.get("/", (c) => {
    const checks: Record<string, boolean> = {};
    let allReady = true;

    // Check that config is loaded
    const config = c.get("config");
    checks["config_loaded"] = !!config;
    if (!config) allReady = false;

    // Check that innertube client is available
    const innertubeClient = c.get("innertubeClient");
    checks["innertube_client"] = !!innertubeClient;
    if (!innertubeClient) allReady = false;

    const status = allReady ? 200 : 503;
    return new Response(
        JSON.stringify({ ready: allReady, checks }),
        {
            status,
            headers: { "Content-Type": "application/json" },
        },
    );
});

export default readiness;
