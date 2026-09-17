import { ApiResponse, Innertube, YT } from "youtubei.js";
import { generateRandomString } from "youtubei.js/Utils";
import type { TokenMinter } from "../jobs/potoken.ts";
import { Metrics } from "./metrics.ts";
import { resolveAndValidatePlayerReqLocation } from "./dynamicImportValidation.ts";
import type { Config } from "./config.ts";
import { getKv } from "./kv.ts";
import {
    readCachedPlayerResponse,
    videoCacheKey,
    writePlayerCache,
} from "./playerCache.ts";
import {
    decipherStreamingData,
    DEFAULT_STREAMING_DATA_CLIENTS,
    type RawStreamingData,
    type StreamingDataClients,
} from "./playerDecipher.ts";

const youtubePlayerReqLocation = resolveAndValidatePlayerReqLocation();
const { youtubePlayerReq } = await import(youtubePlayerReqLocation);

export type PlayerReqFn = (
    innertubeClient: Innertube,
    videoId: string,
    config: Config,
    tokenMinter: TokenMinter,
) => Promise<ApiResponse>;

const TRIMMED_KEYS = [
    "captions",
    "playabilityStatus",
    "storyboards",
    "streamingData",
    "videoDetails",
    "microformat",
] as const;

export type TrimmedPlayerResponse = {
    [K in typeof TRIMMED_KEYS[number]]: unknown;
};

/**
 * Reduce a raw player response to the fields Invidious consumes. Applied to
 * every response, including ERROR ones, so nothing else (responseContext,
 * tracking params, our internal streamingDataClients tag) leaves the process.
 */
export function trimPlayerResponse(
    videoData: Record<string, unknown>,
): TrimmedPlayerResponse {
    return Object.fromEntries(
        TRIMMED_KEYS.map((key) => [key, videoData[key]]),
    ) as TrimmedPlayerResponse;
}

// Tracks in-progress upstream player fetches so concurrent requests for the
// same videoId AND session generation share a single YouTube round-trip
// instead of stampeding. Keyed by generation too: during a session
// regeneration a caller on the new generation must not be handed (or have
// its result attributed to) an in-flight fetch started under the old one —
// that fetch's deciphered URLs embed the old session's PO token/egress IP.
const inFlightPlayerRequests = new Map<string, Promise<object>>();

function inFlightKey(cacheGeneration: number, videoId: string): string {
    return `${cacheGeneration}:${videoId}`;
}

async function decipherIfPlayable(
    innertubeClient: Innertube,
    response: ApiResponse,
): Promise<RawStreamingData | undefined> {
    const videoData = response.data;
    if (
        videoData.playabilityStatus?.status === "ERROR" ||
        !videoData.streamingData
    ) {
        return videoData.streamingData;
    }
    // YT.VideoInfo parses the formats (signature/nsig aware). Its constructor
    // throws for ERROR responses, hence the guard above.
    const video = new YT.VideoInfo(
        [response],
        innertubeClient.actions,
        generateRandomString(16),
    );
    if (!video.streaming_data) return videoData.streamingData;
    const clients: StreamingDataClients = videoData.streamingDataClients ??
        DEFAULT_STREAMING_DATA_CLIENTS;
    return await decipherStreamingData(
        video.streaming_data,
        videoData.streamingData,
        {
            player: innertubeClient.session.player,
            sessionPoToken: innertubeClient.session.po_token,
            clients,
        },
    );
}

export const youtubePlayerParsing = async ({
    innertubeClient,
    videoId,
    config,
    tokenMinter,
    metrics,
    overrideCache = false,
    cacheGeneration = 0,
    deps = {},
}: {
    innertubeClient: Innertube;
    videoId: string;
    config: Config;
    tokenMinter: TokenMinter;
    metrics: Metrics | undefined;
    overrideCache?: boolean;
    /** Session generation the result is cached under (see main.ts). */
    cacheGeneration?: number;
    /** Test seam: inject the upstream fetch and/or the KV handle. */
    deps?: { playerReq?: PlayerReqFn; kv?: Deno.Kv };
}): Promise<object> => {
    const cacheEnabled = overrideCache ? false : config.cache.enabled;
    // Only open the store when it will be used: cache.enabled=false and
    // forced-fresh fetches must not create/open the SQLite file per request.
    const kv = cacheEnabled ? deps.kv ?? await getKv(config) : null;
    const cacheKey = videoCacheKey(cacheGeneration, videoId);

    if (kv) {
        const cached = await readCachedPlayerResponse(kv, cacheKey);
        if (cached) {
            metrics?.cacheHit.inc();
            return cached;
        }
    }

    // Single-flight: collapse concurrent cache-miss fetches for the same
    // videoId AND generation into one upstream request. Skipped for
    // overrideCache (a forced fresh fetch, e.g. PO-token validation), which
    // must not reuse a shared result.
    const flightKey = inFlightKey(cacheGeneration, videoId);
    if (!overrideCache) {
        const existing = inFlightPlayerRequests.get(flightKey);
        if (existing) return existing;
    }

    const fetchFresh = async (): Promise<object> => {
        if (kv) metrics?.cacheMiss.inc();
        const playerReq: PlayerReqFn = deps.playerReq ?? youtubePlayerReq;
        const response = await playerReq(
            innertubeClient,
            videoId,
            config,
            tokenMinter,
        );
        const videoData = response.data;
        const streamingData = await decipherIfPlayable(
            innertubeClient,
            response,
        );
        const trimmed = trimPlayerResponse({ ...videoData, streamingData });

        if (videoData.playabilityStatus?.status === "OK") {
            metrics?.innertubeSuccessfulRequest.inc();
            if (kv) {
                void writePlayerCache(
                    kv,
                    cacheKey,
                    trimmed,
                    config.cache.ttl_seconds || 3600,
                );
            }
        } else {
            metrics?.checkInnertubeResponse(videoData);
            // Negative cache: briefly remember non-OK responses (ERROR,
            // unplayable, login-required, …) so a client re-requesting an
            // unavailable video doesn't re-hit YouTube on every call. Kept
            // short so a genuine recovery (e.g. after a session regen) is
            // picked up soon.
            const negativeTtl = config.cache.negative_ttl_seconds;
            if (kv && negativeTtl > 0) {
                void writePlayerCache(kv, cacheKey, trimmed, negativeTtl);
            }
        }
        return trimmed;
    };

    if (overrideCache) {
        return await fetchFresh();
    }

    const fetchPromise = fetchFresh();
    inFlightPlayerRequests.set(flightKey, fetchPromise);
    try {
        return await fetchPromise;
    } finally {
        inFlightPlayerRequests.delete(flightKey);
    }
};

/**
 * Build a youtubei.js VideoInfo from a trimmed player response. Throws
 * `InnertubeError("This video is unavailable")` for ERROR responses (YouTube.js
 * v18 MediaInfo constructor) — callers must check the status first, see
 * `assertPlayable` in playability.ts.
 */
export const youtubeVideoInfo = (
    innertubeClient: Innertube,
    youtubePlayerResponseJson: object,
): YT.VideoInfo => {
    const playerResponse = {
        success: true,
        status_code: 200,
        data: youtubePlayerResponseJson,
    } as ApiResponse;
    return new YT.VideoInfo(
        [playerResponse],
        innertubeClient.actions,
        "",
    );
};
