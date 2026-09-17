import { assertExists } from "./deps.ts";
import { Metrics } from "../lib/helpers/metrics.ts";

Deno.test("Metrics - new counters exist and are incrementable", () => {
    const metrics = new Metrics();

    // Test gracefulShutdowns
    assertExists(
        metrics.gracefulShutdowns,
        "gracefulShutdowns counter should exist",
    );
    metrics.gracefulShutdowns.inc();

    // Test videoPlaybackRequests
    assertExists(
        metrics.videoPlaybackRequests,
        "videoPlaybackRequests counter should exist",
    );
    metrics.videoPlaybackRequests.inc();

    // Test poTokenGenerationSuccess
    assertExists(
        metrics.poTokenGenerationSuccess,
        "poTokenGenerationSuccess counter should exist",
    );
    metrics.poTokenGenerationSuccess.inc();

    // Also verify existing important counters still work
    assertExists(metrics.cacheHit, "cacheHit counter should exist");
    assertExists(metrics.ipv6Fallback, "ipv6Fallback counter should exist");
});

Deno.test("Metrics - new upstream/proxy counters exist", () => {
    const metrics = new Metrics();

    assertExists(
        metrics.upstreamFailures,
        "upstreamFailures counter should exist",
    );
    metrics.upstreamFailures.inc();

    assertExists(
        metrics.upstreamRetries,
        "upstreamRetries counter should exist",
    );
    metrics.upstreamRetries.inc();

    assertExists(
        metrics.proxySelections,
        "proxySelections counter should exist",
    );
    metrics.proxySelections.inc();

    assertExists(
        metrics.proxyBlacklists,
        "proxyBlacklists counter should exist",
    );
    metrics.proxyBlacklists.inc();

    assertExists(
        metrics.proxyRecoveries,
        "proxyRecoveries counter should exist",
    );
    metrics.proxyRecoveries.inc();

    assertExists(
        metrics.requestLatency,
        "requestLatency histogram should exist",
    );
    metrics.requestLatency.labels("/companion/latest_version", "GET", "200")
        .observe(0.5);
});

Deno.test("Metrics - registry contains all expected metrics", () => {
    const metrics = new Metrics();
    const metricNames = Array.from(metrics.register.getMetricsAsArray()).map(
        (m) => m.name,
    );

    const expectedNewMetrics = [
        "invidious_companion_graceful_shutdowns_total",
        "invidious_companion_video_playback_requests_total",
        "invidious_companion_potoken_generation_success_total",
        "invidious_companion_upstream_failures_total",
        "invidious_companion_upstream_retries_total",
        "invidious_companion_proxy_selections_total",
        "invidious_companion_proxy_blacklists_total",
        "invidious_companion_proxy_recoveries_total",
        "invidious_companion_request_latency_seconds",
        "invidious_companion_mint_timeouts_total",
        "invidious_companion_mint_failures_total",
        "invidious_companion_session_regen_dropped_total",
    ];

    for (const expected of expectedNewMetrics) {
        assertExists(
            metricNames.find((name) => name === expected),
            `Expected metric ${expected} not found in registry`,
        );
    }
});

Deno.test("Metrics - requestLatency is labelled by route, method and status", async () => {
    const metrics = new Metrics();
    metrics.requestLatency.labels("/companion/latest_version", "GET", "302")
        .observe(0.05);
    const data = await metrics.requestLatency.get();
    const labelled = data.values.find((v) =>
        v.labels.route === "/companion/latest_version" &&
        v.labels.method === "GET" && v.labels.status === "302"
    );
    assertExists(labelled, "expected a sample carrying the three labels");
});

Deno.test("Metrics - abuse-signal counters exist", () => {
    const metrics = new Metrics();
    assertExists(metrics.authFailures);
    assertExists(metrics.verifyRequestFailures);
    assertExists(metrics.captionsRequests);
    assertExists(metrics.rateLimitRejections);
    metrics.authFailures.inc();
    metrics.captionsRequests.inc();
});
