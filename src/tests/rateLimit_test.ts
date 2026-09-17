import { Hono } from "hono";
import { assertEquals } from "./deps.ts";
import { rateLimit } from "../routes/rateLimit.ts";
import { Metrics } from "../lib/helpers/metrics.ts";

function buildApp(
    options: {
        requestsPerMinute: number;
        burst: number;
        trustProxy: boolean;
        metrics?: Metrics;
        maxBuckets?: number;
    },
    clock: { now: number },
) {
    const app = new Hono();
    app.use("*", rateLimit({ ...options, now: () => clock.now }));
    app.get("/x", (c) => c.text("ok"));
    return app;
}

const remoteEnv = (hostname: string) => ({
    remoteAddr: { hostname, port: 12345, transport: "tcp" },
});

// Deno.UnixAddr has no `hostname`/`port` — only `transport` and `path` — so
// this is the shape the middleware actually sees behind a Unix socket
// listener.
const unixEnv = (path: string) => ({
    remoteAddr: { transport: "unix", path },
});

Deno.test("rateLimit allows up to burst requests then answers 429", async () => {
    const clock = { now: 1_000_000 };
    const app = buildApp(
        { requestsPerMinute: 60, burst: 3, trustProxy: false },
        clock,
    );
    for (let i = 0; i < 3; i++) {
        const res = await app.request("/x", {}, remoteEnv("10.0.0.1"));
        assertEquals(res.status, 200);
    }
    const blocked = await app.request("/x", {}, remoteEnv("10.0.0.1"));
    assertEquals(blocked.status, 429);
    assertEquals(await blocked.text(), "Too many requests.");
    assertEquals(blocked.headers.get("retry-after"), "1");
});

Deno.test("rateLimit refills over time", async () => {
    const clock = { now: 1_000_000 };
    const app = buildApp(
        { requestsPerMinute: 60, burst: 1, trustProxy: false },
        clock,
    );
    assertEquals(
        (await app.request("/x", {}, remoteEnv("10.0.0.1"))).status,
        200,
    );
    assertEquals(
        (await app.request("/x", {}, remoteEnv("10.0.0.1"))).status,
        429,
    );
    clock.now += 1000; // 60 rpm → one token per second
    assertEquals(
        (await app.request("/x", {}, remoteEnv("10.0.0.1"))).status,
        200,
    );
});

Deno.test("rateLimit keeps separate buckets per client address", async () => {
    const clock = { now: 1_000_000 };
    const app = buildApp(
        { requestsPerMinute: 60, burst: 1, trustProxy: false },
        clock,
    );
    assertEquals(
        (await app.request("/x", {}, remoteEnv("10.0.0.1"))).status,
        200,
    );
    assertEquals(
        (await app.request("/x", {}, remoteEnv("10.0.0.2"))).status,
        200,
    );
    assertEquals(
        (await app.request("/x", {}, remoteEnv("10.0.0.1"))).status,
        429,
    );
});

Deno.test("rateLimit uses X-Forwarded-For only when trust_proxy is on", async () => {
    const clock = { now: 1_000_000 };
    const trusting = buildApp(
        { requestsPerMinute: 60, burst: 1, trustProxy: true },
        clock,
    );
    const viaA = { headers: { "x-forwarded-for": "203.0.113.1, 10.0.0.9" } };
    const viaB = { headers: { "x-forwarded-for": "203.0.113.2, 10.0.0.9" } };
    assertEquals(
        (await trusting.request("/x", viaA, remoteEnv("10.0.0.9"))).status,
        200,
    );
    assertEquals(
        (await trusting.request("/x", viaB, remoteEnv("10.0.0.9"))).status,
        200,
    );
    assertEquals(
        (await trusting.request("/x", viaA, remoteEnv("10.0.0.9"))).status,
        429,
    );

    const untrusting = buildApp(
        { requestsPerMinute: 60, burst: 1, trustProxy: false },
        clock,
    );
    assertEquals(
        (await untrusting.request("/x", viaA, remoteEnv("10.0.0.9"))).status,
        200,
    );
    // Same socket address → same bucket, header ignored.
    assertEquals(
        (await untrusting.request("/x", viaB, remoteEnv("10.0.0.9"))).status,
        429,
    );
});

