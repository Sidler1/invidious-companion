import { ApiResponse, Innertube, YT } from "youtubei.js";
import { generateRandomString } from "youtubei.js/Utils";
import { compress, decompress } from "brotli";
import type { TokenMinter } from "../jobs/potoken.ts";
import { Metrics } from "./metrics.ts";
import { CTX, logError } from "./log.ts";
let youtubePlayerReqLocation = "youtubePlayerReq";
if (Deno.env.get("YT_PLAYER_REQ_LOCATION")) {
    if (Deno.env.has("DENO_COMPILED")) {
        youtubePlayerReqLocation = Deno.mainModule.replace("src/main.ts", "") +
            Deno.env.get("YT_PLAYER_REQ_LOCATION");
    } else {
        youtubePlayerReqLocation = Deno.env.get(
            "YT_PLAYER_REQ_LOCATION",
        ) as string;
    }
}
const { youtubePlayerReq } = await import(youtubePlayerReqLocation);

import type { Config } from "./config.ts";

let kvInstance: Deno.Kv | null = null;

async function getKv(): Promise<Deno.Kv> {
    if (!kvInstance) {
        kvInstance = await Deno.openKv();
    }
    return kvInstance;
}

// Tracks in-progress upstream player fetches so concurrent requests for the
// same videoId share a single YouTube round-trip instead of stampeding.
const inFlightPlayerRequests = new Map<string, Promise<object>>();

