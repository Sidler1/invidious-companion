import { Innertube, type UniversalCache } from "youtubei.js";
import { USER_AGENT } from "bgutils";
import {
    youtubePlayerParsing,
    youtubeVideoInfo,
} from "../helpers/youtubePlayerHandling.ts";
import type { Config } from "../helpers/config.ts";
import { Metrics } from "../helpers/metrics.ts";
import { CTX, logError, logInfo, logWarn } from "../helpers/log.ts";
import { resolveAndValidateFetchClientLocation } from "../helpers/dynamicImportValidation.ts";
import { registerWorker, releaseWorker } from "../session/workerRegistry.ts";

// Kept as a re-export so existing importers (main.ts, tests) keep working.
export { cleanupWorkers } from "../session/workerRegistry.ts";

const getFetchClientLocation = resolveAndValidateFetchClientLocation();
const { getFetchClient, getSessionEgressProxy } = await import(
    getFetchClientLocation
);

import { InputMessage, OutputMessageSchema } from "./worker.ts";

/**
 * The slice of the Worker API the generator uses. A structural interface so
 * tests can inject a fake instead of spawning worker.ts (which needs jsdom,
 * BotGuard and the network).
 */
export interface TokenGeneratorWorker {
    addEventListener(
        type: "message" | "messageerror",
        listener: (event: MessageEvent) => void,
    ): void;
    addEventListener(
        type: "error",
        listener: (event: ErrorEvent) => void,
    ): void;
    removeEventListener(
        type: "message",
        listener: (event: MessageEvent) => void,
    ): void;
    postMessage(message: InputMessage): void;
    terminate(): void;
}

// Upper bound on how long a single content-token mint may take. Without it, a
// worker that dies or stalls leaves the mint promise pending forever — and
// with request single-flighting that hung promise poisons the videoId for all
// later callers until restart.
const MINT_TIMEOUT_MS = 10_000;

// Upper bound for a whole session generation (worker boot, BotGuard
// attestation, integrity token, validation). A worker that never reports
// "initialised" would otherwise leave the caller's in-flight guard set
// forever and silently disable every later regeneration.
const GENERATION_TIMEOUT_MS = 120_000;

