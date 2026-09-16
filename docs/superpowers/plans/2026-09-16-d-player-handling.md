# Player Handling (Spec Section D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the player pipeline return a trimmed, non-throwing shape for `playabilityStatus.status === "ERROR"`, key the KV video cache by session generation, validate route inputs, base the decipher decision on the client that actually supplied the streams, and split the 240-line `youtubePlayerParsing` into small testable helpers.

**Architecture:** `youtubePlayerParsing` (`src/lib/helpers/youtubePlayerHandling.ts`) becomes an orchestrator over three new pure-ish modules: `playerCache.ts` (brotli + Deno KV read/write with one shared write path), `playerDecipher.ts` (URL deciphering/`pot` finalisation driven by a per-array client tag), and `playability.ts` (status inspection + the 403 guard routes use). `youtubePlayerReq` tags which Innertube client supplied `formats`/`adaptiveFormats`. `main.ts` gains a monotonically increasing `sessionGeneration` in `sharedState` that is injected into the Hono context and used as a cache-key component. Unit tests use `Deno.openKv(":memory:")` and a stubbed `playerReq` so nothing touches YouTube.

**Tech Stack:** Deno 2.9, Hono 4.13, YouTube.js v18.0.0 (`youtubei.js`), Zod 3, `brotli` (deno.land/x), Deno KV, `@std/assert` via `src/tests/deps.ts`.

**Spec:** `docs/superpowers/specs/2026-09-16-code-review-findings.md` — section **D (D1–D5)**. Read it first; this plan argues from it.

## Global Constraints

- Runtime: Deno 2.9.x (Docker), `deno.json` tasks are the single source of truth for permission flags. Formatter indent width is **4**.
- Every change must pass `deno task format`, `deno task check`, `deno task lint` and `deno task test` (`SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa`).
- The Invidious ↔ companion contract (routes, query names, status codes, response bodies, `check`/`enc`/`data` wire format) must not change unless the finding says so explicitly; then `../invidious/` must be updated in lockstep.
- Logging goes through `logInfo/logWarn/logError/logDebug(CTX.X, msg)` from `src/lib/helpers/log.ts`. No bare `console.*` in `src/` outside `log.ts`.
- Immutability preferred; no mutation of shared objects outside `sharedState`.
- Files ≤ 800 lines, functions ≤ 50 lines where reasonably achievable.
- Tests: pure-unit tests must not need network. Integration tests live behind `main_test.ts`. Test names describe behaviour.
- Commit format: `<type>: <description>` (feat, fix, refactor, docs, test, chore, perf, ci). Attribution trailers as configured for the session.

**Plan-local conventions**

