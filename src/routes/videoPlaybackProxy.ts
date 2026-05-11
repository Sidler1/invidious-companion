import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { decryptQuery } from "../lib/helpers/encryptQuery.ts";
import { StreamingApi } from "hono/utils/stream";

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

videoPlaybackProxy.get("/", async (c) => {
    const { host, c: client, expire } = c.req.query();
    const urlReq = new URL(c.req.url);
    const config = c.get("config");
    const queryParams = new URLSearchParams(urlReq.search);

    if (c.req.query("enc") === "true") {
        const { data: encryptedQuery } = c.req.query();
        const decryptedQueryParams = decryptQuery(encryptedQuery, config);
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

    const rangeHeader = c.req.header("range");
    const requestBytes = rangeHeader ? rangeHeader.split("=")[1] : null;
    if (requestBytes) queryParams.append("range", requestBytes);

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

    // HEAD request to get metadata
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
    const { readable, writable } = new TransformStream();
    const stream = new StreamingApi(writable, readable);

    const MAX_CONCURRENT = 6;
    const tasks: (() => Promise<Response>)[] = [];

    for (let start = 0; start < totalBytes; start += chunkSize) {
        const end = Math.min(start + chunkSize - 1, totalBytes - 1);
        tasks.push(async () => {
            const url = new URL(location);
            url.searchParams.set("range", `${start}-${end}`);
            const res = await fetchClient(url, {
                method: "GET",
                headers: headersToSend,
            });
            if (res.status !== 200 && res.status !== 206) {
                throw new Error(`Chunk failed with status ${res.status}`);
            }
            return res;
        });
    }

    // Order-preserving concurrent fetch
    const runWithConcurrency = async <T>(
        taskFns: (() => Promise<T>)[],
        limit: number,
    ): Promise<T[]> => {
        const results: T[] = new Array(taskFns.length);
        let index = 0;
        const workers = Array.from(
            { length: Math.min(limit, taskFns.length) },
            async () => {
                while (index < taskFns.length) {
                    const current = index++;
                    results[current] = await taskFns[current]();
                }
            },
        );
        await Promise.all(workers);
        return results;
    };

    try {
        const responses = await runWithConcurrency(tasks, MAX_CONCURRENT);
        for (const res of responses) {
            await stream.pipe(res.body!);
        }
    } catch (err) {
        console.warn(
            `[WARN] Chunk streaming failed, falling back to single request\n[ERROR] ${err}`,
        );
        // Fallback: single request
        const fallback = await fetchClient(location, {
            headers: headersToSend,
        });
        await stream.pipe(fallback.body!);
    }

    return new Response(stream.responseReadable, {
        status: 206,
        headers: {
            "content-type": headRes.headers.get("content-type") || "video/mp4",
            "content-length": headRes.headers.get("content-length") || "",
            "accept-ranges": "bytes",
        },
    });
});

export default videoPlaybackProxy;
