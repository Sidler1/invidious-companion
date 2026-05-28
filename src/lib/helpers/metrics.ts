import { IRawResponse } from "youtubei.js";
import { Counter, Histogram, Registry } from "prom-client";

export class Metrics {
    private METRICS_PREFIX = "invidious_companion_";
    public register = new Registry();

    public createCounter(name: string, help?: string): Counter {
        return new Counter({
            name: `${this.METRICS_PREFIX}${name}`,
            help: help || "No help has been provided for this metric",
            registers: [this.register],
        });
    }

    public createHistogram(
        name: string,
        help: string,
        buckets?: number[],
    ): Histogram {
        return new Histogram({
            name: `${this.METRICS_PREFIX}${name}`,
            help,
            buckets: buckets || [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
            registers: [this.register],
        });
    }

    public potokenGenerationFailure = this.createCounter(
        "potoken_generation_failure_total",
        "Number of times that the PoToken generation job has failed for whatever reason",
    );

    private innertubeErrorStatusLoginRequired = this.createCounter(
        "innertube_error_status_loginRequired_total",
        'Number of times that the status "LOGIN_REQUIRED" has been returned by Innertube API',
    );

    private innertubeErrorStatusUnknown = this.createCounter(
        "innertube_error_status_unknown_total",
        "Number of times that an unknown status has been returned by Innertube API",
    );

    private innertubeErrorReasonSignIn = this.createCounter(
        "innertube_error_reason_SignIn_total",
        'Number of times that the message "Sign in to confirm you’re not a bot." has been returned by Innertube API',
    );

    private innertubeErrorSubreasonProtectCommunity = this.createCounter(
        "innertube_error_subreason_ProtectCommunity_total",
        'Number of times that the message "This helps protect our community." has been returned by Innertube API',
    );

    private innertubeErrorReasonUnknown = this.createCounter(
        "innertube_error_reason_unknown_total",
        "Number of times that an unknown reason has been returned by the Innertube API",
    );

    private innertubeErrorSubreasonUnknown = this.createCounter(
        "innertube_error_subreason_unknown_total",
        "Number of times that an unknown subreason has been returned by the Innertube API",
    );

    public innertubeSuccessfulRequest = this.createCounter(
        "innertube_successful_request_total",
        "Number successful requests made to the Innertube API",
    );

    public cacheHit = this.createCounter(
        "cache_hit_total",
        "Number of cache hits for video player data",
    );

    public cacheMiss = this.createCounter(
        "cache_miss_total",
        "Number of cache misses for video player data",
    );

    public ipv6Fallback = this.createCounter(
        "ipv6_fallback_total",
        "Number of times IPv6 rotation was disabled due to errors (e.g. no IPv6 support on host)",
    );

    public ipv6AddressGenerated = this.createCounter(
        "ipv6_address_generated_total",
        "Number of IPv6 addresses generated for requests",
    );

    public gracefulShutdowns = this.createCounter(
        "graceful_shutdowns_total",
        "Number of graceful shutdowns initiated and completed successfully",
    );

    public videoPlaybackRequests = this.createCounter(
        "video_playback_requests_total",
        "Number of video playback proxy requests handled",
    );

    public poTokenGenerationSuccess = this.createCounter(
        "potoken_generation_success_total",
        "Number of successful PO token generations",
    );

    public upstreamFailures = this.createCounter(
        "upstream_failures_total",
        "Number of failed upstream requests to YouTube",
    );

    public upstreamRetries = this.createCounter(
        "upstream_retries_total",
        "Number of retried upstream requests to YouTube",
    );

    public proxySelections = this.createCounter(
        "proxy_selections_total",
        "Number of proxy selection events in the proxy pool",
    );

    public proxyBlacklists = this.createCounter(
        "proxy_blacklists_total",
        "Number of times a proxy was blacklisted due to failures",
    );

    public proxyRecoveries = this.createCounter(
        "proxy_recoveries_total",
        "Number of times a blacklisted proxy recovered after cooldown",
    );

    public proxyBlockRetries = this.createCounter(
        "proxy_block_retries_total",
        "Number of in-request proxy failovers triggered by a detected YouTube block",
    );

    public blockTriggeredRegens = this.createCounter(
        "block_triggered_regens_total",
        "Number of session regenerations triggered proactively by a detected YouTube block",
    );

    public requestLatency = this.createHistogram(
        "request_latency_seconds",
        "Request latency in seconds",
    );

    private innertubeFailedRequest = this.createCounter(
        "innertube_failed_request_total",
        "Number failed requests made to the Innertube API for whatever reason",
    );

    private checkStatus(videoData: IRawResponse) {
        const status = videoData.playabilityStatus?.status;

        return {
            unplayable: status ===
                "UNPLAYABLE",
            contentCheckRequired: status ===
                "CONTENT_CHECK_REQUIRED",
            loginRequired: status === "LOGIN_REQUIRED",
        };
    }

    private checkReason(videoData: IRawResponse) {
        const reason = videoData.playabilityStatus?.reason;

        return {
            signInToConfirmAge: reason?.includes(
                "Sign in to confirm your age",
            ),
            SignInToConfirmBot: reason?.includes(
                "Sign in to confirm you’re not a bot",
            ),
        };
    }

    private checkSubreason(videoData: IRawResponse) {
        const subReason = videoData.playabilityStatus?.errorScreen
            ?.playerErrorMessageRenderer
            ?.subreason?.runs?.[0]?.text;

        return {
            thisHelpsProtectCommunity: subReason?.includes(
                "This helps protect our community",
            ),
        };
    }

    public checkInnertubeResponse(videoData: IRawResponse) {
        this.innertubeFailedRequest.inc();
        const status = this.checkStatus(videoData);

        if (status.contentCheckRequired || status.unplayable) return;

        if (status.loginRequired) {
            this.innertubeErrorStatusLoginRequired.inc();
            const reason = this.checkReason(videoData);

            if (reason.signInToConfirmAge) return;

            if (reason.SignInToConfirmBot) {
                this.innertubeErrorReasonSignIn.inc();
                const subReason = this.checkSubreason(videoData);

                if (subReason.thisHelpsProtectCommunity) {
                    this.innertubeErrorSubreasonProtectCommunity.inc();
                } else {
                    this.innertubeErrorSubreasonUnknown.inc();
                }
            } else {
                this.innertubeErrorReasonUnknown.inc();
            }
        } else {
            this.innertubeErrorStatusUnknown.inc();
        }
    }
}
