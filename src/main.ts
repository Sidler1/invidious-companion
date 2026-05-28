import { Hono } from "hono";
import { companionRoutes, miscRoutes } from "./routes/index.ts";
import { Innertube, Platform, UniversalCache } from "youtubei.js";
import {
    cleanupWorkers,
    poTokenGenerate,
    type TokenMinter,
} from "./lib/jobs/potoken.ts";
import { USER_AGENT } from "bgutils";
import { retry } from "@std/async";
import type { HonoVariables } from "./lib/types/HonoVariables.ts";
import { parseArgs } from "@std/cli/parse-args";
import { existsSync } from "@std/fs/exists";

import { parseConfig } from "./lib/helpers/config.ts";
import { Metrics } from "./lib/helpers/metrics.ts";
import { jsInterpreter } from "./lib/helpers/jsInterpreter.ts";
import { CTX, logError, logInfo, logWarn } from "./lib/helpers/log.ts";

const config = await parseConfig();

const args = parseArgs(Deno.args);

if (args._version_date && args._version_commit) {
    logInfo(
        CTX.SERVER,
        `Version ${args._version_date}-${args._version_commit}`,
    );
}

import { resolveAndValidateFetchClientLocation } from "./lib/helpers/dynamicImportValidation.ts";

const getFetchClientLocation = resolveAndValidateFetchClientLocation();
const { getFetchClient, setOnYouTubeBlock } = await import(
    getFetchClientLocation
);

declare module "hono" {
    interface ContextVariableMap extends HonoVariables {}
}

const app = new Hono({
    getPath: (req) => new URL(req.url).pathname,
});
const companionApp = new Hono({
    getPath: (req) => new URL(req.url).pathname,
}).basePath(config.server.base_path);
const metrics = config.server.enable_metrics ? new Metrics() : undefined;

let tokenMinter: TokenMinter | undefined;
let innertubeClient: Innertube;
let innertubeClientFetchPlayer = true;
const innertubeClientOauthEnabled = config.youtube_session.oauth_enabled;
const innertubeClientJobPoTokenEnabled =
    config.jobs.youtube_session.po_token_enabled;
const innertubeClientCookies = config.youtube_session.cookies;

/**
 * Holds the current Innertube client and token minter, which are swapped
 * together by the session-regeneration cron job. Reads and the swap are all
 * synchronous; because JS runs them on a single thread, a request handler can
 * never observe a half-updated (client, minter) pair as long as it reads both
 * without an `await` in between — which the request middleware does.
 */
const sharedState = {
    _client: null as Innertube | null,
    _minter: undefined as TokenMinter | undefined,

    getClient(): Innertube {
        return this._client ?? innertubeClient;
    },
    getMinter(): TokenMinter | undefined {
        // Once the cron job has set a client, its paired minter is the source
        // of truth (even when undefined); before then, fall back to the
        // module-level minter.
        return this._client ? this._minter : tokenMinter;
    },
    set(client: Innertube, minter: TokenMinter | undefined): void {
        this._client = client;
        this._minter = minter;
    },
};

// Promise that resolves when tokenMinter initialization is complete (for tests)
let tokenMinterReadyResolve: (() => void) | undefined;
export const tokenMinterReady = new Promise<void>((resolve) => {
    tokenMinterReadyResolve = resolve;
});

if (!innertubeClientOauthEnabled) {
    if (innertubeClientJobPoTokenEnabled) {
        logInfo(CTX.PO_TOKEN, "Job is active");
        // Don't fetch fetch player yet for po_token
        innertubeClientFetchPlayer = false;
    } else if (!innertubeClientJobPoTokenEnabled) {
        logInfo(CTX.PO_TOKEN, "Job is NOT active");
    }
}

Platform.shim.eval = jsInterpreter;

// PERFORMANCE IMPROVEMENT: Use persistent UniversalCache for player/session data
// This dramatically speeds up Innertube creation and the 5min cron regeneration
// (avoids re-downloading/deciphering player JS every time)
const cache = config.cache.enabled
    ? new UniversalCache(true, config.cache.directory)
    : undefined;

// Session lifecycle state. `sessionGeneratedAtMs` records the last successful
// full session generation; the scheduled cron uses it to skip the expensive
// BotGuard re-attestation (and visitor_data churn) while the session is still
// within its configured lifetime. The guards keep scheduled, lifetime, and
// block-triggered regenerations from overlapping or storming.
let sessionGeneratedAtMs = 0;
let sessionRegenInFlight = false;
let lastBlockRegenMs = 0;
const BLOCK_REGEN_COOLDOWN_MS = 60_000;

