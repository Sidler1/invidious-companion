import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { decryptQuery } from "../lib/helpers/encryptQuery.ts";

import { resolveAndValidateFetchClientLocation } from "../lib/helpers/dynamicImportValidation.ts";

const getFetchClientLocation = resolveAndValidateFetchClientLocation();
const { getFetchClient } = await import(getFetchClientLocation);

const videoPlaybackProxy = new Hono();

videoPlaybackProxy.options("/", () => {
    return new Response("OK", {
        status: 200,
        headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, OPTIONS",
            "access-control-allow-headers": "Content-Type, Range",
        },
    });
});

/**
 * Streaming video playback proxy.
 *
 * Proxies video content from YouTube's CDN to the client with proper
 * Range header passthrough for seeking support.
 *
 * Design decisions:
 * - NO chunked fetching: YouTube's videoplayback CDN rejects multiple
 *   parallel byte-range requests to the same URL (returns 403). A single
 *   streaming request with ReadableStream piping is both simpler and
 *   more reliable. Backpressure from the pipe ensures memory stays bounded.
 * - Range header passthrough: When the client sends a Range header (seeking),
 *   it's forwarded to YouTube and YouTube's 206 response is returned as-is.
 * - Direct streaming for full requests: For full video requests, we stream
 *   the entire response body directly — no buffering, no chunking.
 */
videoPlaybackProxy.get("/", async (c) => {
    const { host, c: client, expire } = c.req.query();
    const urlReq = new URL(c.req.url);
    const config = c.get("config");
    c.get("metrics")?.videoPlaybackRequests.inc();
    const queryParams = new URLSearchParams(urlReq.search);

    if (c.req.query("enc") === "true") {
        const { data: encryptedQuery } = c.req.query();
        // decryptQuery returns "" on any failure; a malformed/forged `data`
        // param must surface as a 400, not an unhandled JSON.parse → 500.
        let parsed: URLSearchParams;
        try {
            const decryptedQueryParams = await decryptQuery(
                encryptedQuery ?? "",
                config,
            );
            parsed = new URLSearchParams(JSON.parse(decryptedQueryParams));
        } catch {
            throw new HTTPException(400, {
                res: new Response("Invalid encrypted data parameter"),
            });
        }
        queryParams.set("pot", parsed.get("pot") || "");
        queryParams.set("ip", parsed.get("ip") || "");
    }

    // Anchored match: the host query param must be EXACTLY a googlevideo.com
    // subdomain. An unanchored regex would accept "rr3.googlevideo.com.evil.com"
    // or "rr3.googlevideo.com@evil.com", turning this into an SSRF/open proxy.
    if (!host || !/^[\w-]+\.googlevideo\.com$/.test(host)) {
        throw new HTTPException(400, { res: new Response("Invalid host") });
    }

    if (
        !expire || Number(expire) < Math.floor(Date.now() / 1000)
    ) {
        throw new HTTPException(400, { res: new Response("Expired URL") });
    }

    if (!client) {
        throw new HTTPException(400, { res: new Response("Missing client") });
    }

    queryParams.delete("host");
    queryParams.delete("title");

    const headersToSend: HeadersInit = {
        "accept": "*/*",
        "accept-encoding": "gzip, deflate, br, zstd",
        "accept-language": "en-us,en;q=0.5",
        "origin": "https://www.youtube.com",
        "referer": "https://www.youtube.com",
        "user-agent": client === "ANDROID"
            ? "com.google.android.youtube/1537338816 (Linux; U; Android 13; en_US; ; Build/TQ2A.230505.002; Cronet/113.0.5672.24)"
            : client === "IOS"
            ? "com.google.ios.youtube/19.32.8 (iPhone14,5; U; CPU iOS 17_6 like Mac OS X;)"
            : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    };

    // getFetchClient is a singleton — returns the same cached fetch function
    // with shared proxy pool state, health tracking, and round-robin index.
    const fetchClient = getFetchClient(config);
    const location = `https://${host}/videoplayback?${queryParams.toString()}`;

    // If client sent a Range request (seeking), pass it through directly to YouTube
    // and return YouTube's 206 Partial Content response as-is.
    const rangeHeader = c.req.header("range");
    const requestHeaders: Record<string, string> = { ...headersToSend };
    if (rangeHeader) {
        requestHeaders["Range"] = rangeHeader;
    }

    const ytRes = await fetchClient(location, {
        method: "GET",
        headers: requestHeaders,
        redirect: "manual",
    });

    // Build response headers — pass through content-type, content-length,
    // content-range for proper seeking support
    const responseHeaders: Record<string, string> = {
        "content-type": ytRes.headers.get("content-type") || "video/mp4",
        "accept-ranges": "bytes",
        "access-control-allow-origin": "*",
    };

    // Pass through content-length when available
    const contentLength = ytRes.headers.get("content-length");
    if (contentLength) {
        responseHeaders["content-length"] = contentLength;
    }

    // Pass through content-range for partial content responses (seeking)
    if (ytRes.status === 206) {
        const contentRange = ytRes.headers.get("content-range");
        if (contentRange) {
            responseHeaders["content-range"] = contentRange;
        }
    }

    return new Response(ytRes.body, {
        status: ytRes.status,
        headers: responseHeaders,
    });
});

export default videoPlaybackProxy;
