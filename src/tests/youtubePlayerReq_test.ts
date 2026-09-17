import { assertEquals } from "./deps.ts";
// Side-effect import: forces the "youtubei.js" main barrel to be evaluated
// before youtubePlayerReq.ts's `youtubei.js/NavigationEndpoint` submodule
// import runs. Without it, this file is the only real (non-type-only)
// consumer of "youtubei.js" in the whole graph, and youtubei.js@v18's
// classes have a circular-import initialization order that throws
// "Cannot access 'YTNode' before initialization" when NavigationEndpoint
// is the first thing to touch that graph. In the real app this is a
// non-issue because other modules (e.g. main.ts) import "youtubei.js" for
// real values well before any player request runs.
import "youtubei.js";
import type { Innertube } from "youtubei.js";
import { youtubePlayerReq } from "../lib/helpers/youtubePlayerReq.ts";
import type { Config } from "../lib/helpers/config.ts";

type Raw = Record<string, unknown>;

/** Innertube stub: NavigationEndpoint.call() ends in actions.execute(). */
function stubInnertube(responses: Record<string, Raw>): Innertube {
    return {
        actions: {
            execute: (_path: string, args: { client: string }) =>
                Promise.resolve({
                    success: true,
                    status_code: 200,
                    data: structuredClone(responses[args.client]),
                }),
        },
        session: { player: undefined },
    } as unknown as Innertube;
}

const config = {
    youtube_session: { oauth_enabled: false },
    jobs: { youtube_session: { player_fallback_clients: ["TV_SIMPLY"] } },
} as unknown as Config;

const tokenMinter = () => Promise.resolve("pot");

Deno.test("youtubePlayerReq streamingDataClients", async (t) => {
    await t.step(
        "tags the primary WEB client when no fallback runs",
        async () => {
            const client = stubInnertube({
                WEB: {
                    playabilityStatus: { status: "OK" },
                    streamingData: {
                        formats: [{ itag: 18, url: "https://h/18" }],
                        adaptiveFormats: [{ itag: 137, url: "https://h/137" }],
                    },
                },
            });

            const res = await youtubePlayerReq(
                client,
                "abcdefghijk",
                config,
                tokenMinter,
            );

            assertEquals(res.data.streamingDataClients, {
                formats: "WEB",
                adaptiveFormats: "WEB",
            });
        },
    );

    await t.step(
        "tags both arrays with the fallback client when it supplies both",
        async () => {
            const client = stubInnertube({
                WEB: {
                    playabilityStatus: { status: "OK" },
                    streamingData: {
                        formats: [{ itag: 18, signatureCipher: "s" }],
                        adaptiveFormats: [{ itag: 137 }],
                    },
                },
                TV_SIMPLY: {
                    playabilityStatus: { status: "OK" },
                    streamingData: {
                        formats: [{ itag: 18, url: "https://tv/18" }],
                        adaptiveFormats: [{ itag: 137, url: "https://tv/137" }],
                    },
                },
            });

            const res = await youtubePlayerReq(
                client,
                "abcdefghijk",
                config,
                tokenMinter,
            );

            assertEquals(res.data.streamingDataClients, {
                formats: "TV_SIMPLY",
                adaptiveFormats: "TV_SIMPLY",
            });
            assertEquals(
                res.data.streamingData?.formats?.[0].url,
                "https://tv/18",
            );
        },
    );

    await t.step(
        "keeps the primary tag for formats when the fallback returns none",
        async () => {
            const client = stubInnertube({
                WEB: {
                    playabilityStatus: { status: "OK" },
                    streamingData: {
                        formats: [{ itag: 18, signatureCipher: "s" }],
                        adaptiveFormats: [{ itag: 137 }],
                    },
                },
                TV_SIMPLY: {
                    playabilityStatus: { status: "OK" },
                    streamingData: {
                        adaptiveFormats: [{ itag: 137, url: "https://tv/137" }],
                    },
                },
            });

            const res = await youtubePlayerReq(
                client,
                "abcdefghijk",
                config,
                tokenMinter,
            );

            assertEquals(res.data.streamingDataClients, {
                formats: "WEB",
                adaptiveFormats: "TV_SIMPLY",
            });
            assertEquals(
                res.data.streamingData?.formats?.[0].signatureCipher,
                "s",
            );
        },
    );

    await t.step(
        "adopts the fallback wholesale when the primary had no streaming data",
        async () => {
            const client = stubInnertube({
                WEB: {
                    playabilityStatus: {
                        status: "LOGIN_REQUIRED",
                        reason: "Sign in to confirm you’re not a bot",
                    },
                },
                TV_SIMPLY: {
                    playabilityStatus: { status: "OK" },
                    streamingData: {
                        formats: [{ itag: 18, url: "https://tv/18" }],
                        adaptiveFormats: [{ itag: 137, url: "https://tv/137" }],
                    },
                },
            });

            const res = await youtubePlayerReq(
                client,
                "abcdefghijk",
                config,
                tokenMinter,
            );

            assertEquals(res.data.playabilityStatus?.status, "OK");
            assertEquals(res.data.streamingDataClients, {
                formats: "TV_SIMPLY",
                adaptiveFormats: "TV_SIMPLY",
            });
        },
    );
});
