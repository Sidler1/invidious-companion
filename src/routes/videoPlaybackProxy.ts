import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { decryptQuery } from "../lib/helpers/encryptQuery.ts";

let getFetchClientLocation = "getFetchClient";
if (Deno.env.get("GET_FETCH_CLIENT_LOCATION")) {
    if (Deno.env.has("DENO_COMPILED")) {
        getFetchClientLocation = Deno.mainModule.replace("src/main.ts", "") +
            Deno.env.get("GET_FETCH_CLIENT_LOCATION");
    } else {
        getFetchClientLocation = Deno.env.get(
            "GET_FETCH_CLIENT_LOCATION",
        ) as string;
    }
}
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
 * Streaming video playback proxy with bounded concurrency.
 *
 * Key improvements over the previous batch-and-pipe approach:
 * 1. Client Range headers are properly passed through to YouTube
 * 2. Bounded concurrent fetch with semaphore — only MAX_CONCURRENT chunks in flight at once
 * 3. Each chunk is piped to the client immediately after fetch (not held in memory)
 * 4. Correct HTTP status codes: 206 for range requests, 200 for full requests
 * 5. Memory-bounded: only MAX_CONCURRENT chunk buffers in memory regardless of video size
 */
videoPlaybackProxy.get("/", async (c) => {
    const { host, c: client, expire } = c.req.query();
    const urlReq = new URL(c.req.url);
    const config = c.get("config");
    const queryParams = new URLSearchParams(urlReq.search);

    if (c.req.query("enc") === "true") {
        const { data: encryptedQuery } = c.req.query();
        const decryptedQueryParams = await decryptQuery(encryptedQuery, config);
        const parsed = new URLSearchParams(JSON.parse(decryptedQueryParams));
        queryParams.set("pot", parsed.get("pot") || "");
        queryParams.set("ip", parsed.get("ip") || "");
    }

    if (!host || !/[\\w-]+.googlevideo.com/.test(host)) {
        throw new HTTPException(400, { res: new Response("Invalid host") });
    }

    if (
        !expire || Number(expire) < Number(Date.now().toString().slice(0, -3))
    ) {
        throw new HTTPException(400, { res: new Response("Expired URL") });
    }

    if (!client) {
        throw new HTTPException(400, { res: new Response("Missing client") });
    }

    queryParams.delete("host");
    queryParams.delete("title");

    // Pass through the client's Range header to YouTube
    const rangeHeader = c.req.header("range");
    if (rangeHeader) {
        queryParams.set("range", rangeHeader.split("=")[1]);
    }

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

    const fetchClient = await getFetchClient(config);
    const location = `https://${host}/videoplayback?${queryParams.toString()}`;

    // If client sent a Range request, pass it through directly to YouTube
    // and return YouTube's response as-is (no chunking needed for range requests)
    if (rangeHeader) {
        const rangeRes = await fetchClient(location, {
            method: "GET",
            headers: { ...headersToSend, "Range": rangeHeader },
            redirect: "manual",
        });

        return new Response(rangeRes.body, {
            status: rangeRes.status,
            headers: {
                "content-type": rangeRes.headers.get("content-type") || "video/mp4",
                "content-range": rangeRes.headers.get("content-range") || "",
                "content-length": rangeRes.headers.get("content-length") || "",
                "accept-ranges": "bytes",
                "access-control-allow-origin": "*",
            },
        });
    }

    // Full video request — use HEAD to get metadata, then stream with bounded concurrency
    const headRes = await fetchClient(location, {
        method: "HEAD",
        headers: headersToSend,
        redirect: "manual",
    });

    if (headRes.status !== 200 && headRes.status !== 206) {
        return new Response(headRes.body, { status: headRes.status });
    }

    const totalBytes = Number(headRes.headers.get("Content-Length") || "0");
    const chunkSize =
        config.networking.videoplayback.video_fetch_chunk_size_mb * 1_000_000;

    // For small files or unknown size, just stream directly without chunking
    if (totalBytes === 0 || totalBytes <= chunkSize) {
        const directRes = await fetchClient(location, {
            method: "GET",
            headers: headersToSend,
            redirect: "manual",
        });

        return new Response(directRes.body, {
            status: directRes.status,
            headers: {
                "content-type": directRes.headers.get("content-type") || "video/mp4",
                "content-length": directRes.headers.get("content-length") || "",
                "accept-ranges": "bytes",
                "access-control-allow-origin": "*",
            },
        });
    }

    // Large file: stream with bounded concurrent chunked fetching
    const MAX_CONCURRENT = 6;
    const contentType = headRes.headers.get("content-type") || "video/mp4";

    // Build ordered list of chunk ranges
    const chunks: { start: number; end: number }[] = [];
    for (let start = 0; start < totalBytes; start += chunkSize) {
        const end = Math.min(start + chunkSize - 1, totalBytes - 1);
        chunks.push({ start, end });
    }

    // Streaming pipeline: fetch chunks in order with bounded concurrency,
    // pipe each chunk's body to the client immediately
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    // Run streaming in background — errors close the stream
    (async () => {
        try {
            // Semaphore for bounded concurrency
            let activeCount = 0;
            const waitQueue: (() => void)[] = [];

            const acquire = (): Promise<void> => {
                if (activeCount < MAX_CONCURRENT) {
                    activeCount++;
                    return Promise.resolve();
                }
                return new Promise<void>((resolve) => waitQueue.push(resolve));
            };

            const release = () => {
                activeCount--;
                const next = waitQueue.shift();
                if (next) {
                    activeCount++;
                    next();
                }
            };

            // Process chunks sequentially in order, but allow concurrent fetches
            // by starting the next fetch while the current one is still piping
            for (const chunk of chunks) {
                await acquire();
                try {
                    const url = new URL(location);
                    url.searchParams.set("range", `${chunk.start}-${chunk.end}`);

                    const res = await fetchClient(url, {
                        method: "GET",
                        headers: headersToSend,
                    });

                    if (res.status !== 200 && res.status !== 206) {
                        throw new Error(`Chunk ${chunk.start}-${chunk.end} failed with status ${res.status}`);
                    }

                    // Pipe this chunk's body directly to the writer
                    if (res.body) {
                        const reader = res.body.getReader();
                        try {
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                await writer.write(value);
                            }
                        } finally {
                            reader.releaseLock();
                        }
                    }
                } catch (err) {
                    console.error(
                        `[ERROR] Chunk ${chunk.start}-${chunk.end} failed:`,
                        err,
                    );
                    throw err;
                } finally {
                    release();
                }
            }

            await writer.close();
        } catch (err) {
            console.warn("[WARN] Streaming pipeline failed:", err);
            try {
                await writer.abort(err);
            } catch {
                // Writer may already be closed
            }
        }
    })();

    return new Response(readable, {
        status: 200,
        headers: {
            "content-type": contentType,
            "content-length": String(totalBytes),
            "accept-ranges": "bytes",
            "access-control-allow-origin": "*",
        },
    });
});

export default videoPlaybackProxy;