export const youtubePlayerParsing = async ({
    innertubeClient,
    videoId,
    config,
    tokenMinter,
    metrics,
    overrideCache = false,
}: {
    innertubeClient: Innertube;
    videoId: string;
    config: Config;
    tokenMinter: TokenMinter;
    metrics: Metrics | undefined;
    overrideCache?: boolean;
}): Promise<object> => {
    const cacheEnabled = overrideCache ? false : config.cache.enabled;
    const kv = await getKv();

    const cachedEntry = await kv.get(["video_cache", videoId]);
    const videoCached = cachedEntry.value as Uint8Array | null;

    if (videoCached != null && cacheEnabled) {
        metrics?.cacheHit.inc();
        try {
            return JSON.parse(
                new TextDecoder().decode(decompress(videoCached)),
            );
        } catch (err) {
            // Corrupted cache entry — delete it and fall through to fresh fetch
            logError(
                CTX.CACHE,
                `Decompression failed for ${videoId}, deleting corrupted entry`,
                err,
            );
            try {
                await kv.delete(["video_cache", videoId]);
            } catch (delErr) {
                logError(
                    CTX.CACHE,
                    `Failed to delete corrupted entry for ${videoId}`,
                    delErr,
                );
            }
            // Fall through to fresh fetch below
        }
    }

    // Single-flight: collapse concurrent cache-miss fetches for the same
    // videoId into one upstream request. Skipped for overrideCache (a forced
    // fresh fetch, e.g. PO-token validation), which must not reuse a shared
    // result.
    if (!overrideCache) {
        const existing = inFlightPlayerRequests.get(videoId);
        if (existing) return existing;
    }

    // Fresh fetch from YouTube (cache miss, disabled, or corrupted entry)
    const fetchFresh = async (): Promise<object> => {
        if (cacheEnabled) {
            metrics?.cacheMiss.inc();
        }
        const youtubePlayerResponse = await youtubePlayerReq(
            innertubeClient,
            videoId,
            config,
            tokenMinter,
        );
        const videoData = youtubePlayerResponse.data;

        if (videoData.playabilityStatus.status === "ERROR") {
            return videoData;
        }

        const video = new YT.VideoInfo(
            [youtubePlayerResponse],
            innertubeClient.actions,
            generateRandomString(16),
        );

        const streamingData = video.streaming_data;

        // Modify the original YouTube response to include deciphered URLs
        if (streamingData && videoData && videoData.streamingData) {
            const ecatcherServiceTracking = videoData.responseContext
                ?.serviceTrackingParams.find((o: { service: string }) =>
                    o.service === "ECATCHER"
                );
            const clientNameUsed = ecatcherServiceTracking?.params?.find((
                o: { key: string },
            ) => o.key === "client.name");
            // no need to decipher on IOS nor ANDROID
            if (
                !clientNameUsed?.value.includes("IOS") &&
                !clientNameUsed?.value.includes("ANDROID")
            ) {
                // The session PO token (minted from visitor_data) is the GVS
                // `pot` that web-family clients (WEB/MWEB/TV) must carry on the
                // `videoplayback` URL. youtubei.js's `Format.decipher()` only
                // descrambles the signature/nsig — it does NOT append `pot`
                // (that lives in the higher-level helpers we bypass here), so
                // without this the stream URLs go out unauthenticated and the
                // CDN throttles/403s them, forcing IP rotation. Undefined when
                // the PO-token job is disabled — then we skip it (web clients
                // generally won't have usable URLs in that mode anyway).
                const sessionPoToken = innertubeClient.session.po_token;

                const finalizeUrl = (url: string): string => {
                    let out = url.includes("alr=yes")
                        ? url.replace("alr=yes", "alr=no")
                        : `${url}&alr=no`;
                    if (sessionPoToken && !out.includes("pot=")) {
                        out += `&pot=${encodeURIComponent(sessionPoToken)}`;
                    }
                    return out;
                };

                for (
                    let index = 0;
                    index < streamingData.formats.length;
                    index++
                ) {
                    const format = videoData.streamingData.formats[index];

                    format.url = await streamingData.formats[index]
                        .decipher(
                            innertubeClient.session.player,
                        );
                    if (format.signatureCipher !== undefined) {
                        delete format.signatureCipher;
                    }
                    format.url = finalizeUrl(format.url);
                }
                for (
                    let index = 0;
                    index < streamingData.adaptive_formats.length;
                    index++
                ) {
                    const format =
                        videoData.streamingData.adaptiveFormats[index];

                    format.url = await streamingData.adaptive_formats[index]
                        .decipher(
                            innertubeClient.session.player,
                        );
                    if (format.signatureCipher !== undefined) {
                        delete format.signatureCipher;
                    }
                    format.url = finalizeUrl(format.url);
                }
            }
        }

        const videoOnlyNecessaryInfo = ((
            {
                captions,
                playabilityStatus,
                storyboards,
                streamingData,
                videoDetails,
                microformat,
            },
        ) => ({
            captions,
            playabilityStatus,
            storyboards,
            streamingData,
            videoDetails,
            microformat,
        }))(videoData);

        if (videoData.playabilityStatus?.status == "OK") {
            metrics?.innertubeSuccessfulRequest.inc();
            if (cacheEnabled) {
                const ttlMs = (config.cache.ttl_seconds || 3600) * 1000;
                (async () => {
                    try {
                        await kv.set(
                            ["video_cache", videoId],
                            compress(
                                new TextEncoder().encode(
                                    JSON.stringify(videoOnlyNecessaryInfo),
                                ),
                            ),
                            {
                                expireIn: ttlMs,
                            },
                        );
                    } catch (err) {
                        logError(
                            CTX.CACHE,
                            `Failed to write ${videoId} to cache`,
                            err,
                        );
                    }
                })();
            }
        } else {
            metrics?.checkInnertubeResponse(videoData);
            // Negative cache: briefly remember non-OK responses (unplayable,
            // login-required, etc.) so a client re-requesting an unavailable
            // video doesn't re-hit YouTube on every call. Kept short so a
            // genuine recovery (e.g. after a session regen) is picked up soon.
            const negativeTtl = config.cache.negative_ttl_seconds;
            if (cacheEnabled && negativeTtl > 0) {
                (async () => {
                    try {
                        await kv.set(
                            ["video_cache", videoId],
                            compress(
                                new TextEncoder().encode(
                                    JSON.stringify(videoOnlyNecessaryInfo),
                                ),
                            ),
                            { expireIn: negativeTtl * 1000 },
                        );
                    } catch (err) {
                        logError(
                            CTX.CACHE,
                            `Failed to write negative cache for ${videoId}`,
                            err,
                        );
                    }
                })();
            }
        }

        return videoOnlyNecessaryInfo;
    };

    if (overrideCache) {
        return await fetchFresh();
    }

    const fetchPromise = fetchFresh();
    inFlightPlayerRequests.set(videoId, fetchPromise);
    try {
        return await fetchPromise;
    } finally {
        inFlightPlayerRequests.delete(videoId);
    }
};

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
