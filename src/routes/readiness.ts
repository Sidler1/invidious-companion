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
 * - config is loaded
 * - innertubeClient is set in context (YouTube session is initialized)
 * - tokenMinter is ready when PO tokens are enabled (player/DASH/captions
 *   endpoints return 503 until it is, so we must not report ready before then)
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

    // When PO tokens are enabled, the token minter must be initialized before
    // the service can actually serve player/DASH/captions traffic.
    if (config?.jobs?.youtube_session?.po_token_enabled) {
        const tokenMinter = c.get("tokenMinter");
        checks["token_minter"] = !!tokenMinter;
        if (!tokenMinter) allReady = false;
    }

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