async function regenerateSession(reason: string): Promise<void> {
    if (sessionRegenInFlight) return;
    sessionRegenInFlight = true;
    try {
        if (innertubeClientJobPoTokenEnabled) {
            const result = await poTokenGenerate(config, metrics);
            sharedState.set(result.innertubeClient, result.tokenMinter);
        } else {
            const newClient = await Innertube.create({
                enable_session_cache: false,
                fetch: getFetchClient(config),
                retrieve_player: innertubeClientFetchPlayer,
                user_agent: USER_AGENT,
                cookie: innertubeClientCookies || undefined,
                player_id: config.youtube_session.player_id,
                location: config.youtube_session.gl || undefined,
                lang: config.youtube_session.hl || undefined,
                cache, // reuse cache for speed
            });
            sharedState.set(newClient, undefined);
        }
        sessionGeneratedAtMs = Date.now();
        logInfo(CTX.PO_TOKEN, `Session regenerated (${reason})`);
    } catch (err) {
        metrics?.potokenGenerationFailure.inc();
        throw err;
    } finally {
        sessionRegenInFlight = false;
    }
}

innertubeClient = await Innertube.create({
    enable_session_cache: false,
    retrieve_player: innertubeClientFetchPlayer,
    fetch: getFetchClient(config, metrics),
    cookie: innertubeClientCookies || undefined,
    user_agent: USER_AGENT,
    player_id: config.youtube_session.player_id,
    location: config.youtube_session.gl || undefined,
    lang: config.youtube_session.hl || undefined,
    cache,
});

if (!innertubeClientOauthEnabled) {
    if (innertubeClientJobPoTokenEnabled) {
        // Initialize tokenMinter in background to not block server startup
        logInfo(CTX.PO_TOKEN, "Starting generation in background...");
        retry(
            poTokenGenerate.bind(
                poTokenGenerate,
                config,
                metrics,
            ),
            { minTimeout: 1_000, maxTimeout: 60_000, multiplier: 5, jitter: 0 },
        ).then((result) => {
            sharedState.set(result.innertubeClient, result.tokenMinter);
            sessionGeneratedAtMs = Date.now();
            tokenMinterReadyResolve?.();
        }).catch((err) => {
            logError(CTX.PO_TOKEN, "Failed to initialize", err);
            metrics?.potokenGenerationFailure.inc();
            tokenMinterReadyResolve?.();
        });
    } else {
        // No PO token: the client created above is the session. Mark it so the
        // lifetime check below doesn't immediately regenerate it.
        sessionGeneratedAtMs = Date.now();
        tokenMinterReadyResolve?.();
    }

    // Proactively regenerate the session when a block is detected, instead of
    // waiting for the next scheduled tick. Debounced so a burst of blocked
    // requests can't trigger a regeneration storm.
    setOnYouTubeBlock(() => {
        const now = Date.now();
        if (now - lastBlockRegenMs < BLOCK_REGEN_COOLDOWN_MS) return;
        lastBlockRegenMs = now;
        metrics?.blockTriggeredRegens.inc();
        logWarn(
            CTX.PO_TOKEN,
            "YouTube block detected — regenerating session proactively",
        );
        regenerateSession("block-detected").catch((err) =>
            logError(
                CTX.PO_TOKEN,
                "Block-triggered session regeneration failed",
                err,
            )
        );
    });

    Deno.cron(
        "regenerate youtube session",
        config.jobs.youtube_session.frequency,
        { backoffSchedule: [5_000, 15_000, 60_000, 180_000] },
        async () => {
            // Skip the expensive full regeneration while the current session is
            // still within its configured lifetime. The alive worker keeps
            // minting per-video content tokens in the meantime; early token
            // expiry or a detected block forces a regen out of band.
            const lifetimeMs =
                config.jobs.youtube_session.session_lifetime_hours *
                60 * 60 * 1000;
            const age = Date.now() - sessionGeneratedAtMs;
            if (sessionGeneratedAtMs > 0 && age < lifetimeMs) {
                logInfo(
                    CTX.PO_TOKEN,
                    `Session still fresh (${
                        Math.round(age / 1000)
                    }s old), skipping scheduled regeneration`,
                );
                return;
            }
            await regenerateSession("scheduled");
        },
    );
} else if (innertubeClientOauthEnabled) {
    // Fired when waiting for the user to authorize the sign in attempt.
    innertubeClient.session.on("auth-pending", (data) => {
        logInfo(
            CTX.OAUTH,
            `Go to ${data.verification_url} and enter code ${data.user_code}`,
        );
    });
    // Fired when authentication is successful.
    innertubeClient.session.on("auth", () => {
        logInfo(CTX.OAUTH, "Sign in successful");
    });
    // Fired when the access token expires.
    innertubeClient.session.on("update-credentials", async () => {
        logInfo(CTX.OAUTH, "Credentials updated");
        await innertubeClient.session.oauth.cacheCredentials();
    });

    // Attempt to sign in and then cache the credentials
    await innertubeClient.session.signIn();
    await innertubeClient.session.oauth.cacheCredentials();
    // Resolve promise for tests
    tokenMinterReadyResolve?.();
}

