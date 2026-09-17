import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { getConnInfo } from "hono/deno";
import type { Metrics } from "../lib/helpers/metrics.ts";

/**
 * Per-client-IP token bucket for the companion routes.
 *
 * Each client starts with `burst` tokens; one token is spent per request and
 * tokens refill at `requestsPerMinute / 60` per second up to `burst`. A
 * request with less than one token available is answered 429. Buckets that
 * have been idle for PRUNE_INTERVAL_MS are dropped on the next request so
 * the map cannot grow without bound.
 */
export interface RateLimitOptions {
    requestsPerMinute: number;
    burst: number;
    trustProxy: boolean;
    metrics?: Metrics;
    /** Injectable clock (ms); defaults to Date.now. Tests use it. */
    now?: () => number;
}

interface Bucket {
    readonly tokens: number;
    readonly updatedAt: number;
}

const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const RATE_LIMIT_BODY = "Too many requests.";
const UNKNOWN_CLIENT = "unknown";

/**
 * Identify the client. With trustProxy the first X-Forwarded-For hop wins
 * (only correct behind a reverse proxy that overwrites the header);
 * otherwise the socket address. `app.request()` in tests has no connection
 * info unless an env with `remoteAddr` is passed, hence the fallback.
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
    const refillPerMs = options.requestsPerMinute / 60_000;
    let lastPrune = now();

    const pruneIdle = (t: number): void => {
        if (t - lastPrune < PRUNE_INTERVAL_MS) return;
        lastPrune = t;
        for (const [ip, bucket] of buckets) {
            if (t - bucket.updatedAt > PRUNE_INTERVAL_MS) {
                buckets.delete(ip);
            }
        }
    };

    return async (c, next) => {
        const t = now();
        pruneIdle(t);

        const ip = clientIpFrom(c, options.trustProxy);
        const previous = buckets.get(ip) ??
            { tokens: options.burst, updatedAt: t };
        const refilled = Math.min(
            options.burst,
            previous.tokens + (t - previous.updatedAt) * refillPerMs,
        );

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