Deno.test("rateLimit prunes buckets idle past the prune interval", async () => {
    const clock = { now: 1_000_000 };
    // Deliberately slow refill (1 token per 10 minutes): with the prune
    // interval elapsed but no pruning, natural refill alone would still
    // leave this client under one token (blocked). A bucket wipe resets it
    // to a full burst instead, so the second call distinguishes the two.
    const app = buildApp(
        { requestsPerMinute: 0.1, burst: 1, trustProxy: false },
        clock,
    );
    assertEquals(
        (await app.request("/x", {}, remoteEnv("10.0.0.1"))).status,
        200,
    );
    clock.now += 5 * 60 * 1000 + 1; // just past the 5-minute prune interval
    assertEquals(
        (await app.request("/x", {}, remoteEnv("10.0.0.1"))).status,
        200,
    );
});

Deno.test("rateLimit counts rejections in metrics", async () => {
    const clock = { now: 1_000_000 };
    const metrics = new Metrics();
    const app = buildApp(
        { requestsPerMinute: 60, burst: 1, trustProxy: false, metrics },
        clock,
    );
    await app.request("/x", {}, remoteEnv("10.0.0.1"));
    await app.request("/x", {}, remoteEnv("10.0.0.1"));
    const value = (await metrics.rateLimitRejections.get()).values[0]?.value;
    assertEquals(value, 1);
});

Deno.test("rateLimit falls back to one shared bucket over a Unix socket and warns once", async () => {
    const clock = { now: 1_000_000 };
    const app = buildApp(
        { requestsPerMinute: 60, burst: 1, trustProxy: false },
        clock,
    );

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
    };
    try {
        // Deno.UnixAddr has no hostname, so clientIpFrom cannot distinguish
        // these two (nominally different) socket paths — both collapse into
        // the same "unknown" bucket.
        assertEquals(
            (await app.request("/x", {}, unixEnv("/tmp/a.sock"))).status,
            200,
        );
        assertEquals(
            (await app.request("/x", {}, unixEnv("/tmp/b.sock"))).status,
            429,
        );
        assertEquals(
            (await app.request("/x", {}, unixEnv("/tmp/a.sock"))).status,
            429,
        );
        const unknownClientWarnings = warnings.filter((w) =>
            w.includes("shared bucket")
        );
        assertEquals(unknownClientWarnings.length, 1);
    } finally {
        console.warn = originalWarn;
    }
});

Deno.test("rateLimit never rate limits requests with no connection info at all", async () => {
    const clock = { now: 1_000_000 };
    const app = buildApp(
        { requestsPerMinute: 60, burst: 1, trustProxy: false },
        clock,
    );
    // Exhaust the normal per-client bucket first.
    assertEquals(
        (await app.request("/x", {}, remoteEnv("10.0.0.1"))).status,
        200,
    );
    assertEquals(
        (await app.request("/x", {}, remoteEnv("10.0.0.1"))).status,
        429,
    );

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
    };
    try {
        // `app.request(url)` with no env at all — as used internally by
        // /download's dispatch to /api/v1/captions and /latest_version —
        // must never be throttled, and must not touch the shared bucket.
        assertEquals((await app.request("/x")).status, 200);
        assertEquals((await app.request("/x")).status, 200);
        assertEquals(warnings.length, 0);
    } finally {
        console.warn = originalWarn;
    }

    // The already-exhausted client is unaffected by the env-less requests.
    assertEquals(
        (await app.request("/x", {}, remoteEnv("10.0.0.1"))).status,
        429,
    );
});

Deno.test("rateLimit evicts the least-recently-used bucket at the size cap", async () => {
    const clock = { now: 1_000_000 };
    const app = buildApp(
        { requestsPerMinute: 60, burst: 1, trustProxy: false, maxBuckets: 3 },
        clock,
    );
    for (const host of ["10.0.0.1", "10.0.0.2", "10.0.0.3"]) {
        assertEquals(
            (await app.request("/x", {}, remoteEnv(host))).status,
            200,
        );
    }
    // A 4th distinct client, at the cap, evicts the least-recently-used
    // bucket (10.0.0.1, never touched again after its first request).
    assertEquals(
        (await app.request("/x", {}, remoteEnv("10.0.0.4"))).status,
        200,
    );
    // 10.0.0.1 gets a fresh burst rather than 429: with burst 1 and no time
    // elapsed, its old (spent) bucket would still answer 429 if it had
    // survived, so this only passes because eviction wiped it — proving
    // the map stayed at the cap instead of growing past it.
    assertEquals(
        (await app.request("/x", {}, remoteEnv("10.0.0.1"))).status,
        200,
    );
});
