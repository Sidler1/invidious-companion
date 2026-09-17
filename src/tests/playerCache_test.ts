import { assert, assertEquals } from "./deps.ts";
import {
    awaitPendingCacheWrites,
    readCachedPlayerResponse,
    videoCacheKey,
    writePlayerCache,
} from "../lib/helpers/playerCache.ts";

Deno.test("player cache helpers", async (t) => {
    const kv = await Deno.openKv(":memory:");

    await t.step("videoCacheKey includes generation and videoId", () => {
        assertEquals(videoCacheKey(3, "abcdefghijk"), [
            "video_cache",
            3,
            "abcdefghijk",
        ]);
    });

    await t.step("returns null on a cache miss", async () => {
        const value = await readCachedPlayerResponse(
            kv,
            videoCacheKey(0, "missing00000"),
        );
        assertEquals(value, null);
    });

    await t.step("round-trips a compressed value", async () => {
        const key = videoCacheKey(0, "roundtrip000");
        const payload = { playabilityStatus: { status: "OK" }, n: 1 };

        await writePlayerCache(kv, key, payload, 60);
        const value = await readCachedPlayerResponse(kv, key);

        assertEquals(value, payload);
    });

    await t.step(
        "deletes a corrupted entry and returns null",
        async () => {
            const key = videoCacheKey(0, "corrupt00000");
            await kv.set(key, new Uint8Array([1, 2, 3, 4, 5]));

            const value = await readCachedPlayerResponse(kv, key);
            const after = await kv.get(key);

            assertEquals(value, null);
            assertEquals(after.value, null);
        },
    );

    await t.step(
        "awaitPendingCacheWrites resolves once in-flight writes settle",
        async () => {
            const key = videoCacheKey(0, "pending00000");
            const write = writePlayerCache(kv, key, { a: 1 }, 60);

            await awaitPendingCacheWrites();
            const value = await readCachedPlayerResponse(kv, key);

            assertEquals(value, { a: 1 });
            await write;
        },
    );

    await t.step("does not reject when the KV write fails", async () => {
        const closedKv = await Deno.openKv(":memory:");
        closedKv.close();
        let rejected = false;

        await writePlayerCache(closedKv, videoCacheKey(0, "x"), {}, 60)
            .catch(() => {
                rejected = true;
            });

        assert(!rejected, "writePlayerCache must swallow and log failures");
    });

    await t.step("returns null when the KV read fails", async () => {
        const closed = await Deno.openKv(":memory:");
        closed.close();

        const value = await readCachedPlayerResponse(
            closed,
            videoCacheKey(0, "x"),
        );

        assertEquals(value, null);
    });

    kv.close();
});
