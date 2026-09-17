import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { validateVideoId } from "../lib/helpers/validateVideoId.ts";
import { verifyRequest } from "../lib/helpers/verifyRequest.ts";
import { TOKEN_MINTER_NOT_READY_MESSAGE } from "../constants.ts";
import type { HonoVariables } from "../lib/types/HonoVariables.ts";

/**
 * Request guards shared by every Invidious-facing route. Each guard throws
 * the exact HTTPException the routes used to build inline, so status codes
 * and bodies stay byte-identical for Invidious. Call them in this order:
 *
 *   const videoId = requireValidVideoId(...);
 *   requireTokenMinter(c);
 *   await requireVerifiedCheck(c, videoId);
 */
export type GuardContext = Context<{ Variables: HonoVariables }>;

export function requireValidVideoId(videoId: string | undefined): string {
    if (!videoId || !validateVideoId(videoId)) {
        throw new HTTPException(400, {
            res: new Response("Invalid video ID format."),
        });
    }
    return videoId;
}

/** 503 while the PO-token minter is still bootstrapping (if PO tokens are on). */
export function requireTokenMinter(c: GuardContext): void {
    const config = c.get("config");
    if (config.jobs.youtube_session.po_token_enabled && !c.get("tokenMinter")) {
        throw new HTTPException(503, {
            res: new Response(TOKEN_MINTER_NOT_READY_MESSAGE),
        });
    }
}

/**
 * Enforce the signed `check` parameter when server.verify_requests is on.
 * An empty `check=` is treated as an invalid token (the old inline code
 * skipped verification for it).
 */
export async function requireVerifiedCheck(
    c: GuardContext,
    videoId: string,
): Promise<void> {
    const config = c.get("config");
    if (!config.server.verify_requests) {
        return;
    }
    const check = c.req.query("check");
    if (check == undefined) {
        c.get("metrics")?.verifyRequestFailures.inc();
        throw new HTTPException(400, {
            res: new Response("No check ID."),
        });
    }
    if (await verifyRequest(check, videoId, config) === false) {
        c.get("metrics")?.verifyRequestFailures.inc();
        throw new HTTPException(400, {
            res: new Response("ID incorrect."),
        });
    }
}
