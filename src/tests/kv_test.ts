import { assert, assertEquals } from "./deps.ts";
import { closeKv, getKv } from "../lib/helpers/kv.ts";
import type { Config } from "../lib/helpers/config.ts";

Deno.test("getKv opens the store under the configured cache directory", async () => {
    const cacheDirectory = await Deno.makeTempDir({ prefix: "kv_test_" });
    const config = {
        cache: { directory: cacheDirectory },
    } as unknown as Config;

    const kv = await getKv(config);
    const kvAgain = await getKv(config);

    assert(kv instanceof Deno.Kv, "getKv should return a Deno.Kv instance");
    assertEquals(kv, kvAgain, "getKv should memoize the handle");
    const stat = await Deno.stat(
        `${cacheDirectory}/youtubei.js/kv_cache.sqlite3`,
    );
    assert(stat.isFile, "KV store file should be created in the cache dir");

    // Clear the module-wide memo so later tests in this process open their
    // own store instead of reusing this (closed) handle.
    await closeKv();
    await Deno.remove(cacheDirectory, { recursive: true });
});
