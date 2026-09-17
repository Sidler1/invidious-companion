import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";

import youtubeApiPlayer from "./youtube_api_routes/player.ts";
import invidiousRouteLatestVersion from "./invidious_routes/latestVersion.ts";
import invidiousRouteDashManifest from "./invidious_routes/dashManifest.ts";
import invidiousCaptionsApi from "./invidious_routes/captions.ts";
import getDownloadHandler from "./invidious_routes/download.ts";
import videoPlaybackProxy from "./videoPlaybackProxy.ts";
import type { Config } from "../lib/helpers/config.ts";
import type { Metrics } from "../lib/helpers/metrics.ts";
import metrics from "./metrics.ts";
import health from "./health.ts";
import readiness from "./readiness.ts";
import { compactLogger } from "./compactLogger.ts";
import { metricsAuthFailureCounter } from "./metricsAuthFailureCounter.ts";
import { rateLimit } from "./rateLimit.ts";
import { CTX, logWarn } from "../lib/helpers/log.ts";

// Invidious' download widget posts small multipart bodies (id, title, a
// short JSON blob); this bounds the request so a client can't drive
// unbounded memory usage through the sub-request dispatcher.
const DOWNLOAD_MAX_BODY_BYTES = 64 * 1024;

export const companionRoutes = (
    app: Hono,
    config: Config,
    requestMetrics?: Metrics,
) => {
    // Use compact logger instead of Hono's default logger.
    // The default logger dumps the entire URL (including all query params)
    // into a single massive log line. Our compact logger shows just the
    // route path and key context parameters (itag, host, videoId, etc.).
    app.use("*", compactLogger);

    // Inbound per-client throttle. Registered right after compactLogger (and
    // before every route) so a 429 is still captured by the access log.
    if (config.server.rate_limit.enabled) {
        if (config.server.use_unix_socket && !config.server.trust_proxy) {
            logWarn(
                CTX.SERVER,
                "server.rate_limit is enabled over a Unix socket without " +
                    "server.trust_proxy: a Unix socket has no per-connection " +
                    "client address, so the per-client limiter cannot tell " +
                    "clients apart and will apply a single shared bucket to " +
                    "the whole instance unless a reverse proxy in front of it " +
                    "forwards X-Forwarded-For and trust_proxy is enabled.",
            );
        }
        app.use(
            "*",
            rateLimit({
                requestsPerMinute: config.server.rate_limit.requests_per_minute,
                burst: config.server.rate_limit.burst,
                trustProxy: config.server.trust_proxy,
                metrics: requestMetrics,
            }),
        );
    }

    app.use(
        "/youtubei/v1/*",
        bearerAuth({
            token: config.server.secret_key,
        }),
    );

    app.route("/youtubei/v1", youtubeApiPlayer);
    app.route("/latest_version", invidiousRouteLatestVersion);
    // Needs app for app.request in order to call /latest_version endpoint
    app.post(
        "/download",
        bodyLimit({ maxSize: DOWNLOAD_MAX_BODY_BYTES }),
        getDownloadHandler(app),
    );
    app.route("/api/manifest/dash/id", invidiousRouteDashManifest);
    app.route("/api/v1/captions", invidiousCaptionsApi);
    app.route("/videoplayback", videoPlaybackProxy);
};

export const miscRoutes = (
    app: Hono,
    config: Config,
) => {
    app.route("/healthz", health);
    app.route("/readyz", readiness);
    if (config.server.enable_metrics) {
        app.use("/metrics", metricsAuthFailureCounter);
        // Protect operational metrics with the same bearer token used for
        // /youtubei/v1. Scrapers must send `Authorization: Bearer <secret_key>`.
        app.use(
            "/metrics",
            bearerAuth({ token: config.server.secret_key }),
        );
        app.route("/metrics", metrics);
    }
};
