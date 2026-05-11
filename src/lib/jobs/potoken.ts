import { Innertube } from "youtubei.js";
import {
    youtubePlayerParsing,
    youtubeVideoInfo,
} from "../helpers/youtubePlayerHandling.ts";
import type { Config } from "../helpers/config.ts";
import { Metrics } from "../helpers/metrics.ts";
import { CTX, logError, logInfo, logWarn } from "../helpers/log.ts";

let getFetchClientLocation = "getFetchClient";
if (Deno.env.get("GET_FETCH_CLIENT_LOCATION")) {
    if (Deno.env.has("DENO_COMPILED")) {
        getFetchClientLocation = Deno.mainModule.replace("src/main.ts", "") +
            Deno.env.get("GET_FETCH_CLIENT_LOCATION");
    } else {
        getFetchClientLocation = Deno.env.get(
            "GET_FETCH_CLIENT_LOCATION",
        ) as string;
    }
}
const { getFetchClient } = await import(getFetchClientLocation);

import { InputMessage, OutputMessageSchema } from "./worker.ts";

interface TokenGeneratorWorker extends Omit<Worker, "postMessage"> {
    postMessage(message: InputMessage): void;
}

const workers: TokenGeneratorWorker[] = [];

function createMinter(worker: TokenGeneratorWorker) {
    return (videoId: string): Promise<string> => {
        const { promise, resolve } = Promise.withResolvers<string>();
        const requestId = crypto.randomUUID();
        const listener = (message: MessageEvent) => {
            const parsedMessage = OutputMessageSchema.parse(message.data);
            if (
                parsedMessage.type === "content-token" &&
                parsedMessage.requestId === requestId
            ) {
                worker.removeEventListener("message", listener);
                resolve(parsedMessage.contentToken);
            }
        };
        worker.addEventListener("message", listener);
        worker.postMessage({
            type: "content-token-request",
            videoId,
            requestId,
        });

        return promise;
    };
}

export type TokenMinter = ReturnType<typeof createMinter>;

// Adapted from https://github.com/LuanRT/BgUtils/blob/main/examples/node/index.ts
export const poTokenGenerate = (
    config: Config,
    metrics: Metrics | undefined,
): Promise<{ innertubeClient: Innertube; tokenMinter: TokenMinter }> => {
    const { promise, resolve, reject } = Promise.withResolvers<
        Awaited<ReturnType<typeof poTokenGenerate>>
    >();

    const worker: TokenGeneratorWorker = new Worker(
        new URL("./worker.ts", import.meta.url).href,
        {
            type: "module",
            name: "PO Token Generator",
        },
    );
    workers.push(worker);
    worker.addEventListener("message", async (event) => {
        const parsedMessage = OutputMessageSchema.parse(event.data);

        if (parsedMessage.type === "ready") {
            const untypedPostMessage = worker.postMessage.bind(worker);
            worker.postMessage = (message: InputMessage) =>
                untypedPostMessage(message);
            worker.postMessage({ type: "initialise", config });
        }

        if (parsedMessage.type === "error") {
            logError(CTX.PO_TOKEN, `Worker error: ${parsedMessage.error}`);
            worker.terminate();
            reject(parsedMessage.error);
        }

        if (parsedMessage.type === "initialised") {
            try {
                const instantiatedInnertubeClient = await Innertube.create({
                    enable_session_cache: false,
                    po_token: parsedMessage.sessionPoToken,
                    visitor_data: parsedMessage.visitorData,
                    fetch: getFetchClient(config),
                    generate_session_locally: true,
                    cookie: config.youtube_session.cookies || undefined,
                    player_id: config.youtube_session.player_id,
                });
                const minter = createMinter(worker);
                await checkToken({
                    instantiatedInnertubeClient,
                    config,
                    integrityTokenBasedMinter: minter,
                    metrics,
                });
                logInfo(CTX.PO_TOKEN, "Successfully generated");
                const numberToKill = workers.length - 1;
                for (let i = 0; i < numberToKill; i++) {
                    const workerToKill = workers.shift();
                    workerToKill?.terminate();
                }
                return resolve({
                    innertubeClient: instantiatedInnertubeClient,
                    tokenMinter: minter,
                });
            } catch (err) {
                logWarn(
                    CTX.PO_TOKEN,
                    `Failed to get valid token, will retry: ${err}`,
                );
                worker.terminate();
                reject(err);
            }
        }
    });

    return promise;
};