export function createMinter(
    worker: TokenGeneratorWorker,
    metrics: Metrics | undefined,
    timeoutMs: number = MINT_TIMEOUT_MS,
) {
    return (videoId: string): Promise<string> => {
        const { promise, resolve, reject } = Promise.withResolvers<string>();
        const requestId = crypto.randomUUID();

        const cleanup = () => {
            worker.removeEventListener("message", listener);
            clearTimeout(timer);
        };

        const listener = (message: MessageEvent) => {
            // Ignore messages that don't match the schema instead of throwing
            // inside the event listener; the mint timeout covers the case
            // where the expected reply never arrives in a valid shape.
            const parsed = OutputMessageSchema.safeParse(message.data);
            if (!parsed.success) return;
            const parsedMessage = parsed.data;
            if (
                parsedMessage.type === "content-token" &&
                parsedMessage.requestId === requestId
            ) {
                cleanup();
                resolve(parsedMessage.contentToken);
            } else if (
                parsedMessage.type === "error" &&
                parsedMessage.requestId === requestId
            ) {
                cleanup();
                metrics?.mintFailures.inc();
                reject(new Error(String(parsedMessage.error)));
            }
        };

        const timer = setTimeout(() => {
            cleanup();
            metrics?.mintTimeouts.inc();
            reject(
                new Error(
                    `Content-token mint timed out after ${timeoutMs}ms for ${videoId}`,
                ),
            );
        }, timeoutMs);

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

export interface PoTokenGenerateOptions {
    /** Overall generation timeout. Defaults to GENERATION_TIMEOUT_MS. */
    timeoutMs?: number;
    /** Test seam: supply a fake worker instead of spawning worker.ts. */
    createWorker?: () => TokenGeneratorWorker;
    /** Shared youtubei.js cache so the serving client reuses parsed player JS. */
    cache?: UniversalCache;
}

export interface GeneratedPoTokenSession {
    innertubeClient: Innertube;
    tokenMinter: TokenMinter;
    /** The worker that owns this session's minter. Terminated via the registry. */
    worker: TokenGeneratorWorker;
    /** Egress proxy the attestation was pinned to (null: direct / IPv6). */
    egressProxyUrl: string | null;
    // YouTube's estimated integrity-token TTL (seconds), forwarded from the
    // worker so the caller can refresh the session before it expires.
    sessionTtlSecs?: number;
}

const defaultCreateWorker = (): TokenGeneratorWorker =>
    new Worker(
        new URL("./worker.ts", import.meta.url).href,
        {
            type: "module",
            name: "PO Token Generator",
        },
    ) as unknown as TokenGeneratorWorker;

// Adapted from https://github.com/LuanRT/BgUtils/blob/main/examples/node/index.ts
export const poTokenGenerate = (
    config: Config,
    metrics: Metrics | undefined,
    options: PoTokenGenerateOptions = {},
): Promise<GeneratedPoTokenSession> => {
    const { promise, resolve, reject } = Promise.withResolvers<
        GeneratedPoTokenSession
    >();
    const timeoutMs = options.timeoutMs ?? GENERATION_TIMEOUT_MS;
    const worker = (options.createWorker ?? defaultCreateWorker)();
    registerWorker(worker);

    // Exactly one of fail/succeed settles the promise. fail() also releases
    // the worker; succeed() leaves it alive because the minter posts to it.
    let settled = false;
    const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(generationTimer);
        releaseWorker(worker);
        reject(err instanceof Error ? err : new Error(String(err)));
    };
    const succeed = (session: GeneratedPoTokenSession): void => {
        if (settled) return;
        settled = true;
        clearTimeout(generationTimer);
        resolve(session);
    };

    const generationTimer = setTimeout(() => {
        fail(new Error(`PO-token generation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // A worker-level failure (module load error, an exception outside the
    // worker's own try/catch) surfaces here, not as a message. Without this
    // listener it would either crash the process or leave us pending forever.
    worker.addEventListener("error", (event) => {
        event.preventDefault();
        logError(CTX.PO_TOKEN, `Worker crashed: ${event.message}`);
        fail(new Error(`PO-token worker crashed: ${event.message}`));
    });
    worker.addEventListener("messageerror", () => {
        fail(new Error("PO-token worker sent an unserialisable message"));
    });

    // Egress proxy the attestation is pinned to; the caller keys its per-proxy
    // session cache on this instead of re-resolving it after the fact.
    let egressProxyUrl: string | null = config.networking.proxy ?? null;

    worker.addEventListener("message", async (event) => {
        const parsed = OutputMessageSchema.safeParse(event.data);
        if (!parsed.success) {
            logError(
                CTX.PO_TOKEN,
                `Malformed message from worker: ${parsed.error}`,
            );
            fail(
                new Error(
                    `Malformed message from PO-token worker: ${parsed.error}`,
                ),
            );
            return;
        }
        const parsedMessage = parsed.data;

        if (parsedMessage.type === "ready") {
            worker.postMessage({
                type: "initialise",
                config: await pinWorkerConfig(config, (proxy) => {
                    egressProxyUrl = proxy;
                }),
            });
        }

        // Only fatal setup/initialise errors (no requestId) tear down the
        // worker. Per-request mint errors carry a requestId and are handled by
        // the dedicated listener in createMinter, so they must not kill the
        // whole session here.
        if (parsedMessage.type === "error" && !parsedMessage.requestId) {
            logError(CTX.PO_TOKEN, `Worker error: ${parsedMessage.error}`);
            fail(parsedMessage.error);
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
                    // Same UA/locale the worker attested under, and the shared
                    // cache so the player JS is not re-fetched per regen.
                    user_agent: USER_AGENT,
                    location: config.youtube_session.gl || undefined,
                    lang: config.youtube_session.hl || undefined,
                    cache: options.cache,
                });
                const minter = createMinter(worker, metrics);
                await checkToken({
                    instantiatedInnertubeClient,
                    config,
                    integrityTokenBasedMinter: minter,
                    metrics,
                });
                logInfo(CTX.PO_TOKEN, "Successfully generated");
                metrics?.poTokenGenerationSuccess.inc();
                succeed({
                    innertubeClient: instantiatedInnertubeClient,
                    tokenMinter: minter,
                    worker,
                    egressProxyUrl,
                    sessionTtlSecs: parsedMessage.estimatedTtlSecs,
                });
            } catch (err) {
                logWarn(
                    CTX.PO_TOKEN,
                    `Failed to get valid token, will retry: ${err}`,
                );
                fail(err);
            }
        }
    });

    return promise;
};

/**
 * Pin the worker's BotGuard attestation to the same egress proxy the request
 * path will use, so the visitor_data / PO token are minted from the IP that
 * later presents them. Only the failover proxy pool needs this; single-proxy
 * and direct are already consistent and IPv6 rotation is per-request by
 * design. Reports the chosen proxy through `onPinned`.
 */
async function pinWorkerConfig(
    config: Config,
    onPinned: (proxyUrl: string) => void,
): Promise<Config> {
    const pool = config.networking.proxy_pool;
    if (!pool.enabled || pool.proxies.length === 0) return config;
    try {
        const sessionProxy = await getSessionEgressProxy(config);
        if (!sessionProxy) return config;
        onPinned(sessionProxy);
        return {
            ...config,
            networking: {
                ...config.networking,
                proxy: sessionProxy,
                proxy_pool: { ...pool, enabled: false },
            },
        };
    } catch (err) {
        logWarn(CTX.PO_TOKEN, `Could not pin session egress proxy: ${err}`);
        return config;
    }
}

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
            throw new Error(
                "No videos with valid IDs found in search results",
            );
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
                    throw new Error(
                        "Failed to validate PO token with any available videos",
                    );
                }
            }
        }
        throw new Error(
            "Failed to validate PO token: all validation attempts returned non-200 status codes",
        );
    } catch (err) {
        logWarn(CTX.PO_TOKEN, `Validation failed: ${err}`);
        throw err;
    }
}
