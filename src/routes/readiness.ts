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
 * - the minter minted successfully within session_lifetime_hours plus a
 *   grace margin (see READINESS_GRACE_MS below)
 */
// Grace margin added on top of session_lifetime_hours before the freshness
// check fails. The regeneration cron only reconsiders a stale session on its
// next tick (every 5 min by default) and a generation itself may take up to
// GENERATION_TIMEOUT_MS (2 min, see lib/jobs/potoken.ts) to complete, so an
// idle instance can legitimately run up to ~7 minutes past the lifetime
// before a fresh mint lands. Without this margin readiness flaps to 503 for
// that window on every regeneration.
const READINESS_GRACE_MS = 15 * 60 * 1000;

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
    // the service can actually serve player/DASH/captions traffic — and it
    // must have minted successfully within the session lifetime, otherwise a
    // minter whose worker died would keep reporting ready while every
    // playback request times out.
    if (config?.jobs?.youtube_session?.po_token_enabled) {
        const tokenMinter = c.get("tokenMinter");
        checks["token_minter"] = !!tokenMinter;
        if (!tokenMinter) allReady = false;

        const lifetimeHours =
            config.jobs.youtube_session.session_lifetime_hours;
        // lifetime 0 means "regenerate every tick"; no meaningful window.
        const windowMs = lifetimeHours > 0
            ? lifetimeHours * 60 * 60 * 1000 + READINESS_GRACE_MS
            : Number.POSITIVE_INFINITY;
        const lastMintOkMs = c.get("lastMintOkMs") ?? 0;
        const mintFresh = lastMintOkMs > 0 &&
            Date.now() - lastMintOkMs < windowMs;
        checks["token_mint_fresh"] = mintFresh;
        if (!mintFresh) allReady = false;
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
