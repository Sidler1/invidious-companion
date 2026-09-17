import { compress, decompress } from "brotli";
import { CTX, logError } from "./log.ts";
import { awaitPendingWrites, trackPendingWrite } from "./pendingWrites.ts";

export const VIDEO_CACHE_PREFIX = "video_cache";

/**
 * Cache key for a trimmed player response. `generation` is the session
 * generation the response was produced under (see `sharedState` in
 * main.ts): deciphered stream URLs embed the `ip=`/`pot=` of the session that
 * fetched them, so an entry from an older session must never be served after
 * a regeneration or an egress-proxy hop.
 */
export function videoCacheKey(
    generation: number,
    videoId: string,
): Deno.KvKey {
    return [VIDEO_CACHE_PREFIX, generation, videoId];
}

function keyLabel(key: Deno.KvKey): string {
    return String(key.at(-1));
}

/**
 * Read and decompress a cached player response. A corrupted entry is deleted
 * and treated as a miss so the caller falls through to a fresh fetch.
 */
export async function readCachedPlayerResponse(
    kv: Deno.Kv,
    key: Deno.KvKey,
): Promise<object | null> {
    const entry = await kv.get<Uint8Array>(key);
    if (entry.value == null) return null;
    try {
        return JSON.parse(new TextDecoder().decode(decompress(entry.value)));
    } catch (err) {
        logError(
            CTX.CACHE,
            `Decompression failed for ${
                keyLabel(key)
            }, deleting corrupted entry`,
            err,
        );
        try {
            await kv.delete(key);
        } catch (delErr) {
            logError(
                CTX.CACHE,
                `Failed to delete corrupted entry for ${keyLabel(key)}`,
                delErr,
            );
        }
        return null;
    }
}

/**
 * Compress and store a player response with a TTL. The single write path for
 * both positive and negative caching. Never rejects: failures are logged.
 * Writes are tracked by pendingWrites so graceful shutdown can drain them.
 */
export function writePlayerCache(
    kv: Deno.Kv,
    key: Deno.KvKey,
    value: object,
    ttlSeconds: number,
): Promise<void> {
    const write = (async () => {
        try {
            await kv.set(
                key,
                compress(new TextEncoder().encode(JSON.stringify(value))),
                { expireIn: ttlSeconds * 1000 },
            );
        } catch (err) {
            logError(
                CTX.CACHE,
                `Failed to write ${keyLabel(key)} to cache`,
                err,
            );
        }
    })();
    trackPendingWrite(write);
    return write;
}

/** Resolves once every in-flight cache write has settled. */
export function awaitPendingCacheWrites(): Promise<void> {
    return awaitPendingWrites();
}
