import { ApiResponse, Innertube } from "youtubei.js";
import NavigationEndpoint from "youtubei.js/NavigationEndpoint";
import type { TokenMinter } from "../jobs/potoken.ts";

import type { Config } from "./config.ts";
import { CTX, logWarn } from "./log.ts";

// A bot-block typically surfaces as a 200 OK with playabilityStatus
// LOGIN_REQUIRED and a "confirm you're not a bot" / "protect our community"
// message — distinct from a genuine age/region restriction. We only fall back
// to other clients on these signals (not on every LOGIN_REQUIRED) to avoid
// hammering YouTube for videos that are legitimately restricted.
// deno-lint-ignore no-explicit-any
function isBotBlock(data: any): boolean {
    const ps = data?.playabilityStatus;
    if (!ps) return false;
    const subreasonRuns = ps.errorScreen?.playerErrorMessageRenderer?.subreason
        ?.runs;
    const subreasonText = Array.isArray(subreasonRuns)
        // deno-lint-ignore no-explicit-any
        ? subreasonRuns.map((r: any) => r?.text ?? "").join(" ")
        : "";
    const haystack = `${ps.reason ?? ""} ${subreasonText}`.toLowerCase();
    return haystack.includes("not a bot") ||
        haystack.includes("protect our community");
}

function callWatchEndpoint(
    videoId: string,
    innertubeClient: Innertube,
    innertubeClientType: string,
    contentPoToken: string,
) {
    const watch_endpoint = new NavigationEndpoint({
        watchEndpoint: {
            videoId: videoId,
            // Allow companion to gather sensitive content videos like
            // `VuSU7PcEKpU`
            racyCheckOk: true,
            contentCheckOk: true,
        },
    });

    return watch_endpoint.call(
        innertubeClient.actions,
        {
            playbackContext: {
                contentPlaybackContext: {
                    vis: 0,
                    splay: false,
                    lactMilliseconds: "-1",
                    signatureTimestamp: innertubeClient.session.player
                        ?.signature_timestamp,
                },
            },
            serviceIntegrityDimensions: {
                poToken: contentPoToken,
            },
            client: innertubeClientType,
        },
    );
}

export const youtubePlayerReq = async (
    innertubeClient: Innertube,
    videoId: string,
    config: Config,
    tokenMinter: TokenMinter,
): Promise<ApiResponse> => {
    const innertubeClientOauthEnabled = config.youtube_session.oauth_enabled;

    let innertubeClientUsed = "WEB";
    if (innertubeClientOauthEnabled) {
        innertubeClientUsed = "TV";
    }

    const contentPoToken = await tokenMinter(videoId);

    const youtubePlayerResponse = await callWatchEndpoint(
        videoId,
        innertubeClient,
        innertubeClientUsed,
        contentPoToken,
    );

    // Fall back to other YT clients when the primary (WEB) response is either
    // missing adaptive-format URLs OR has been bot-blocked. The bot-block case
    // is new: previously a "confirm you're not a bot" response was returned
    // as-is, even though another client often still serves the video.
    const noAdaptiveUrl = !!youtubePlayerResponse.data.streamingData &&
        youtubePlayerResponse.data.streamingData.adaptiveFormats?.[0]?.url ===
            undefined;
    const botBlocked = isBotBlock(youtubePlayerResponse.data);

    if (!innertubeClientOauthEnabled && (noAdaptiveUrl || botBlocked)) {
        logWarn(
            CTX.PLAYER,
            botBlocked
                ? "Bot-block detected on WEB client, falling back to other YT clients"
                : "No URLs for adaptive formats, falling back to other YT clients",
        );
        const innertubeClientsTypeFallback = [
            "TV_SIMPLY",
            "ANDROID_VR",
            "MWEB",
        ];

        for await (const innertubeClientType of innertubeClientsTypeFallback) {
            logWarn(
                CTX.PLAYER,
                `Trying fallback client ${innertubeClientType}`,
            );
            const youtubePlayerResponseFallback = await callWatchEndpoint(
                videoId,
                innertubeClient,
                innertubeClientType,
                contentPoToken,
            );
            const fallbackStreaming =
                youtubePlayerResponseFallback.data.streamingData;
            if (
                fallbackStreaming && (
                    fallbackStreaming.adaptiveFormats?.[0]?.url ||
                    fallbackStreaming.adaptiveFormats?.[0]?.signatureCipher
                )
            ) {
                if (youtubePlayerResponse.data.streamingData) {
                    youtubePlayerResponse.data.streamingData.adaptiveFormats =
                        fallbackStreaming.adaptiveFormats;
                } else {
                    // Original (bot-blocked) response had no streaming data —
                    // adopt the fallback's wholesale.
                    youtubePlayerResponse.data.streamingData =
                        fallbackStreaming;
                }
                // If the primary was bot-blocked, adopt the fallback's
                // playable status so downstream serves/caches the video.
                if (
                    youtubePlayerResponseFallback.data.playabilityStatus
                        ?.status === "OK"
                ) {
                    youtubePlayerResponse.data.playabilityStatus =
                        youtubePlayerResponseFallback.data.playabilityStatus;
                }
                break;
            }
        }
    }

    return youtubePlayerResponse;
};
