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

const config = await parseConfig();

const args = parseArgs(Deno.args);

if (args._version_date && args._version_commit) {
    console.log(
        `[INFO] Using Invidious companion version ${args._version_date}-${args._version_commit}`,
    );
}

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
 * Atomic state container to prevent race conditions between the cron job
 * and request handlers. All reads/writes go through synchronized accessors.
 */
const sharedState = {
    _client: null as Innertube | null,
    _minter: null as TokenMinter | undefined,
    _lock: Promise.resolve() as Promise<unknown>,

    getClient(): Innertube {
        return this._client || innertubeClient;
    },
    getMinter(): TokenMinter | undefined {
        return this._minter !== null ? this._minter : tokenMinter;
    },
    async set(client: Innertube, minter: TokenMinter | undefined): Promise<void> {
        await this._lock;
        this._lock = Promise.resolve();
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
        console.log("[INFO] job po_token is active.");
        // Don't fetch fetch player yet for po_token
        innertubeClientFetchPlayer = false;
    } else if (!innertubeClientJobPoTokenEnabled) {
        console.log("[INFO] job po_token is NOT active.");
    }
}

Platform.shim.eval = jsInterpreter;

// PERFORMANCE IMPROVEMENT: Use persistent UniversalCache for player/session data
// This dramatically speeds up Innertube creation and the 5min cron regeneration
// (avoids re-downloading/deciphering player JS every time)
const cache = config.cache.enabled
    ? new UniversalCache(true, config.cache.directory)
    : undefined;

innertubeClient = await Innertube.create({
    enable_session_cache: false,
    retrieve_player: innertubeClientFetchPlayer,
    fetch: getFetchClient(config),
    cookie: innertubeClientCookies || undefined,
    user_agent: USER_AGENT,
    player_id: config.youtube_session.player_id,
    cache,
});

if (!innertubeClientOauthEnabled) {
    if (innertubeClientJobPoTokenEnabled) {
        // Initialize tokenMinter in background to not block server startup
        console.log("[INFO] Starting PO token generation in background...");
        retry(
            poTokenGenerate.bind(
                poTokenGenerate,
                config,
                metrics,
            ),
            { minTimeout: 1_000, maxTimeout: 60_000, multiplier: 5, jitter: 0 },
        ).then(async (result) => {
            await sharedState.set(result.innertubeClient, result.tokenMinter);
            tokenMinterReadyResolve?.();
        }).catch((err) => {
            console.error("[ERROR] Failed to initialize PO token:", err);
            metrics?.potokenGenerationFailure.inc();
            tokenMinterReadyResolve?.();
        });
    } else {
        // If PO token is not enabled, resolve immediately
        tokenMinterReadyResolve?.();
    }
    Deno.cron(
        "regenerate youtube session",
        config.jobs.youtube_session.frequency,
        { backoffSchedule: [5_000, 15_000, 60_000, 180_000] },
        async () => {
            if (innertubeClientJobPoTokenEnabled) {
                try {
                    const result = await poTokenGenerate(config, metrics);
                    await sharedState.set(result.innertubeClient, result.tokenMinter);
                } catch (err) {
                    metrics?.potokenGenerationFailure.inc();
                    throw err;
                }
            } else {
                const newClient = await Innertube.create({
                    enable_session_cache: false,
                    fetch: getFetchClient(config),
                    retrieve_player: innertubeClientFetchPlayer,
                    user_agent: USER_AGENT,
                    cookie: innertubeClientCookies || undefined,
                    player_id: config.youtube_session.player_id,
                    cache, // reuse cache for speed
                });
                await sharedState.set(newClient, undefined);
            }
        },
    );
} else if (innertubeClientOauthEnabled) {
    // Fired when waiting for the user to authorize the sign in attempt.
    innertubeClient.session.on("auth-pending", (data) => {
        console.log(
            `[INFO] [OAUTH] Go to ${data.verification_url} in your browser and enter code ${data.user_code} to authenticate.`,
        );
    });
    // Fired when authentication is successful.
    innertubeClient.session.on("auth", () => {
        console.log("[INFO] [OAUTH] Sign in successful!");
    });
    // Fired when the access token expires.
    innertubeClient.session.on("update-credentials", async () => {
        console.log("[INFO] [OAUTH] Credentials updated.");
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
            console.log(
                `[ERROR] Failed to delete unix domain socket '${udsPath}' before starting the server:`,
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
                    console.log(
                        `[INFO] Server successfully started at ${udsPath}.`,
                    );
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
                    console.log(
                        `[INFO] Server successfully started at http://${config.server.host}:${config.server.port}${config.server.base_path}`,
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
    run(signal, config.server.port, config.server.host);

    const shutdown = (signalName: string) => {
        console.log(
            `[INFO] Caught ${signalName}, initiating graceful shutdown...`,
        );
        controller.abort();

        // Cleanup PO token workers
        cleanupWorkers();

        metrics?.gracefulShutdowns.inc();

        // Optional: add a timeout for forced exit if shutdown hangs
        setTimeout(() => {
            console.log(
                "[WARN] Graceful shutdown timeout (10s) reached, forcing exit...",
            );
            Deno.exit(0);
        }, 10000);

        // Give a moment for cleanup, then exit
        setTimeout(() => {
            console.log("[INFO] Graceful shutdown completed.");
            Deno.exit(0);
        }, 1000);
    };

    if (Deno.build.os !== "windows") {
        Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));
    }

    Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
}
