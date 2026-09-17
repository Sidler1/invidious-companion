import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { getConnInfo } from "hono/deno";
import type { Metrics } from "../lib/helpers/metrics.ts";
import { CTX, logWarn } from "../lib/helpers/log.ts";

/**
 * Per-client-IP token bucket for the companion routes.
 *
 * Each client starts with `burst` tokens; one token is spent per request and
 * tokens refill at `requestsPerMinute / 60` per second up to `burst`. A
 * request with less than one token available is answered 429. Buckets that
 * have been idle for PRUNE_INTERVAL_MS are dropped on the next request so
 * the map cannot grow without bound; on top of that, the map is capped at
 * `maxBuckets` (default MAX_BUCKETS) entries kept in least-recently-used
 * order, so even a flood of distinct clients between prunes cannot grow it
 * unbounded — see the eviction logic in `rateLimit`.
 */
export interface RateLimitOptions {
    requestsPerMinute: number;
    burst: number;
    trustProxy: boolean;
    metrics?: Metrics;
    /** Injectable clock (ms); defaults to Date.now. Tests use it. */
    now?: () => number;
    /** Hard cap on tracked buckets; defaults to MAX_BUCKETS. Tests use it. */
    maxBuckets?: number;
}

interface Bucket {
    readonly tokens: number;
    readonly updatedAt: number;
}

const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_BUCKETS = 10_000;
const RATE_LIMIT_BODY = "Too many requests.";
const UNKNOWN_CLIENT = "unknown";

let warnedUnixSocket = false;

/**
 * Logs once per process when the limiter is running behind a Unix-socket
 * listener with no way to tell clients apart, so an operator sees why that
 * deployment is getting instance-wide throttling instead of per-user.
 */
function warnUnixSocketOnce(): void {
    if (warnedUnixSocket) return;
    warnedUnixSocket = true;
    logWarn(
        CTX.SERVER,
        "rateLimit: request arrived over a Unix socket with no " +
            "per-connection client address — applying a single shared " +
            "bucket to all Unix-socket requests instead of one per client.",
    );
}

/**
 * True when the request carries connection info at all (an object with a
 * `remoteAddr`, however sparse). False for in-process dispatch such as
 * `download.ts`'s `app.request(url)` calls to `/api/v1/captions` and
 * `/latest_version`, which pass no env/third argument and therefore have no
 * `remoteAddr` to key a bucket on — the middleware skips rate limiting for
 * those entirely rather than lumping them into the shared "unknown" bucket.
 * This is distinct from a Unix-socket connection, whose env *does* carry a
 * `remoteAddr` (just one with no `hostname`).
 */
export function hasConnectionInfo(c: Context): boolean {
    return (c.env as { remoteAddr?: unknown } | undefined)?.remoteAddr !=
        null;
}

/**
 * Identify the client. With trustProxy the first X-Forwarded-For hop wins
 * (only correct behind a reverse proxy that overwrites the header);
 * otherwise the socket address. Callers must first check `hasConnectionInfo`
 * — this always returns UNKNOWN_CLIENT when there is none, which the
 * middleware treats as a Unix-socket-style shared bucket rather than the
 * "skip entirely" case that a wholly env-less request gets.
 *
 * Notably always falls back to UNKNOWN_CLIENT on a Unix-socket listener:
 * `Deno.UnixAddr` has no `hostname`, so `getConnInfo(c).remote.address` is
 * always `undefined` there. Every request over the socket then collapses
 * into the same "unknown" bucket (see `warnUnixSocketOnce`) unless a
 * reverse proxy in front of it forwards `X-Forwarded-For` and `trustProxy`
 * is enabled.
 */
export function clientIpFrom(c: Context, trustProxy: boolean): string {
    if (trustProxy) {
        const forwarded = c.req.header("x-forwarded-for");
        const firstHop = forwarded?.split(",")[0]?.trim();
        if (firstHop) {
            return firstHop;
        }
    }
    try {
        return getConnInfo(c).remote.address ?? UNKNOWN_CLIENT;
    } catch {
        return UNKNOWN_CLIENT;
    }
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
    const buckets = new Map<string, Bucket>();
    const now = options.now ?? Date.now;
    const maxBuckets = options.maxBuckets ?? MAX_BUCKETS;
    const refillPerMs = options.requestsPerMinute / 60_000;
    let lastPrune = now();

    const pruneIdle = (t: number): void => {
        if (t - lastPrune < PRUNE_INTERVAL_MS) return;
        forcePruneIdle(t);
    };

    const forcePruneIdle = (t: number): void => {
        lastPrune = t;
        for (const [ip, bucket] of buckets) {
            if (t - bucket.updatedAt > PRUNE_INTERVAL_MS) {
                buckets.delete(ip);
            }
        }
    };

    return async (c, next) => {
        // In-process dispatch (no env/remoteAddr at all) never touched a
        // real socket, so there is no client to rate limit — and no shared
        // bucket for it to spuriously consume or exhaust either.
        if (!hasConnectionInfo(c)) {
            await next();
            return;
        }

        const t = now();
        pruneIdle(t);

        const ip = clientIpFrom(c, options.trustProxy);
        if (ip === UNKNOWN_CLIENT) {
            warnUnixSocketOnce();
        }

        const previous = buckets.get(ip) ??
            { tokens: options.burst, updatedAt: t };
        const refilled = Math.min(
            options.burst,
            previous.tokens + (t - previous.updatedAt) * refillPerMs,
        );

        // Enforce the size cap before inserting a genuinely new key: prune
        // idle entries first, and if that alone doesn't free a slot, evict
        // the least-recently-used bucket (the first key in Map iteration
        // order — see the delete+set below, which keeps that order LRU).
        if (!buckets.has(ip) && buckets.size >= maxBuckets) {
            forcePruneIdle(t);
            if (buckets.size >= maxBuckets) {
                const oldestKey = buckets.keys().next().value;
                if (oldestKey !== undefined) {
                    buckets.delete(oldestKey);
                }
            }
        }

        // Re-inserting an existing key moves it to the end of the Map's
        // iteration order (a plain `set` on an existing key does not), so
        // this keeps `buckets` ordered least-recently-used → most-recent.
        buckets.delete(ip);

        if (refilled < 1) {
            buckets.set(ip, { tokens: refilled, updatedAt: t });
            options.metrics?.rateLimitRejections.inc();
            const retryAfterSeconds = Math.max(
                1,
                Math.ceil((1 - refilled) / refillPerMs / 1000),
            );
            throw new HTTPException(429, {
                res: new Response(RATE_LIMIT_BODY, {
                    status: 429,
                    headers: { "retry-after": String(retryAfterSeconds) },
                }),
            });
        }

        buckets.set(ip, { tokens: refilled - 1, updatedAt: t });
        await next();
    };
}