companionApp.use("*", async (c, next) => {
    c.set("innertubeClient", sharedState.getClient());
    c.set("tokenMinter", sharedState.getMinter());
    c.set("config", config);
    c.set("metrics", metrics);
    await next();
});
companionRoutes(companionApp, config);

app.use("*", async (c, next) => {
    // The misc routes (incl. /readyz) live on this root app, so they need the
    // same shared state the companion routes get — otherwise the readiness
    // probe never sees the Innertube client and reports 503 forever.
    c.set("innertubeClient", sharedState.getClient());
    c.set("tokenMinter", sharedState.getMinter());
    c.set("config", config);
    c.set("metrics", metrics);
    await next();
});
miscRoutes(app, config);

app.route("/", companionApp);

// This cannot be changed since companion restricts the
// files it can access using deno `--allow-write` argument
const udsPath = config.server.unix_socket_path;

export function run(signal: AbortSignal, port: number, hostname: string) {
    if (config.server.use_unix_socket) {
        try {
            if (existsSync(udsPath)) {
                // Delete the unix domain socket manually before starting the server
                Deno.removeSync(udsPath);
            }
        } catch (err) {
            logError(
                CTX.SERVER,
                `Failed to delete socket '${udsPath}' before start`,
                err,
            );
        }

        return Deno.serve(
            {
                onListen() {
                    // Restrict socket permissions to owner+group only (660)
                    // Previously used 0o777 (world-writable) which was a security risk
                    try {
                        Deno.chmodSync(udsPath, 0o660);
                    } catch {
                        // chmod may fail on some platforms; socket is usable as-is
                    }
                    logInfo(CTX.SERVER, `Started at ${udsPath}`);
                },
                signal: signal,
                path: udsPath,
            },
            app.fetch,
        );
    } else {
        return Deno.serve(
            {
                onListen() {
                    logInfo(
                        CTX.SERVER,
                        `Started at http://${config.server.host}:${config.server.port}${config.server.base_path}`,
                    );
                },
                signal: signal,
                port: port,
                hostname: hostname,
            },
            app.fetch,
        );
    }
}

if (import.meta.main) {
    const controller = new AbortController();
    const { signal } = controller;
    const server = run(signal, config.server.port, config.server.host);

    let shuttingDown = false;
    const shutdown = async (signalName: string) => {
        // Guard against a second signal restarting the sequence.
        if (shuttingDown) return;
        shuttingDown = true;

        logInfo(
            CTX.SHUTDOWN,
            `Caught ${signalName}, initiating graceful shutdown...`,
        );
        // Stop accepting new connections; in-flight requests keep running.
        controller.abort();

        // Cleanup PO token workers
        cleanupWorkers();

        metrics?.gracefulShutdowns.inc();

        // Hard cap: if in-flight requests don't drain within 10s, force exit.
        const forceExit = setTimeout(() => {
            logError(
                CTX.SHUTDOWN,
                "Graceful shutdown timeout (10s), forcing exit",
            );
            Deno.exit(0);
        }, 10000);

        try {
            // Resolves once the listener is closed and connections have drained.
            await server.finished;
        } catch {
            // Ignore — we exit regardless below.
        }

        clearTimeout(forceExit);
        logInfo(CTX.SHUTDOWN, "Graceful shutdown completed");
        Deno.exit(0);
    };

    if (Deno.build.os !== "windows") {
        Deno.addSignalListener("SIGTERM", () => void shutdown("SIGTERM"));
    }

    Deno.addSignalListener("SIGINT", () => void shutdown("SIGINT"));
}
