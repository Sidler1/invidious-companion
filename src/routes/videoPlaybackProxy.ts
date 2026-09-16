import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { USER_AGENT } from "bgutils";
import { decryptQuery } from "../lib/helpers/encryptQuery.ts";
import type { Config } from "../lib/helpers/config.ts";
import type { FetchFn } from "../lib/helpers/fetchShim.ts";
import {
    isGooglevideoHost,
    isValidExpire,
    resolveRedirectTarget,
} from "../lib/helpers/googlevideoUrl.ts";

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

// https://datatracker.ietf.org/doc/html/rfc9110#section-15.4 recommends
// capping redirect chains; upstream invidious-companion also uses 5.
const MAX_REDIRECTS = 5;

const ANDROID_USER_AGENT =
    "com.google.android.youtube/1537338816 (Linux; U; Android 13; en_US; ; Build/TQ2A.230505.002; Cronet/113.0.5672.24)";
const IOS_USER_AGENT =
    "com.google.ios.youtube/19.32.8 (iPhone14,5; U; CPU iOS 17_6 like Mac OS X;)";

function userAgentForClient(client: string): string {
    // For WEB/TV/default streams use the same UA as the Innertube session
    // that minted the stream's GVS pot — a UA that disagrees with the
    // minting session is an easy 403/bot signal. ANDROID/IOS streams keep
    // their native client UAs.
    if (client === "ANDROID") return ANDROID_USER_AGENT;
    if (client === "IOS") return IOS_USER_AGENT;
    return USER_AGENT;
}

async function applyEncryptedParams(
    queryParams: URLSearchParams,
    encryptedQuery: string | undefined,
    config: Config,
): Promise<void> {
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

/**
 * Fetch `location`, following googlevideo-to-googlevideo redirects by hand.
 * `redirect: "manual"` is used so every hop is validated against the
 * anchored host pattern instead of letting fetch follow blindly.
 */
async function fetchFollowingRedirects(
    fetchClient: FetchFn,
    location: string,
    headers: Record<string, string>,
): Promise<Response> {
    let current = location;
    for (let redirects = 0;; redirects++) {
        const res = await fetchClient(current, {
            method: "GET",
            headers,
            redirect: "manual",
            // Video bodies can take minutes; never attach a whole-body timeout.
            streaming: true,
        });
        const locationHeader = res.headers.get("location");
        const isRedirect = res.status >= 300 && res.status < 400 &&
            locationHeader !== null;
        if (!isRedirect) return res;

        // Drop the redirect body before moving on.
        await res.body?.cancel().catch(() => {});
        if (redirects >= MAX_REDIRECTS) {
            throw new HTTPException(502, {
                res: new Response("Too many redirects."),
            });
        }
        const next = resolveRedirectTarget(locationHeader, current);
        if (!next) {
            throw new HTTPException(400, {
                res: new Response("Invalid redirect target."),
            });
        }
        current = next;
    }
}

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
 * - Redirects are followed manually (max 5) and only to googlevideo hosts.
 */
videoPlaybackProxy.get("/", async (c) => {
    const { host, c: client, expire } = c.req.query();
    const urlReq = new URL(c.req.url);
    const config = c.get("config") as Config;
    c.get("metrics")?.videoPlaybackRequests.inc();
    const queryParams = new URLSearchParams(urlReq.search);

    if (c.req.query("enc") === "true") {
        await applyEncryptedParams(queryParams, c.req.query("data"), config);
    }

    if (!isGooglevideoHost(host)) {
        throw new HTTPException(400, { res: new Response("Invalid host") });
    }

    if (!isValidExpire(expire, Math.floor(Date.now() / 1000))) {
        throw new HTTPException(400, { res: new Response("Expired URL") });
    }

    if (!client) {
        throw new HTTPException(400, { res: new Response("Missing client") });
    }

    // Our own routing/encryption params must not reach the CDN.
    queryParams.delete("host");
    queryParams.delete("title");
    queryParams.delete("enc");
    queryParams.delete("data");

    const requestHeaders: Record<string, string> = {
        "accept": "*/*",
        "accept-encoding": "gzip, deflate, br, zstd",
        "accept-language": "en-us,en;q=0.5",
        "origin": "https://www.youtube.com",
        "referer": "https://www.youtube.com",
        "user-agent": userAgentForClient(client),
    };

    // If client sent a Range request (seeking), pass it through directly to
    // YouTube and return YouTube's 206 Partial Content response as-is.
    const rangeHeader = c.req.header("range");
    if (rangeHeader) {
        requestHeaders["Range"] = rangeHeader;
    }

    // getFetchClient is a singleton — returns the same cached fetch function
    // with shared proxy pool state, health tracking, and round-robin index.
    const fetchClient = getFetchClient(config) as FetchFn;
    const location = `https://${host}/videoplayback?${queryParams.toString()}`;
    const ytRes = await fetchFollowingRedirects(
        fetchClient,
        location,
        requestHeaders,
    );

    // Build response headers — pass through content-type, content-length,
    // content-range for proper seeking support
    const responseHeaders: Record<string, string> = {
        "content-type": ytRes.headers.get("content-type") || "video/mp4",
        "accept-ranges": "bytes",
        "access-control-allow-origin": "*",
    };

    const contentLength = ytRes.headers.get("content-length");
    if (contentLength) {
        responseHeaders["content-length"] = contentLength;
    }

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