async function checkToken({
    instantiatedInnertubeClient,
    config,
    integrityTokenBasedMinter,
    metrics,
}: {
    instantiatedInnertubeClient: Innertube;
    config: Config;
    integrityTokenBasedMinter: TokenMinter;
    metrics: Metrics | undefined;
}) {
    const fetchImpl = getFetchClient(config);

    try {
        logInfo(CTX.PO_TOKEN, "Searching for videos to validate token");
        const searchResults = await instantiatedInnertubeClient.search("news", {
            type: "video",
            upload_date: "week",
            duration: "three_to_twenty_mins",
        });

        const videos = searchResults.videos
            .filter((video) =>
                video.type === "Video" && "id" in video && video.id
            )
            .map((value) => ({ value, sort: Math.random() }))
            .sort((a, b) => a.sort - b.sort)
            .map(({ value }) => value);

        if (videos.length === 0) {
            new Error("No videos with valid IDs found in search results");
        }

        const maxAttempts = Math.min(3, videos.length);
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const video = videos[attempt];

            try {
                if (!("id" in video) || !video.id) {
                    continue;
                }

                logInfo(
                    CTX.PO_TOKEN,
                    `Validating with video ${video.id} (${
                        attempt + 1
                    }/${maxAttempts})`,
                );

                const youtubePlayerResponseJson = await youtubePlayerParsing({
                    innertubeClient: instantiatedInnertubeClient,
                    videoId: video.id,
                    config,
                    tokenMinter: integrityTokenBasedMinter,
                    metrics,
                    overrideCache: true,
                });

                const videoInfo = youtubeVideoInfo(
                    instantiatedInnertubeClient,
                    youtubePlayerResponseJson,
                );

                const validFormat = videoInfo.streaming_data
                    ?.adaptive_formats[0];
                if (!validFormat) {
                    logWarn(
                        CTX.PO_TOKEN,
                        `No valid format for ${video.id}, trying next`,
                    );
                    continue;
                }

                const result = await fetchImpl(validFormat?.url, {
                    method: "HEAD",
                });

                if (result.status !== 200) {
                    logWarn(
                        CTX.PO_TOKEN,
                        `Got ${result.status} for ${video.id}, trying next`,
                    );
                } else {
                    logInfo(CTX.PO_TOKEN, `Validated with video ${video.id}`);
                    return;
                }
            } catch (err) {
                const videoId = ("id" in video && video.id) ? video.id : "?";
                logWarn(
                    CTX.PO_TOKEN,
                    `Validation failed for ${videoId}: ${err}`,
                );
                if (attempt === maxAttempts - 1) {
                    new Error(
                        "Failed to validate PO token with any available videos",
                    );
                }
            }
        }
        new Error(
            "Failed to validate PO token: all validation attempts returned non-200 status codes",
        );
    } catch (err) {
        logWarn(CTX.PO_TOKEN, `Validation failed: ${err}`);
        throw err;
    }
}

export function cleanupWorkers(): void {
    if (workers.length === 0) {
        return;
    }
    logInfo(
        CTX.PO_TOKEN,
        `Cleaning up ${workers.length} worker(s) for shutdown`,
    );
    while (workers.length > 0) {
        const worker = workers.shift();
        if (worker) {
            try {
                worker.terminate();
            } catch (err) {
                logError(CTX.PO_TOKEN, "Failed to terminate worker", err);
            }
        }
    }
}
