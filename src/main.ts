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
import { closeKv } from "./lib/helpers/kv.ts";
import { awaitPendingWrites } from "./lib/helpers/pendingWrites.ts";
import { Metrics } from "./lib/helpers/metrics.ts";
import { jsInterpreter } from "./lib/helpers/jsInterpreter.ts";
import { CTX, logError, logInfo, logWarn } from "./lib/helpers/log.ts";
import { errorHandler } from "./routes/errorHandler.ts";

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
const {
    getFetchClient,
    setOnYouTubeBlock,
    setOnActiveProxyChange,
    rotateSessionEgressProxy,
} = await import(
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

// Unexpected errors must never reach Hono's default handler, which prints
// the raw error (and with it any URL-embedded PO token) to the console.
app.onError(errorHandler);
companionApp.onError(errorHandler);

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
    // Incremented on every set(); see HonoVariables.sessionGeneration.
    _generation: 0,

    getClient(): Innertube {
        return this._client ?? innertubeClient;
    },
    getMinter(): TokenMinter | undefined {
        // Once the cron job has set a client, its paired minter is the source
        // of truth (even when undefined); before then, fall back to the
        // module-level minter.
        return this._client ? this._minter : tokenMinter;
    },
    getGeneration(): number {
        return this._generation;
    },
    set(client: Innertube, minter: TokenMinter | undefined): void {
        this._client = client;
        this._minter = minter;
        this._generation++;
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
    ? new UniversalCache(true, `${config.cache.directory}/youtubei.js`)
    : undefined;

import {
    type GeneratedSession,
    SessionLifecycle,
} from "./lib/session/sessionLifecycle.ts";

// Produces a brand-new session for the lifecycle: a PO-token worker session
// when the job is enabled, otherwise a plain Innertube client.
const generateSession = async (): Promise<GeneratedSession> => {
    if (innertubeClientJobPoTokenEnabled) {
        return await poTokenGenerate(config, metrics, { cache });
    }
    const client = await Innertube.create({
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
    return {
        innertubeClient: client,
        tokenMinter: undefined,
        worker: undefined,
        egressProxyUrl: null,
    };
};

const lifecycle = new SessionLifecycle({
    config,
    metrics,
    generate: generateSession,
    install: (client, minter) => sharedState.set(client, minter),
});

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

        // Before each retry, rotate to a fresh egress IP so a blocked proxy
        // doesn't get re-pinned attempt after attempt (a single block is only
        // 1 of the 3 failures that blacklist a proxy, so without this the
        // bootstrap keeps attesting through the same blocked IP). No-op when no
        // proxy pool is configured.
        const usePool = config.networking.proxy_pool.enabled &&
            config.networking.proxy_pool.proxies.length > 0;
        const bootstrapAttempt = async () => {
            try {
                return await poTokenGenerate(config, metrics, { cache });
            } catch (err) {
                if (usePool) {
                    await rotateSessionEgressProxy(config).catch(() => {});
                }
                throw err;
            }
        };

        // Faster startup cadence than the steady-state regen: retry quickly
        // (≤10s apart, no 60s waits) and give enough attempts to sweep the
        // whole pool a couple of times looking for a non-blocked proxy. If it
        // still can't mint a token, the scheduled cron remains the long-term
        // fallback (it keeps retrying every `frequency`).
        const bootstrapMaxAttempts = usePool
            ? Math.min(
                Math.max(config.networking.proxy_pool.proxies.length * 2, 6),
                15,
            )
            : 6;
        lifecycle.bootstrap(() =>
            retry(
                bootstrapAttempt,
                {
                    maxAttempts: bootstrapMaxAttempts,
                    minTimeout: 1_000,
                    maxTimeout: 10_000,
                    multiplier: 2,
                    jitter: 0.2,
                },
            )
        ).then(() => {
            tokenMinterReadyResolve?.();
        }).catch((err) => {
            logError(CTX.PO_TOKEN, "Failed to initialize", err);
            metrics?.potokenGenerationFailure.inc();
            // Distinguish "startup is just slow" from "the whole proxy pool is
            // burned": if we rotated through every proxy (bootstrapMaxAttempts
            // ≥ pool size) and still couldn't mint a token, none of the
            // configured egress IPs returned a clean response. That points at
            // the pool itself, not a transient hiccup — surface it loudly.
            if (usePool) {
                logError(
                    CTX.PO_TOKEN,
                    `Swept the entire proxy pool (${config.networking.proxy_pool.proxies.length} ` +
                        `${
                            config.networking.proxy_pool.proxies.length === 1
                                ? "proxy"
                                : "proxies"
                        }) over ${bootstrapMaxAttempts} attempts without minting a ` +
                        `PO token — all egress IPs appear blocked. Consider rotating/refreshing ` +
                        `the proxy pool. The scheduled job will keep retrying.`,
                );
            }
            tokenMinterReadyResolve?.();
        });
    } else {
        // No PO token: the client created above is the session. Adopt it so
        // the lifetime check below doesn't immediately regenerate it.
        lifecycle.adopt({
            innertubeClient,
            tokenMinter: undefined,
            worker: undefined,
            egressProxyUrl: null,
        });
        tokenMinterReadyResolve?.();
    }

    // Proactively regenerate the session when a block is detected, instead of
    // waiting for the next scheduled tick (debounced inside the lifecycle).
    setOnYouTubeBlock(() => {
        lifecycle.onBlockDetected();
    });

    // When the proxy pool hops the active egress (rate-limit-driven, only with
    // switch_proxy_on_limit), swap in that proxy's session so its IP and tokens
    // stay consistent. Reuse a still-fresh cached session synchronously;
    // otherwise mint a new one in the background pinned to the new proxy.
    if (
        config.networking.proxy_pool.enabled &&
        config.networking.proxy_pool.switch_proxy_on_limit
    ) {
        setOnActiveProxyChange((proxyUrl: string) => {
            lifecycle.switchToProxy(proxyUrl);
        });
    }

    Deno.cron(
        "regenerate youtube session",
        config.jobs.youtube_session.frequency,
        { backoffSchedule: [5_000, 15_000, 60_000, 180_000] },
        async () => {
            lifecycle.evictExpiredProxySessions();
            // The startup bootstrap (or a triggered regen) is the sole
            // generator while it runs; never start a second one.
            if (lifecycle.regenerationInFlight) {
                logInfo(
                    CTX.PO_TOKEN,
                    "Generation in flight, skipping scheduled regeneration",
                );
                return;
            }
            // Skip the expensive full regeneration while the current session is
            // still within its effective lifetime (the smaller of the configured
            // cap and YouTube's estimated token TTL). The alive worker keeps
            // minting per-video content tokens in the meantime; early token
            // expiry or a detected block forces a regen out of band.
            if (lifecycle.isSessionFresh()) {
                const age = Date.now() - lifecycle.sessionGeneratedAtMs;
                logInfo(
                    CTX.PO_TOKEN,
                    `Session still fresh (${
                        Math.round(age / 1000)
                    }s old), skipping scheduled regeneration`,
                );
                return;
            }
            await lifecycle.regenerate("scheduled");
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
    c.set("lastMintOkMs", lifecycle.lastMintOkMs);
    c.set("sessionGeneration", sharedState.getGeneration());
    await next();
});
companionRoutes(companionApp, config, metrics);

app.use("*", async (c, next) => {
    // The misc routes (incl. /readyz) live on this root app, so they need the
    // same shared state the companion routes get — otherwise the readiness
    // probe never sees the Innertube client and reports 503 forever.
    c.set("innertubeClient", sharedState.getClient());
    c.set("tokenMinter", sharedState.getMinter());
    c.set("config", config);
    c.set("metrics", metrics);
    c.set("lastMintOkMs", lifecycle.lastMintOkMs);
    c.set("sessionGeneration", sharedState.getGeneration());
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

        metrics?.gracefulShutdowns.inc();

        // Hard cap: if in-flight requests don't drain within 10s, force exit.
        const forceExit = setTimeout(() => {
            logError(
                CTX.SHUTDOWN,
                "Graceful shutdown timeout (10s), forcing exit",
            );
            // Terminate workers explicitly even on a hung drain; pending
            // writes and the KV close are skipped on this path, matching
            // pre-change behaviour.
            cleanupWorkers();
            Deno.exit(0);
        }, 10000);

        try {
            // Resolves once the listener is closed and connections have drained.
            await server.finished;
        } catch {
            // Ignore — we exit regardless below.
        }

        // Workers are torn down only after in-flight requests drained, so a
        // request that reaches tokenMinter() during the drain still gets a
        // token instead of waiting out the mint timeout.
        cleanupWorkers();
        // Let fire-and-forget cache writes land, then flush and close the
        // on-disk KV cache once nothing can touch it.
        await awaitPendingWrites();
        await closeKv().catch((err) =>
            logWarn(CTX.SHUTDOWN, `Failed to close KV cache: ${err}`)
        );
        // Clear the hard cap only once every drain/cleanup step above has
        // actually finished, so a wedged write or a hung KV close still hits
        // the 10s force-exit instead of hanging forever.
        clearTimeout(forceExit);
        logInfo(CTX.SHUTDOWN, "Graceful shutdown completed");
        Deno.exit(0);
    };

    if (Deno.build.os !== "windows") {
        Deno.addSignalListener("SIGTERM", () => void shutdown("SIGTERM"));
    }

    Deno.addSignalListener("SIGINT", () => void shutdown("SIGINT"));
}
