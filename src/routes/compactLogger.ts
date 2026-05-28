/**
 * Compact Hono request logger middleware.
 *
 * Replaces the default Hono logger which dumps the entire URL (including
 * all query parameters) into a single massive log line. Instead, this
 * logger produces short, scannable lines with just the route path and
 * key context parameters.
 *
 * Example output:
 *   <-- GET  /videoplayback itag=399 host=rr3.googlevideo.com
 *   --> GET  /videoplayback itag=399 host=rr3.googlevideo.com 206 1.2s
 *   <-- POST /youtubei/v1/player
 *   --> POST /youtubei/v1/player 200 375ms
 *   <-- GET  /api/manifest/dash/id/TB8RttkATzw local=true
 *   <-- GET  /api/v1/captions/TB8RttkATzw label=English
 *
 * Key design decisions:
 * - Videoplayback URLs: show only itag + host (the two params you need
 *   to identify which stream/format is being proxied)
 * - DASH/captions/latest_version: show the videoId from the path
 * - Player API: just method + path (videoId is in the POST body)
 * - All other routes: show up to 2 key query params
 */

import type { MiddlewareHandler } from "hono";
import { redactUrl } from "../lib/helpers/redactSensitive.ts";

/**
 * Extract a short, meaningful summary from a URL.
 * Returns the pathname + a few relevant query params.
 */
function summarizeUrl(urlStr: string): string {
    // Redact sensitive query params (pot, sig, token, ...) before extracting
    // anything, so they can never reach the logs — including the catch-all
    // branch below that prints arbitrary query params.
    const url = new URL(redactUrl(urlStr));
    const path = url.pathname;

    // Videoplayback: only show itag and host
    if (path.includes("videoplayback")) {
        const itag = url.searchParams.get("itag") || "?";
        const host = url.searchParams.get("host") || "?";
        // Shorten googlevideo host: rr3---sn-bvvbaxivnuxqjvhj5nu-n4vl.googlevideo.com → rr3. googlevideo.com
        const shortHost = host.replace(/^([a-z]+\d*)---[^.]+\./, "$1.");
        return `${path} itag=${itag} host=${shortHost}`;
    }

    // DASH manifest: show videoId from path + local param
    if (path.includes("/api/manifest/dash/id/")) {
        const local = url.searchParams.get("local");
        const parts = path.split("/");
        const videoId = parts[parts.length - 1] || "?";
        const extras = local ? ` local=${local}` : "";
        return `/api/manifest/dash/id/${videoId}${extras}`;
    }

    // Captions: show videoId + label
    if (path.includes("/api/v1/captions/")) {
        const parts = path.split("/");
        const videoId = parts[parts.length - 1] || "?";
        const label = url.searchParams.get("label");
        const extras = label ? ` label=${truncate(label, 20)}` : "";
        return `/api/v1/captions/${videoId}${extras}`;
    }

    // Latest version: show id + itag
    if (path.includes("/latest_version")) {
        const id = url.searchParams.get("id") || "?";
        const itag = url.searchParams.get("itag");
        const extras = itag ? ` itag=${itag}` : "";
        return `/latest_version id=${id}${extras}`;
    }

    // Player API: just the path (videoId is in POST body, not URL)
    if (path.includes("/youtubei/v1/")) {
        return path;
    }

    // Default: show path + first 2 query params
    const paramEntries = [...url.searchParams.entries()].slice(0, 2);
    const extras = paramEntries.map(([k, v]) => `${k}=${truncate(v, 20)}`).join(
        " ",
    );
    return extras ? `${path} ${extras}` : path;
}

function truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen - 1) + "…";
}

function fmtDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

/**
 * Compact logger middleware for Hono.
 * Replaces `import { logger } from "hono/logger"`.
 */
export const compactLogger: MiddlewareHandler = async (c, next) => {
    const method = c.req.method;
    const summary = summarizeUrl(c.req.url);

    // Incoming request
    console.log(`<-- ${method.padEnd(5)} ${summary}`);

    const start = performance.now();
    await next();
    const elapsed = performance.now() - start;

    const status = c.res.status;
    const duration = fmtDuration(Math.round(elapsed));

    c.get("metrics")?.requestLatency.observe(elapsed / 1000);

    console.log(`--> ${method.padEnd(5)} ${summary} ${status} ${duration}`);
};
