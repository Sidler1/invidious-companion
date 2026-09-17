import { HTTPException } from "hono/http-exception";

export interface PlayabilityStatus {
    status?: string;
    reason?: string;
}

/** Read `playabilityStatus` from a raw/trimmed player response. */
export function getPlayabilityStatus(json: object): PlayabilityStatus {
    const ps = (json as { playabilityStatus?: PlayabilityStatus })
        .playabilityStatus;
    return { status: ps?.status, reason: ps?.reason };
}

/**
 * Route guard: 403 with the message Invidious expects when the video is not
 * playable. Must run BEFORE `youtubeVideoInfo()`, whose YouTube.js v18
 * constructor throws `InnertubeError` for ERROR responses.
 */
export function assertPlayable(videoId: string, json: object): void {
    const { status, reason } = getPlayabilityStatus(json);
    if (status === "OK") return;
    throw new HTTPException(403, {
        res: new Response(
            "The video can't be played: " + videoId + " due to reason: " +
                reason,
        ),
    });
}
