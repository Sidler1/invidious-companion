import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { HonoVariables } from "../../lib/types/HonoVariables.ts";
import { youtubePlayerParsing } from "../../lib/helpers/youtubePlayerHandling.ts";
import { requireValidVideoId } from "../guards.ts";
import { TOKEN_MINTER_NOT_READY_MESSAGE } from "../../constants.ts";

// Invidious sends `{ "videoId": "<id>" }`; extra keys are tolerated.
const PlayerBodySchema = z.object({ videoId: z.string().min(1) })
    .passthrough();

const player = new Hono<{ Variables: HonoVariables }>();

player.post("/player", async (c) => {
    let rawBody: unknown;
    try {
        rawBody = await c.req.json();
    } catch {
        throw new HTTPException(400, {
            res: new Response("Invalid JSON body."),
        });
    }

    const innertubeClient = c.get("innertubeClient");
    const config = c.get("config");
    const metrics = c.get("metrics");
    const tokenMinter = c.get("tokenMinter");

    // Check if tokenMinter is ready (only needed when PO token is enabled)
    if (config.jobs.youtube_session.po_token_enabled && !tokenMinter) {
        return c.json({
            playabilityStatus: {
                status: "ERROR",
                reason: TOKEN_MINTER_NOT_READY_MESSAGE,
                errorScreen: {
                    playerErrorMessageRenderer: {
                        reason: {
                            simpleText: TOKEN_MINTER_NOT_READY_MESSAGE,
                        },
                        subreason: {
                            simpleText: TOKEN_MINTER_NOT_READY_MESSAGE,
                        },
                    },
                },
            },
        });
    }

    const parsed = PlayerBodySchema.safeParse(rawBody);
    if (!parsed.success) {
        throw new HTTPException(400, {
            res: new Response("Missing videoId in request body."),
        });
    }
    const videoId = requireValidVideoId(parsed.data.videoId);

    return c.json(
        await youtubePlayerParsing({
            innertubeClient,
            videoId,
            config,
            tokenMinter: tokenMinter!,
            metrics,
            cacheGeneration: c.get("sessionGeneration"),
        }),
    );
});

export default player;