- Run a single test file with: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/<file>` (the `test` task accepts extra args; it already grants `/tmp` read/write which `Deno.openKv(":memory:")` does not need but `makeTempDir` does).
- Run the full gate before every commit: `deno fmt src/** && deno task format && deno task check && deno task lint`.
- Plan **A** (session lifecycle) also edits `src/main.ts`. Task 5 of this plan adds only a few additive lines to `sharedState` and the two middleware blocks so both plans merge cleanly. Plan A's task for spec item A6 should call `awaitPendingCacheWrites()` (Task 1 of this plan) before `closeKv()`.
- YouTube.js v18 verification for D1 (from the Deno remote cache, `deno/src/core/mixins/MediaInfo.ts`, `MediaInfo` constructor, which `YT.VideoInfo` extends):

  ```ts
  const info = Parser.parseResponse<IPlayerResponse>(data[0].data.playerResponse ? data[0].data.playerResponse : data[0].data);
  ...
  if (info.playability_status?.status === 'ERROR')
    throw new InnertubeError('This video is unavailable', info.playability_status);
  ```

  So `youtubeVideoInfo(innertubeClient, json)` throws for any ERROR response; every route that calls it must check the status on the raw JSON first.

---

## File map

| File | Responsibility | Task |
|---|---|---|
| Create `src/lib/helpers/playerCache.ts` | `videoCacheKey`, `readCachedPlayerResponse`, `writePlayerCache`, `awaitPendingCacheWrites` (brotli + KV, one write path, tracked writes) | 1 |
| Create `src/tests/playerCache_test.ts` | in-memory KV tests for the cache helpers | 1 |
| Create `src/lib/helpers/playerDecipher.ts` | `needsDecipher`, `finalizeStreamUrl`, `decipherStreamingData`, `StreamingDataClients`, `DEFAULT_STREAMING_DATA_CLIENTS` | 2 |
| Create `src/tests/playerDecipher_test.ts` | pure tests with stub decipherables | 2 |
| Modify `src/lib/helpers/youtubePlayerReq.ts` | tag `data.streamingDataClients` on primary and fallback | 3 |
| Create `src/tests/youtubePlayerReq_test.ts` | stubbed `actions.execute` fallback tests | 3 |
| Modify `src/lib/helpers/youtubePlayerHandling.ts` | orchestrate helpers; always trim; ERROR metrics + negative cache; `cacheGeneration`; KV only when cache enabled; `deps` seam; `trimPlayerResponse` | 4 |
| Create `src/tests/youtubePlayerHandling_test.ts` | ERROR path, negative cache, cache hit, generation isolation, cache-disabled | 4 |
| Modify `src/lib/types/HonoVariables.ts`, `src/main.ts` | `sessionGeneration` in `sharedState` + context | 5 |
| Create `src/lib/helpers/playability.ts` | `getPlayabilityStatus`, `assertPlayable` | 6 |
| Create `src/tests/playability_test.ts` | guard tests | 6 |
| Modify `src/routes/youtube_api_routes/player.ts` | Zod body validation, typed Hono, pass `cacheGeneration` | 6 |
| Create `src/tests/playerRoute_test.ts` | `app.request` body-validation tests | 6 |
| Modify `src/routes/invidious_routes/dashManifest.ts`, `latestVersion.ts`, `captions.ts` | status check before `youtubeVideoInfo`, DASH 404, pass `cacheGeneration` | 6 |

---

### Task 1: Player cache helpers (`playerCache.ts`) — spec D5, foundation for D2/D3

**Files:**
- Create: `src/lib/helpers/playerCache.ts`
- Test: `src/tests/playerCache_test.ts`

**Interfaces:**
- Consumes: `compress`/`decompress` from `"brotli"`, `CTX`/`logError` from `./log.ts`.
- Produces (used by Task 4 and by plan A's A6 task):
  - `export const VIDEO_CACHE_PREFIX = "video_cache"`
  - `export function videoCacheKey(generation: number, videoId: string): Deno.KvKey` → `["video_cache", generation, videoId]`
  - `export async function readCachedPlayerResponse(kv: Deno.Kv, key: Deno.KvKey): Promise<object | null>` — returns `null` on miss or on a corrupted entry (which it deletes).
  - `export function writePlayerCache(kv: Deno.Kv, key: Deno.KvKey, value: object, ttlSeconds: number): Promise<void>` — never rejects; logs failures.
  - `export async function awaitPendingCacheWrites(): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/tests/playerCache_test.ts`:

```ts
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

    kv.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/playerCache_test.ts`
Expected: FAIL — `error: Module not found "file:///.../src/lib/helpers/playerCache.ts"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/helpers/playerCache.ts`:

```ts
import { compress, decompress } from "brotli";
import { CTX, logError } from "./log.ts";

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

// Writes are fire-and-forget on the request path; the shutdown sequence
// awaits them (awaitPendingCacheWrites) before closing the KV handle.
const pendingCacheWrites = new Set<Promise<void>>();

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
            `Decompression failed for ${keyLabel(key)}, deleting corrupted entry`,
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
    pendingCacheWrites.add(write);
    write.finally(() => pendingCacheWrites.delete(write));
    return write;
}

/** Resolves once every in-flight cache write has settled. */
export async function awaitPendingCacheWrites(): Promise<void> {
    await Promise.all([...pendingCacheWrites]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/playerCache_test.ts`
Expected: `ok | 1 passed (6 steps) | 0 failed`.

- [ ] **Step 5: Gate and commit**

Run: `deno fmt src/** && deno task format && deno task check && deno task lint`
Expected: all four succeed (`Checked N files`, no errors).

```bash
git add src/lib/helpers/playerCache.ts src/tests/playerCache_test.ts
git commit -m "refactor: extract brotli/KV player cache helpers with tracked writes"
```

---

### Task 2: Stream deciphering helpers (`playerDecipher.ts`) — spec D5, D4 foundation

**Files:**
- Create: `src/lib/helpers/playerDecipher.ts`
- Test: `src/tests/playerDecipher_test.ts`

**Interfaces:**
- Consumes: `Innertube` type from `"youtubei.js"` (for `Innertube["session"]["player"]`).
- Produces (used by Tasks 3 and 4):
  - `export interface StreamingDataClients { formats: string; adaptiveFormats: string }`
  - `export const DEFAULT_STREAMING_DATA_CLIENTS: StreamingDataClients` = `{ formats: "WEB", adaptiveFormats: "WEB" }`
  - `export function needsDecipher(clientName: string): boolean` — false for names containing `IOS` or `ANDROID`.
  - `export function finalizeStreamUrl(url: string, sessionPoToken: string | undefined): string`
  - `export interface Decipherable { decipher(player?: PlayerLike): Promise<string> }`
  - `export interface RawFormat { url?: string; signatureCipher?: string; [key: string]: unknown }`
  - `export interface RawStreamingData { formats?: RawFormat[]; adaptiveFormats?: RawFormat[]; [key: string]: unknown }`
  - `export async function decipherStreamingData(parsed: { formats: Decipherable[]; adaptive_formats: Decipherable[] }, raw: RawStreamingData, opts: { player: PlayerLike; sessionPoToken: string | undefined; clients: StreamingDataClients }): Promise<RawStreamingData>` — returns a **new** object; arrays whose client does not need deciphering are passed through untouched (this is the existing behaviour for IOS/ANDROID primaries, now applied per array).

- [ ] **Step 1: Write the failing test**

Create `src/tests/playerDecipher_test.ts`:

```ts
import { assertEquals } from "./deps.ts";
import {
    decipherStreamingData,
    DEFAULT_STREAMING_DATA_CLIENTS,
    finalizeStreamUrl,
    needsDecipher,
} from "../lib/helpers/playerDecipher.ts";

Deno.test("needsDecipher", async (t) => {
    await t.step("is true for web-family clients", () => {
        assertEquals(needsDecipher("WEB"), true);
        assertEquals(needsDecipher("TV_SIMPLY"), true);
        assertEquals(needsDecipher("MWEB"), true);
    });

    await t.step("is false for IOS and ANDROID clients", () => {
        assertEquals(needsDecipher("IOS"), false);
        assertEquals(needsDecipher("ANDROID"), false);
        assertEquals(needsDecipher("ANDROID_VR"), false);
    });
});

Deno.test("finalizeStreamUrl", async (t) => {
    await t.step("rewrites alr=yes to alr=no", () => {
        assertEquals(
            finalizeStreamUrl("https://h/videoplayback?alr=yes&n=1", undefined),
            "https://h/videoplayback?alr=no&n=1",
        );
    });

    await t.step("appends alr=no when absent", () => {
        assertEquals(
            finalizeStreamUrl("https://h/videoplayback?n=1", undefined),
            "https://h/videoplayback?n=1&alr=no",
        );
    });

    await t.step("appends the session pot when missing", () => {
        assertEquals(
            finalizeStreamUrl("https://h/videoplayback?n=1", "a b"),
            "https://h/videoplayback?n=1&alr=no&pot=a%20b",
        );
    });

    await t.step("does not duplicate an existing pot", () => {
        assertEquals(
            finalizeStreamUrl("https://h/videoplayback?pot=x&n=1", "y"),
            "https://h/videoplayback?pot=x&n=1&alr=no",
        );
    });
});

Deno.test("decipherStreamingData", async (t) => {
    const stub = (url: string) => ({ decipher: () => Promise.resolve(url) });

    await t.step(
        "deciphers both arrays for web clients and drops signatureCipher",
        async () => {
            const raw = {
                expiresInSeconds: "21540",
                formats: [{ itag: 18, signatureCipher: "s=1&url=x" }],
                adaptiveFormats: [{ itag: 137, signatureCipher: "s=2&url=y" }],
            };

            const out = await decipherStreamingData(
                {
                    formats: [stub("https://h/videoplayback?itag=18")],
                    adaptive_formats: [stub("https://h/videoplayback?itag=137")],
                },
                raw,
                {
                    player: undefined,
                    sessionPoToken: "tok",
                    clients: DEFAULT_STREAMING_DATA_CLIENTS,
                },
            );

            assertEquals(out.expiresInSeconds, "21540");
            assertEquals(out.formats, [{
                itag: 18,
                url: "https://h/videoplayback?itag=18&alr=no&pot=tok",
            }]);
            assertEquals(out.adaptiveFormats, [{
                itag: 137,
                url: "https://h/videoplayback?itag=137&alr=no&pot=tok",
            }]);
            // Input must not be mutated.
            assertEquals(raw.formats[0].signatureCipher, "s=1&url=x");
        },
    );

    await t.step(
        "passes an array through untouched when its client is ANDROID",
        async () => {
            const raw = {
                formats: [{ itag: 18, signatureCipher: "s=1&url=x" }],
                adaptiveFormats: [{ itag: 137, url: "https://h/a?n=1" }],
            };

            const out = await decipherStreamingData(
                {
                    formats: [stub("https://h/videoplayback?itag=18")],
                    adaptive_formats: [stub("https://h/should-not-be-used")],
                },
                raw,
                {
                    player: undefined,
                    sessionPoToken: "tok",
                    clients: { formats: "WEB", adaptiveFormats: "ANDROID_VR" },
                },
            );

            assertEquals(out.formats, [{
                itag: 18,
                url: "https://h/videoplayback?itag=18&alr=no&pot=tok",
            }]);
            assertEquals(out.adaptiveFormats, raw.adaptiveFormats);
        },
    );

    await t.step("tolerates missing arrays", async () => {
        const out = await decipherStreamingData(
            { formats: [], adaptive_formats: [] },
            { hlsManifestUrl: "https://h/m3u8" },
            {
                player: undefined,
                sessionPoToken: undefined,
                clients: DEFAULT_STREAMING_DATA_CLIENTS,
            },
        );
        assertEquals(out, {
            hlsManifestUrl: "https://h/m3u8",
            formats: undefined,
            adaptiveFormats: undefined,
        });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/playerDecipher_test.ts`
Expected: FAIL — `Module not found ".../src/lib/helpers/playerDecipher.ts"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/helpers/playerDecipher.ts`:

```ts
import type { Innertube } from "youtubei.js";

type PlayerLike = Innertube["session"]["player"];

/** Which Innertube client supplied each streaming-data array. */
export interface StreamingDataClients {
    formats: string;
    adaptiveFormats: string;
}

export const DEFAULT_STREAMING_DATA_CLIENTS: StreamingDataClients = {
    formats: "WEB",
    adaptiveFormats: "WEB",
};

/** Structural view of a youtubei.js `Format` — only what we call. */
export interface Decipherable {
    decipher(player?: PlayerLike): Promise<string>;
}

export interface RawFormat {
    url?: string;
    signatureCipher?: string;
    [key: string]: unknown;
}

export interface RawStreamingData {
    formats?: RawFormat[];
    adaptiveFormats?: RawFormat[];
    [key: string]: unknown;
}

/**
 * IOS/ANDROID-family clients return plain URLs that need neither signature
 * nor n-parameter deciphering and must not carry the web session's GVS pot.
 */
export function needsDecipher(clientName: string): boolean {
    return !clientName.includes("IOS") && !clientName.includes("ANDROID");
}

/**
 * Force `alr=no` and append the session PO token (the GVS `pot` web-family
 * clients must carry on `videoplayback`). youtubei.js's `Format.decipher()`
 * only descrambles signature/nsig; without `pot` the CDN throttles/403s.
 */
export function finalizeStreamUrl(
    url: string,
    sessionPoToken: string | undefined,
): string {
    const withAlr = url.includes("alr=yes")
        ? url.replace("alr=yes", "alr=no")
        : `${url}&alr=no`;
    if (sessionPoToken && !withAlr.includes("pot=")) {
        return `${withAlr}&pot=${encodeURIComponent(sessionPoToken)}`;
    }
    return withAlr;
}

async function decipherFormats(
    parsed: Decipherable[],
    raw: RawFormat[],
    player: PlayerLike,
    sessionPoToken: string | undefined,
): Promise<RawFormat[]> {
    const count = Math.min(parsed.length, raw.length);
    const out: RawFormat[] = [];
    for (let index = 0; index < count; index++) {
        const { signatureCipher: _dropped, ...rest } = raw[index];
        const url = finalizeStreamUrl(
            await parsed[index].decipher(player),
            sessionPoToken,
        );
        out.push({ ...rest, url });
    }
    return out;
}

/**
 * Return a copy of `raw` with deciphered, finalised URLs. `parsed` is the
 * youtubei.js `streaming_data` built from the same response (its format
 * arrays are index-aligned with `raw`, since v18 `parseFormats` is a plain
 * `map`). Arrays supplied by an IOS/ANDROID client are returned as-is.
 */
export async function decipherStreamingData(
    parsed: { formats: Decipherable[]; adaptive_formats: Decipherable[] },
    raw: RawStreamingData,
    opts: {
        player: PlayerLike;
        sessionPoToken: string | undefined;
        clients: StreamingDataClients;
    },
): Promise<RawStreamingData> {
    const formats = raw.formats && needsDecipher(opts.clients.formats)
        ? await decipherFormats(
            parsed.formats,
            raw.formats,
            opts.player,
            opts.sessionPoToken,
        )
        : raw.formats;
    const adaptiveFormats = raw.adaptiveFormats &&
            needsDecipher(opts.clients.adaptiveFormats)
        ? await decipherFormats(
            parsed.adaptive_formats,
            raw.adaptiveFormats,
            opts.player,
            opts.sessionPoToken,
        )
        : raw.adaptiveFormats;
    return { ...raw, formats, adaptiveFormats };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/playerDecipher_test.ts`
Expected: `ok | 3 passed (9 steps) | 0 failed`.

- [ ] **Step 5: Gate and commit**

Run: `deno fmt src/** && deno task format && deno task check && deno task lint`
Expected: all succeed.

```bash
git add src/lib/helpers/playerDecipher.ts src/tests/playerDecipher_test.ts
git commit -m "refactor: extract stream URL deciphering into playerDecipher helpers"
```

---

### Task 3: Tag which client supplied the streams (`youtubePlayerReq.ts`) — spec D4

**Files:**
- Modify: `src/lib/helpers/youtubePlayerReq.ts:64-155`
- Test: `src/tests/youtubePlayerReq_test.ts`

**Interfaces:**
- Consumes: `StreamingDataClients` from Task 2.
- Produces: `youtubePlayerReq(...)` resolves an `ApiResponse` whose `data.streamingDataClients: StreamingDataClients` is always set: `{ formats: "WEB" | "TV", adaptiveFormats: same }` for the primary; after a successful fallback, `adaptiveFormats` is the fallback client type and `formats` is the fallback client type only when the fallback supplied `formats` (otherwise the primary's tag stays, because the primary's muxed formats are kept). Task 4 reads this field; it is stripped by `trimPlayerResponse` and never reaches clients.

- [ ] **Step 1: Write the failing test**

Create `src/tests/youtubePlayerReq_test.ts`:

```ts
import { assertEquals } from "./deps.ts";
import type { Innertube } from "youtubei.js";
import { youtubePlayerReq } from "../lib/helpers/youtubePlayerReq.ts";
import type { Config } from "../lib/helpers/config.ts";

type Raw = Record<string, unknown>;

/** Innertube stub: NavigationEndpoint.call() ends in actions.execute(). */
function stubInnertube(responses: Record<string, Raw>): Innertube {
    return {
        actions: {
            execute: (_path: string, args: { client: string }) =>
                Promise.resolve({
                    success: true,
                    status_code: 200,
                    data: structuredClone(responses[args.client]),
                }),
        },
        session: { player: undefined },
    } as unknown as Innertube;
}

const config = {
    youtube_session: { oauth_enabled: false },
    jobs: { youtube_session: { player_fallback_clients: ["TV_SIMPLY"] } },
} as unknown as Config;

const tokenMinter = () => Promise.resolve("pot");

Deno.test("youtubePlayerReq streamingDataClients", async (t) => {
    await t.step("tags the primary WEB client when no fallback runs", async () => {
        const client = stubInnertube({
            WEB: {
                playabilityStatus: { status: "OK" },
                streamingData: {
                    formats: [{ itag: 18, url: "https://h/18" }],
                    adaptiveFormats: [{ itag: 137, url: "https://h/137" }],
                },
            },
        });

        const res = await youtubePlayerReq(client, "abcdefghijk", config, tokenMinter);

        assertEquals(res.data.streamingDataClients, {
            formats: "WEB",
            adaptiveFormats: "WEB",
        });
    });

    await t.step(
        "tags both arrays with the fallback client when it supplies both",
        async () => {
            const client = stubInnertube({
                WEB: {
                    playabilityStatus: { status: "OK" },
                    streamingData: {
                        formats: [{ itag: 18, signatureCipher: "s" }],
                        adaptiveFormats: [{ itag: 137 }],
                    },
                },
                TV_SIMPLY: {
                    playabilityStatus: { status: "OK" },
                    streamingData: {
                        formats: [{ itag: 18, url: "https://tv/18" }],
                        adaptiveFormats: [{ itag: 137, url: "https://tv/137" }],
                    },
                },
            });

            const res = await youtubePlayerReq(client, "abcdefghijk", config, tokenMinter);

            assertEquals(res.data.streamingDataClients, {
                formats: "TV_SIMPLY",
                adaptiveFormats: "TV_SIMPLY",
            });
            assertEquals(res.data.streamingData.formats[0].url, "https://tv/18");
        },
    );

    await t.step(
        "keeps the primary tag for formats when the fallback returns none",
        async () => {
            const client = stubInnertube({
                WEB: {
                    playabilityStatus: { status: "OK" },
                    streamingData: {
                        formats: [{ itag: 18, signatureCipher: "s" }],
                        adaptiveFormats: [{ itag: 137 }],
                    },
                },
                TV_SIMPLY: {
                    playabilityStatus: { status: "OK" },
                    streamingData: {
                        adaptiveFormats: [{ itag: 137, url: "https://tv/137" }],
                    },
                },
            });

            const res = await youtubePlayerReq(client, "abcdefghijk", config, tokenMinter);

            assertEquals(res.data.streamingDataClients, {
                formats: "WEB",
                adaptiveFormats: "TV_SIMPLY",
            });
            assertEquals(res.data.streamingData.formats[0].signatureCipher, "s");
        },
    );

    await t.step(
        "adopts the fallback wholesale when the primary had no streaming data",
        async () => {
            const client = stubInnertube({
                WEB: {
                    playabilityStatus: {
                        status: "LOGIN_REQUIRED",
                        reason: "Sign in to confirm you’re not a bot",
                    },
                },
                TV_SIMPLY: {
                    playabilityStatus: { status: "OK" },
                    streamingData: {
                        formats: [{ itag: 18, url: "https://tv/18" }],
                        adaptiveFormats: [{ itag: 137, url: "https://tv/137" }],
                    },
                },
            });

            const res = await youtubePlayerReq(client, "abcdefghijk", config, tokenMinter);

            assertEquals(res.data.playabilityStatus.status, "OK");
            assertEquals(res.data.streamingDataClients, {
                formats: "TV_SIMPLY",
                adaptiveFormats: "TV_SIMPLY",
            });
        },
    );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/youtubePlayerReq_test.ts`
Expected: FAIL on the first step — `streamingDataClients` is `undefined`, expected `{ formats: "WEB", adaptiveFormats: "WEB" }`.

- [ ] **Step 3: Implement the tagging**

In `src/lib/helpers/youtubePlayerReq.ts`:

Add the import after line 6 (`import { CTX, logWarn } from "./log.ts";`):

```ts
import type { StreamingDataClients } from "./playerDecipher.ts";
```

Replace lines 79-84 (the primary call) with:

```ts
    const youtubePlayerResponse = await callWatchEndpoint(
        videoId,
        innertubeClient,
        innertubeClientUsed,
        contentPoToken,
    );
    // Record which client produced each streaming-data array so the
    // decipher/pot decision downstream is made for the streams actually
    // being served, not for the primary client (see playerDecipher.ts).
    const primaryClients: StreamingDataClients = {
        formats: innertubeClientUsed,
        adaptiveFormats: innertubeClientUsed,
    };
    youtubePlayerResponse.data.streamingDataClients = primaryClients;
```

Replace lines 124-139 (the `if (youtubePlayerResponse.data.streamingData) { ... } else { ... }` block inside the fallback loop) with:

```ts
                if (youtubePlayerResponse.data.streamingData) {
                    youtubePlayerResponse.data.streamingData.adaptiveFormats =
                        fallbackStreaming.adaptiveFormats;
                    // Carry over muxed formats (e.g. itag 18) from the
                    // fallback client; keep the primary's if the fallback
                    // returned none.
                    const fallbackHasFormats =
                        !!fallbackStreaming.formats?.length;
                    if (fallbackHasFormats) {
                        youtubePlayerResponse.data.streamingData.formats =
                            fallbackStreaming.formats;
                    }
                    youtubePlayerResponse.data.streamingDataClients = {
                        formats: fallbackHasFormats
                            ? innertubeClientType
                            : primaryClients.formats,
                        adaptiveFormats: innertubeClientType,
                    } satisfies StreamingDataClients;
                } else {
                    // Original (bot-blocked) response had no streaming data —
                    // adopt the fallback's wholesale.
                    youtubePlayerResponse.data.streamingData =
                        fallbackStreaming;
                    youtubePlayerResponse.data.streamingDataClients = {
                        formats: innertubeClientType,
                        adaptiveFormats: innertubeClientType,
                    } satisfies StreamingDataClients;
                }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/youtubePlayerReq_test.ts`
Expected: `ok | 1 passed (4 steps) | 0 failed`.

- [ ] **Step 5: Gate and commit**

Run: `deno fmt src/** && deno task format && deno task check && deno task lint`
Expected: all succeed.

```bash
git add src/lib/helpers/youtubePlayerReq.ts src/tests/youtubePlayerReq_test.ts
git commit -m "fix: record which Innertube client supplied each streaming-data array"
```

---

### Task 4: Rebuild `youtubePlayerParsing` on the helpers — spec D1, D2 (helper side), D3 (KV short-circuit), D4, D5

**Files:**
- Modify: `src/lib/helpers/youtubePlayerHandling.ts` (whole file; ends ≈ 150 lines)
- Test: `src/tests/youtubePlayerHandling_test.ts`

**Interfaces:**
- Consumes: Task 1 (`videoCacheKey`, `readCachedPlayerResponse`, `writePlayerCache`), Task 2 (`decipherStreamingData`, `DEFAULT_STREAMING_DATA_CLIENTS`, `RawStreamingData`), Task 3 (`data.streamingDataClients`).
- Produces:
  - `export type PlayerReqFn = (innertubeClient: Innertube, videoId: string, config: Config, tokenMinter: TokenMinter) => Promise<ApiResponse>`
  - `export function trimPlayerResponse(videoData: Record<string, unknown>): TrimmedPlayerResponse` — picks exactly `captions, playabilityStatus, storyboards, streamingData, videoDetails, microformat`.
  - `youtubePlayerParsing({ innertubeClient, videoId, config, tokenMinter, metrics, overrideCache?, cacheGeneration?, deps? })` — new optional `cacheGeneration: number` (default `0`) and `deps: { playerReq?: PlayerReqFn; kv?: Deno.Kv }` (test seam). Always resolves the trimmed shape, also for `ERROR`.
  - `youtubeVideoInfo(innertubeClient, json)` unchanged (still throws for ERROR — routes guard in Task 6).

- [ ] **Step 1: Write the failing test**

Create `src/tests/youtubePlayerHandling_test.ts`:

```ts
import { assert, assertEquals } from "./deps.ts";
import type { ApiResponse, Innertube } from "youtubei.js";
import {
    trimPlayerResponse,
    youtubePlayerParsing,
} from "../lib/helpers/youtubePlayerHandling.ts";
import {
    awaitPendingCacheWrites,
    readCachedPlayerResponse,
    videoCacheKey,
} from "../lib/helpers/playerCache.ts";
import { Metrics } from "../lib/helpers/metrics.ts";
import type { Config } from "../lib/helpers/config.ts";

const VIDEO_ID = "abcdefghijk";

const errorResponse = (): ApiResponse => ({
    success: true,
    status_code: 200,
    data: {
        responseContext: { visitorData: "must-not-leak" },
        playabilityStatus: { status: "ERROR", reason: "Video unavailable" },
        videoDetails: { videoId: VIDEO_ID },
    },
} as ApiResponse);

function makeConfig(cacheEnabled: boolean): Config {
    return {
        cache: {
            enabled: cacheEnabled,
            ttl_seconds: 3600,
            negative_ttl_seconds: 30,
        },
    } as unknown as Config;
}

const innertubeClient = {} as unknown as Innertube;
const tokenMinter = () => Promise.resolve("pot");

Deno.test("trimPlayerResponse keeps only the public player fields", () => {
    const trimmed = trimPlayerResponse({
        responseContext: { visitorData: "x" },
        playabilityStatus: { status: "OK" },
        streamingData: { formats: [] },
        videoDetails: { videoId: VIDEO_ID },
        streamingDataClients: { formats: "WEB", adaptiveFormats: "WEB" },
    });

    assertEquals(Object.keys(trimmed).sort(), [
        "captions",
        "microformat",
        "playabilityStatus",
        "storyboards",
        "streamingData",
        "videoDetails",
    ]);
    assertEquals(
        (trimmed as Record<string, unknown>).responseContext,
        undefined,
    );
});

Deno.test("youtubePlayerParsing", async (t) => {
    const kv = await Deno.openKv(":memory:");

    await t.step(
        "returns the trimmed shape and records metrics for ERROR responses",
        async () => {
            const metrics = new Metrics();
            let checked = 0;
            metrics.checkInnertubeResponse = () => {
                checked++;
            };

            const result = await youtubePlayerParsing({
                innertubeClient,
                videoId: VIDEO_ID,
                config: makeConfig(true),
                tokenMinter,
                metrics,
                cacheGeneration: 1,
                deps: { playerReq: () => Promise.resolve(errorResponse()), kv },
            }) as Record<string, unknown>;

            assertEquals(
                (result.playabilityStatus as { status: string }).status,
                "ERROR",
            );
            assertEquals(result.responseContext, undefined);
            assertEquals(checked, 1);
        },
    );

    await t.step("negative-caches the ERROR response", async () => {
        await awaitPendingCacheWrites();
        const cached = await readCachedPlayerResponse(
            kv,
            videoCacheKey(1, VIDEO_ID),
        );
        assert(cached !== null, "expected a negative cache entry");
        assertEquals(
            (cached as { playabilityStatus: { status: string } })
                .playabilityStatus.status,
            "ERROR",
        );
    });

    await t.step("serves a cache hit without calling YouTube", async () => {
        let calls = 0;
        const result = await youtubePlayerParsing({
            innertubeClient,
            videoId: VIDEO_ID,
            config: makeConfig(true),
            tokenMinter,
            metrics: undefined,
            cacheGeneration: 1,
            deps: {
                playerReq: () => {
                    calls++;
                    return Promise.reject(new Error("must not be called"));
                },
                kv,
            },
        }) as Record<string, unknown>;

        assertEquals(calls, 0);
        assertEquals(
            (result.playabilityStatus as { status: string }).status,
            "ERROR",
        );
    });

    await t.step("a different generation misses the cache", async () => {
        let calls = 0;
        await youtubePlayerParsing({
            innertubeClient,
            videoId: VIDEO_ID,
            config: makeConfig(true),
            tokenMinter,
            metrics: undefined,
            cacheGeneration: 2,
            deps: {
                playerReq: () => {
                    calls++;
                    return Promise.resolve(errorResponse());
                },
                kv,
            },
        });
        assertEquals(calls, 1);
    });

    await t.step("does not touch KV when the cache is disabled", async () => {
        const isolated = await Deno.openKv(":memory:");
        let calls = 0;
        await youtubePlayerParsing({
            innertubeClient,
            videoId: VIDEO_ID,
            config: makeConfig(false),
            tokenMinter,
            metrics: undefined,
            deps: {
                playerReq: () => {
                    calls++;
                    return Promise.resolve(errorResponse());
                },
                kv: isolated,
            },
        });
        await awaitPendingCacheWrites();

        assertEquals(calls, 1);
        assertEquals(
            (await isolated.get(videoCacheKey(0, VIDEO_ID))).value,
            null,
        );
        isolated.close();
    });

    kv.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/youtubePlayerHandling_test.ts`
Expected: FAIL at type-check — `Module '"../lib/helpers/youtubePlayerHandling.ts"' has no exported member 'trimPlayerResponse'` and unknown properties `cacheGeneration`/`deps`.

- [ ] **Step 3: Rewrite `youtubePlayerHandling.ts`**

Replace the entire contents of `src/lib/helpers/youtubePlayerHandling.ts` with:

```ts
import { ApiResponse, Innertube, YT } from "youtubei.js";
import { generateRandomString } from "youtubei.js/Utils";
import type { TokenMinter } from "../jobs/potoken.ts";
import { Metrics } from "./metrics.ts";
import { resolveAndValidatePlayerReqLocation } from "./dynamicImportValidation.ts";
import type { Config } from "./config.ts";
import { getKv } from "./kv.ts";
import {
    readCachedPlayerResponse,
    videoCacheKey,
    writePlayerCache,
} from "./playerCache.ts";
import {
    DEFAULT_STREAMING_DATA_CLIENTS,
    decipherStreamingData,
    type RawStreamingData,
    type StreamingDataClients,
} from "./playerDecipher.ts";

const youtubePlayerReqLocation = resolveAndValidatePlayerReqLocation();
const { youtubePlayerReq } = await import(youtubePlayerReqLocation);

export type PlayerReqFn = (
    innertubeClient: Innertube,
    videoId: string,
    config: Config,
    tokenMinter: TokenMinter,
) => Promise<ApiResponse>;

const TRIMMED_KEYS = [
    "captions",
    "playabilityStatus",
    "storyboards",
    "streamingData",
    "videoDetails",
    "microformat",
] as const;

export type TrimmedPlayerResponse = {
    [K in typeof TRIMMED_KEYS[number]]: unknown;
};

/**
 * Reduce a raw player response to the fields Invidious consumes. Applied to
 * every response, including ERROR ones, so nothing else (responseContext,
 * tracking params, our internal streamingDataClients tag) leaves the process.
 */
export function trimPlayerResponse(
    videoData: Record<string, unknown>,
): TrimmedPlayerResponse {
    return Object.fromEntries(
        TRIMMED_KEYS.map((key) => [key, videoData[key]]),
    ) as TrimmedPlayerResponse;
}

// Tracks in-progress upstream player fetches so concurrent requests for the
// same videoId share a single YouTube round-trip instead of stampeding.
const inFlightPlayerRequests = new Map<string, Promise<object>>();

async function decipherIfPlayable(
    innertubeClient: Innertube,
    response: ApiResponse,
): Promise<RawStreamingData | undefined> {
    const videoData = response.data;
    if (
        videoData.playabilityStatus?.status === "ERROR" ||
        !videoData.streamingData
    ) {
        return videoData.streamingData;
    }
    // YT.VideoInfo parses the formats (signature/nsig aware). Its constructor
    // throws for ERROR responses, hence the guard above.
    const video = new YT.VideoInfo(
        [response],
        innertubeClient.actions,
        generateRandomString(16),
    );
    if (!video.streaming_data) return videoData.streamingData;
    const clients: StreamingDataClients = videoData.streamingDataClients ??
        DEFAULT_STREAMING_DATA_CLIENTS;
    return await decipherStreamingData(
        video.streaming_data,
        videoData.streamingData,
        {
            player: innertubeClient.session.player,
            sessionPoToken: innertubeClient.session.po_token,
            clients,
        },
    );
}

export const youtubePlayerParsing = async ({
    innertubeClient,
    videoId,
    config,
    tokenMinter,
    metrics,
    overrideCache = false,
    cacheGeneration = 0,
    deps = {},
}: {
    innertubeClient: Innertube;
    videoId: string;
    config: Config;
    tokenMinter: TokenMinter;
    metrics: Metrics | undefined;
    overrideCache?: boolean;
    /** Session generation the result is cached under (see main.ts). */
    cacheGeneration?: number;
    /** Test seam: inject the upstream fetch and/or the KV handle. */
    deps?: { playerReq?: PlayerReqFn; kv?: Deno.Kv };
}): Promise<object> => {
    const cacheEnabled = overrideCache ? false : config.cache.enabled;
    // Only open the store when it will be used: cache.enabled=false and
    // forced-fresh fetches must not create/open the SQLite file per request.
    const kv = cacheEnabled ? deps.kv ?? await getKv(config) : null;
    const cacheKey = videoCacheKey(cacheGeneration, videoId);

    if (kv) {
        const cached = await readCachedPlayerResponse(kv, cacheKey);
        if (cached) {
            metrics?.cacheHit.inc();
            return cached;
        }
    }

    // Single-flight: collapse concurrent cache-miss fetches for the same
    // videoId into one upstream request. Skipped for overrideCache (a forced
    // fresh fetch, e.g. PO-token validation), which must not reuse a shared
    // result.
    if (!overrideCache) {
        const existing = inFlightPlayerRequests.get(videoId);
        if (existing) return existing;
    }

    const fetchFresh = async (): Promise<object> => {
        if (kv) metrics?.cacheMiss.inc();
        const playerReq: PlayerReqFn = deps.playerReq ?? youtubePlayerReq;
        const response = await playerReq(
            innertubeClient,
            videoId,
            config,
            tokenMinter,
        );
        const videoData = response.data;
        const streamingData = await decipherIfPlayable(
            innertubeClient,
            response,
        );
        const trimmed = trimPlayerResponse({ ...videoData, streamingData });

        if (videoData.playabilityStatus?.status === "OK") {
            metrics?.innertubeSuccessfulRequest.inc();
            if (kv) {
                void writePlayerCache(
                    kv,
                    cacheKey,
                    trimmed,
                    config.cache.ttl_seconds || 3600,
                );
            }
        } else {
            metrics?.checkInnertubeResponse(videoData);
            // Negative cache: briefly remember non-OK responses (ERROR,
            // unplayable, login-required, …) so a client re-requesting an
            // unavailable video doesn't re-hit YouTube on every call. Kept
            // short so a genuine recovery (e.g. after a session regen) is
            // picked up soon.
            const negativeTtl = config.cache.negative_ttl_seconds;
            if (kv && negativeTtl > 0) {
                void writePlayerCache(kv, cacheKey, trimmed, negativeTtl);
            }
        }
        return trimmed;
    };

    if (overrideCache) {
        return await fetchFresh();
    }

    const fetchPromise = fetchFresh();
    inFlightPlayerRequests.set(videoId, fetchPromise);
    try {
        return await fetchPromise;
    } finally {
        inFlightPlayerRequests.delete(videoId);
    }
};

/**
 * Build a youtubei.js VideoInfo from a trimmed player response. Throws
 * `InnertubeError("This video is unavailable")` for ERROR responses (YouTube.js
 * v18 MediaInfo constructor) — callers must check the status first, see
 * `assertPlayable` in playability.ts.
 */
export const youtubeVideoInfo = (
    innertubeClient: Innertube,
    youtubePlayerResponseJson: object,
): YT.VideoInfo => {
    const playerResponse = {
        success: true,
        status_code: 200,
        data: youtubePlayerResponseJson,
    } as ApiResponse;
    return new YT.VideoInfo(
        [playerResponse],
        innertubeClient.actions,
        "",
    );
};
```

Notes for the implementer:
- `brotli`, `CTX`, `logError` imports are gone from this file on purpose; they live in `playerCache.ts` now.
- `response.data` is typed `any` by youtubei.js, which is why `videoData.streamingDataClients` needs no cast. Do not add `// deno-lint-ignore no-explicit-any` anywhere; none is needed.
- The old ECATCHER `client.name` lookup is deleted; `streamingDataClients` (Task 3) replaces it.

- [ ] **Step 4: Run the new test and the existing callers' type-check**

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/youtubePlayerHandling_test.ts`
Expected: `ok | 2 passed (5 steps) | 0 failed`.

Run: `deno task check`
Expected: succeeds — `src/lib/jobs/potoken.ts:284` (`checkToken`) still compiles because the new parameters are optional.

- [ ] **Step 5: Gate and commit**

Run: `deno fmt src/** && deno task format && deno task check && deno task lint`
Expected: all succeed.

```bash
git add src/lib/helpers/youtubePlayerHandling.ts src/tests/youtubePlayerHandling_test.ts
git commit -m "fix: always trim player responses, negative-cache ERROR, key cache by session generation"
```

---

### Task 5: Session generation in `sharedState` and the Hono context — spec D2 (wiring)

**Files:**
- Modify: `src/lib/types/HonoVariables.ts:6-11`
- Modify: `src/main.ts:70-91` (`sharedState`), `:413-418` and `:420-430` (the two middleware blocks)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `HonoVariables.sessionGeneration: number`
  - `sharedState.getGeneration(): number` in `main.ts`; `sharedState.set()` increments `_generation` on every call (also for per-proxy cached sessions, which carry their own `ip=`-bound URLs).
  - Every request on both Hono apps sees `c.get("sessionGeneration")`.
  - Plan A must keep these three additions when it restructures `main.ts`.

No unit test can import `main.ts` (it boots the app). Verification is `deno task check` plus the integration test in Task 6 Step 6.

- [ ] **Step 1: Extend `HonoVariables`**

Replace `src/lib/types/HonoVariables.ts` lines 6-11 with:

```ts
export type HonoVariables = {
    innertubeClient: Innertube;
    config: Config;
    tokenMinter: TokenMinter | undefined;
    metrics: Metrics | undefined;
    /**
     * Monotonic counter bumped on every session swap (regeneration or
     * per-proxy session switch). Part of the player cache key so deciphered
     * stream URLs bound to an older session's IP/pot are never served.
     */
    sessionGeneration: number;
};
```

- [ ] **Step 2: Run type-check to see the two middleware blocks fail**

Run: `deno task check`
Expected: no error yet — `sessionGeneration` is only read, never required at `c.set` time. (Hono does not enforce that every variable is set.) Proceed.

- [ ] **Step 3: Add the generation to `sharedState`**

In `src/main.ts` replace the `sharedState` object (currently lines 70-91, starting at `const sharedState = {` and ending at the closing `};`) with:

```ts
const sharedState = {
    _client: null as Innertube | null,
    _minter: undefined as TokenMinter | undefined,
    // Incremented on every set(); see HonoVariables.sessionGeneration.
    _generation: 0,

    getClient(): Innertube {
        return this._client ?? innertubeClient;
    },
    getMinter(): TokenMinter | undefined {
        // Once the cron job has set a client, its paired minter is the source
        // of truth (even when undefined); before then, fall back to the
        // module-level minter.
        return this._client ? this._minter : tokenMinter;
    },
    getGeneration(): number {
        return this._generation;
    },
    set(client: Innertube, minter: TokenMinter | undefined): void {
        this._client = client;
        this._minter = minter;
        this._generation++;
    },
};
```

- [ ] **Step 4: Inject it in both middleware blocks**

In `src/main.ts`, in the `companionApp.use("*", …)` block add one line after `c.set("metrics", metrics);`:

```ts
    c.set("sessionGeneration", sharedState.getGeneration());
```

Do the same in the `app.use("*", …)` block directly below it (after its `c.set("metrics", metrics);`). Both blocks end up as:

```ts
companionApp.use("*", async (c, next) => {
    c.set("innertubeClient", sharedState.getClient());
    c.set("tokenMinter", sharedState.getMinter());
    c.set("config", config);
    c.set("metrics", metrics);
    c.set("sessionGeneration", sharedState.getGeneration());
    await next();
});
```

- [ ] **Step 5: Gate and commit**

Run: `deno fmt src/** && deno task format && deno task check && deno task lint`
Expected: all succeed.

```bash
git add src/lib/types/HonoVariables.ts src/main.ts
git commit -m "feat: track a session generation counter and expose it to request handlers"
```

---

### Task 6: Route guards, DASH 404, player body validation, generation-aware caching — spec D1 (routes), D2 (routes), D3

**Files:**
- Create: `src/lib/helpers/playability.ts`
- Test: `src/tests/playability_test.ts`
- Modify: `src/routes/youtube_api_routes/player.ts` (whole file)
- Test: `src/tests/playerRoute_test.ts`
- Modify: `src/routes/invidious_routes/dashManifest.ts:52-75`
- Modify: `src/routes/invidious_routes/latestVersion.ts:56-75`
- Modify: `src/routes/invidious_routes/captions.ts:63-73`

**Interfaces:**
- Consumes: `youtubePlayerParsing({ …, cacheGeneration })` (Task 4), `c.get("sessionGeneration")` (Task 5).
- Produces:
  - `export function getPlayabilityStatus(json: object): { status?: string; reason?: string }`
  - `export function assertPlayable(videoId: string, json: object): void` — throws `HTTPException(403)` with body `"The video can't be played: <videoId> due to reason: <reason>"` when `status !== "OK"` (byte-identical to the message the routes produce today).
  - `/youtubei/v1/player` responses: malformed JSON → 400 `"Invalid JSON body."` (previously an unhandled 500); missing/non-string `videoId` → 400 `"Missing videoId in request body."` (unchanged text); bad format → 400 `"Invalid video ID format."` (unchanged).
  - `/api/manifest/dash/id/:id` with an OK response and no `streaming_data` → 404 `"No streaming data available."` (previously an empty `undefined` body / 500).
  - `/api/v1/captions/:id` for an ERROR response → 404 (previously 500 via `InnertubeError`).

- [ ] **Step 1: Write the failing playability test**

Create `src/tests/playability_test.ts`:

```ts
import { assertEquals, assertThrows } from "./deps.ts";
import { HTTPException } from "hono/http-exception";
import {
    assertPlayable,
    getPlayabilityStatus,
} from "../lib/helpers/playability.ts";

Deno.test("getPlayabilityStatus reads status and reason from raw JSON", () => {
    assertEquals(
        getPlayabilityStatus({
            playabilityStatus: { status: "ERROR", reason: "Video unavailable" },
        }),
        { status: "ERROR", reason: "Video unavailable" },
    );
    assertEquals(getPlayabilityStatus({}), {
        status: undefined,
        reason: undefined,
    });
});

Deno.test("assertPlayable", async (t) => {
    await t.step("passes for OK", () => {
        assertPlayable("abcdefghijk", { playabilityStatus: { status: "OK" } });
    });

    await t.step("throws 403 with the legacy message otherwise", async () => {
        const err = assertThrows(
            () =>
                assertPlayable("abcdefghijk", {
                    playabilityStatus: {
                        status: "ERROR",
                        reason: "Video unavailable",
                    },
                }),
            HTTPException,
        );
        assertEquals(err.status, 403);
        assertEquals(
            await err.getResponse().text(),
            "The video can't be played: abcdefghijk due to reason: Video unavailable",
        );
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/playability_test.ts`
Expected: FAIL — `Module not found ".../src/lib/helpers/playability.ts"`.

- [ ] **Step 3: Create `playability.ts`**

```ts
import { HTTPException } from "hono/http-exception";

export interface PlayabilityStatus {
    status?: string;
    reason?: string;
}

/** Read `playabilityStatus` from a raw/trimmed player response. */
export function getPlayabilityStatus(json: object): PlayabilityStatus {
    const ps = (json as { playabilityStatus?: PlayabilityStatus })
        .playabilityStatus;
    return { status: ps?.status, reason: ps?.reason };
}

/**
 * Route guard: 403 with the message Invidious expects when the video is not
 * playable. Must run BEFORE `youtubeVideoInfo()`, whose YouTube.js v18
 * constructor throws `InnertubeError` for ERROR responses.
 */
export function assertPlayable(videoId: string, json: object): void {
    const { status, reason } = getPlayabilityStatus(json);
    if (status === "OK") return;
    throw new HTTPException(403, {
        res: new Response(
            "The video can't be played: " + videoId + " due to reason: " +
                reason,
        ),
    });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/playability_test.ts`
Expected: `ok | 2 passed (2 steps) | 0 failed`.

- [ ] **Step 5: Write the failing player-route test**

Create `src/tests/playerRoute_test.ts`:

```ts
import { assertEquals } from "./deps.ts";
import { Hono } from "hono";
import type { Innertube } from "youtubei.js";
import type { HonoVariables } from "../lib/types/HonoVariables.ts";
import type { Config } from "../lib/helpers/config.ts";
import player from "../routes/youtube_api_routes/player.ts";
import { TOKEN_MINTER_NOT_READY_MESSAGE } from "../constants.ts";

function buildApp(poTokenEnabled: boolean) {
    const config = {
        jobs: { youtube_session: { po_token_enabled: poTokenEnabled } },
        cache: { enabled: false, ttl_seconds: 0, negative_ttl_seconds: 0 },
    } as unknown as Config;
    const app = new Hono<{ Variables: HonoVariables }>();
    app.use("*", async (c, next) => {
        c.set("innertubeClient", {} as unknown as Innertube);
        c.set("tokenMinter", undefined);
        c.set("config", config);
        c.set("metrics", undefined);
        c.set("sessionGeneration", 0);
        await next();
    });
    app.route("/youtubei/v1", player);
    return app;
}

const post = (app: Hono<{ Variables: HonoVariables }>, body: string) =>
    app.request("/youtubei/v1/player", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
    });

Deno.test("POST /youtubei/v1/player body validation", async (t) => {
    const app = buildApp(false);

    await t.step("rejects malformed JSON with 400", async () => {
        const res = await post(app, "{not json");
        assertEquals(res.status, 400);
        assertEquals(await res.text(), "Invalid JSON body.");
    });

    await t.step("rejects a body without videoId with 400", async () => {
        const res = await post(app, "{}");
        assertEquals(res.status, 400);
        assertEquals(await res.text(), "Missing videoId in request body.");
    });

    await t.step("rejects a non-string videoId with 400", async () => {
        const res = await post(app, JSON.stringify({ videoId: 12345 }));
        assertEquals(res.status, 400);
        assertEquals(await res.text(), "Missing videoId in request body.");
    });

    await t.step("rejects a malformed videoId with 400", async () => {
        const res = await post(app, JSON.stringify({ videoId: "bad id!" }));
        assertEquals(res.status, 400);
        assertEquals(await res.text(), "Invalid video ID format.");
    });
});

Deno.test("POST /youtubei/v1/player reports a not-ready minter as ERROR JSON", async () => {
    const app = buildApp(true);
    const res = await post(app, JSON.stringify({ videoId: "jNQXAC9IVRw" }));

    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.playabilityStatus.status, "ERROR");
    assertEquals(json.playabilityStatus.reason, TOKEN_MINTER_NOT_READY_MESSAGE);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/playerRoute_test.ts`
Expected: FAIL — type errors in `player.ts` (`c.get("config")` on an untyped `Hono`) and/or the first step returning 500 instead of 400.

- [ ] **Step 7: Rewrite `player.ts`**

Replace the entire contents of `src/routes/youtube_api_routes/player.ts` with:

```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { HonoVariables } from "../../lib/types/HonoVariables.ts";
import { youtubePlayerParsing } from "../../lib/helpers/youtubePlayerHandling.ts";
import { validateVideoId } from "../../lib/helpers/validateVideoId.ts";
import { TOKEN_MINTER_NOT_READY_MESSAGE } from "../../constants.ts";

// Invidious sends `{ "videoId": "<id>" }`; extra keys are tolerated.
const PlayerBodySchema = z.object({ videoId: z.string().min(1) })
    .passthrough();

const player = new Hono<{ Variables: HonoVariables }>();

player.post("/player", async (c) => {
    let rawBody: unknown;
    try {
        rawBody = await c.req.json();
    } catch {
        throw new HTTPException(400, {
            res: new Response("Invalid JSON body."),
        });
    }

    const innertubeClient = c.get("innertubeClient");
    const config = c.get("config");
    const metrics = c.get("metrics");
    const tokenMinter = c.get("tokenMinter");

    // Check if tokenMinter is ready (only needed when PO token is enabled)
    if (config.jobs.youtube_session.po_token_enabled && !tokenMinter) {
        return c.json({
            playabilityStatus: {
                status: "ERROR",
                reason: TOKEN_MINTER_NOT_READY_MESSAGE,
                errorScreen: {
                    playerErrorMessageRenderer: {
                        reason: {
                            simpleText: TOKEN_MINTER_NOT_READY_MESSAGE,
                        },
                        subreason: {
                            simpleText: TOKEN_MINTER_NOT_READY_MESSAGE,
                        },
                    },
                },
            },
        });
    }

    const parsed = PlayerBodySchema.safeParse(rawBody);
    if (!parsed.success) {
        throw new HTTPException(400, {
            res: new Response("Missing videoId in request body."),
        });
    }
    const { videoId } = parsed.data;
    if (!validateVideoId(videoId)) {
        throw new HTTPException(400, {
            res: new Response("Invalid video ID format."),
        });
    }

    return c.json(
        await youtubePlayerParsing({
            innertubeClient,
            videoId,
            config,
            tokenMinter: tokenMinter!,
            metrics,
            cacheGeneration: c.get("sessionGeneration"),
        }),
    );
});

export default player;
```

- [ ] **Step 8: Run the route test to verify it passes**

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/playerRoute_test.ts`
Expected: `ok | 2 passed (4 steps) | 0 failed`.

- [ ] **Step 9: Guard the DASH route and add the 404**

In `src/routes/invidious_routes/dashManifest.ts`:

Add the import after line 11 (`import { TOKEN_MINTER_NOT_READY_MESSAGE } …`):

```ts
import { assertPlayable } from "../../lib/helpers/playability.ts";
```

Replace lines 52-75 (from `const youtubePlayerResponseJson = await youtubePlayerParsing({` through `if (videoInfo.streaming_data) {`) with:

```ts
    const youtubePlayerResponseJson = await youtubePlayerParsing({
        innertubeClient,
        videoId,
        config,
        tokenMinter: tokenMinter!,
        metrics,
        cacheGeneration: c.get("sessionGeneration"),
    });
    // Must precede youtubeVideoInfo(): YouTube.js v18 throws for ERROR.
    assertPlayable(videoId, youtubePlayerResponseJson);
    const videoInfo = youtubeVideoInfo(
        innertubeClient,
        youtubePlayerResponseJson,
    );

    c.header("content-type", "application/dash+xml");

    if (!videoInfo.streaming_data) {
        throw new HTTPException(404, {
            res: new Response("No streaming data available."),
        });
    }

    if (videoInfo.streaming_data) {
```

(The old `if (videoInfo.playability_status?.status !== "OK") { throw … 403 }` block is removed; `assertPlayable` produces the identical response. The trailing `if (videoInfo.streaming_data) {` is kept so the large body below it stays unchanged.)

- [ ] **Step 10: Guard `latestVersion`**

In `src/routes/invidious_routes/latestVersion.ts`:

Add the import after line 10:

```ts
import { assertPlayable } from "../../lib/helpers/playability.ts";
```

Replace lines 56-75 (from `const youtubePlayerResponseJson = await youtubePlayerParsing({` through the closing `}` of the `if (videoInfo.playability_status?.status !== "OK") { … }` block) with:

```ts
    const youtubePlayerResponseJson = await youtubePlayerParsing({
        innertubeClient,
        videoId: id,
        config,
        tokenMinter: tokenMinter!,
        metrics,
        cacheGeneration: c.get("sessionGeneration"),
    });
    // Must precede youtubeVideoInfo(): YouTube.js v18 throws for ERROR.
    assertPlayable(id, youtubePlayerResponseJson);
    const videoInfo = youtubeVideoInfo(
        innertubeClient,
        youtubePlayerResponseJson,
    );
```

- [ ] **Step 11: Guard `captions`**

In `src/routes/invidious_routes/captions.ts`:

Add the import after line 12 (`import { TOKEN_MINTER_NOT_READY_MESSAGE } …`):

```ts
import { getPlayabilityStatus } from "../../lib/helpers/playability.ts";
```

Replace lines 63-73 (from `const youtubePlayerResponseJson = await youtubePlayerParsing({` through the closing `);` of `youtubeVideoInfo(`) with:

```ts
    const youtubePlayerResponseJson = await youtubePlayerParsing({
        innertubeClient,
        videoId,
        config,
        metrics,
        tokenMinter: tokenMinter!,
        cacheGeneration: c.get("sessionGeneration"),
    });

    // An ERROR response has no captions, and youtubeVideoInfo() would throw
    // (YouTube.js v18) — answer 404 like the "no caption tracks" case below.
    if (getPlayabilityStatus(youtubePlayerResponseJson).status === "ERROR") {
        throw new HTTPException(404);
    }

    const videoInfo = youtubeVideoInfo(
        innertubeClient,
        youtubePlayerResponseJson,
    );
```

- [ ] **Step 12: Gate, full test run, commit**

Run: `deno fmt src/** && deno task format && deno task check && deno task lint`
Expected: all succeed.

Run: `SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test`
Expected: `ok | N passed … | 0 failed` — includes `main_test.ts` (real YouTube): player 200 with `playabilityStatus.status === "OK"`, DASH 200, `latest_version` 302. This exercises Tasks 3-6 end to end (fallback tagging → decipher → generation-keyed cache → guards). If YouTube is unreachable in your environment, say so in the commit body and do not skip the unit tests.

```bash
git add src/lib/helpers/playability.ts src/tests/playability_test.ts \
    src/routes/youtube_api_routes/player.ts src/tests/playerRoute_test.ts \
    src/routes/invidious_routes/dashManifest.ts \
    src/routes/invidious_routes/latestVersion.ts \
    src/routes/invidious_routes/captions.ts
git commit -m "fix: guard routes against ERROR player responses, validate player body, 404 on missing DASH streams"
```

---

## Self-review

**1. Spec coverage**

| Spec item | Task(s) |
|---|---|
| D1 — inspect status before `VideoInfo`, trimmed shape for ERROR, metrics, routes 403 | Task 4 (`decipherIfPlayable` guard, `trimPlayerResponse` always, `checkInnertubeResponse` + negative cache for every non-OK), Task 6 (`assertPlayable` in DASH/latestVersion, 404 in captions) |
| D2 — `sessionGeneration` in `sharedState`, key `["video_cache", generation, videoId]` | Task 1 (`videoCacheKey`), Task 4 (`cacheGeneration` param), Task 5 (counter + context), Task 6 (routes pass it) |
| D3 — KV only when cache enabled; Zod-validate player body; DASH 404 `"No streaming data available."` | Task 4 (`kv = cacheEnabled ? … : null`), Task 6 Steps 7 and 9 |
| D4 — `youtubePlayerReq` records the supplying client; decipher/pot decision uses it | Task 3 (`streamingDataClients`, per array so the kept-primary-muxed case stays correct), Task 2 + 4 (`needsDecipher` per array) |
| D5 — split into `readCachedPlayerResponse` / `decipherStreamingData` / one shared `writePlayerCache` in `playerCache.ts` and `playerDecipher.ts` | Tasks 1, 2, 4 |

Gaps: none. One deliberate deviation is documented in Task 3's interface block: the spec says `streamingDataClient` (a single string); the plan uses `streamingDataClients: { formats, adaptiveFormats }` because the upstream muxed-format carry-over can leave `formats` from the primary client next to `adaptiveFormats` from the fallback, and a single tag would decipher one of them wrongly.

**2. Placeholder scan** — no "TBD/TODO/similar to", every code step has full code, every run step has a command and expected output. The DASH-404 and captions-404 branches have no dedicated unit test because those handlers call `youtubePlayerParsing` without an injection point; they are covered by type-check and by `main_test.ts` (Task 6 Step 12). Stated explicitly rather than hidden.

**3. Type consistency** — `videoCacheKey(generation: number, videoId: string)` (Task 1) is used with `(cacheGeneration, videoId)` in Task 4 and `(0|1|2, VIDEO_ID)` in tests. `writePlayerCache(kv, key, value: object, ttlSeconds: number)` matches both call sites in Task 4 (`config.cache.ttl_seconds || 3600`, `negativeTtl` — both seconds, as in the original `* 1000` code). `decipherStreamingData(parsed, raw, { player, sessionPoToken, clients })` signature in Task 2 matches Task 4's call (`video.streaming_data` satisfies `{ formats: Decipherable[]; adaptive_formats: Decipherable[] }` structurally since youtubei.js `Format.decipher(player?: Player): Promise<string>`). `StreamingDataClients` shape `{ formats: string; adaptiveFormats: string }` is identical in Tasks 2, 3, 4. `c.get("sessionGeneration")` is typed `number` via `HonoVariables` (Task 5) and consumed as `cacheGeneration?: number` (Task 4). `assertPlayable(videoId: string, json: object)` / `getPlayabilityStatus(json: object)` match all Task 6 call sites.
