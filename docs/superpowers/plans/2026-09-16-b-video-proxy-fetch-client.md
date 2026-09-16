# Video Proxy and Fetch Client Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the video proxy and outbound fetch client so long video bodies are not aborted by the fetch timeout, googlevideo redirects are followed safely, CDN 403s no longer count as bot blocks, proxy cooldown probes are single-flighted, and then split the 774-line `getFetchClient.ts` into focused modules without changing its public exports.

**Architecture:** All outbound YouTube traffic goes through `getFetchClient(config)` (`src/lib/helpers/getFetchClient.ts`), a singleton keyed by config identity with three modes (proxy pool, single proxy / IPv6, direct). Every mode funnels into `fetchShim`, which adds the timeout signal, the retry loop and the rate gate. The video proxy route (`src/routes/videoPlaybackProxy.ts`) streams googlevideo bytes through that fetch function. Tasks 1–6 are behavioural fixes with tests (spec B1–B6); Tasks 7–10 move code verbatim into `fetchGate.ts`, `youtubeBlockDetection.ts`, `fetchShim.ts` and `proxyPool.ts` (spec B7).

**Tech Stack:** Deno 2.9, Hono 4.13, `@std/async` retry, `@std/assert` tests, prom-client metrics.

**Spec:** `docs/superpowers/specs/2026-09-16-code-review-findings.md`, section B (B1–B7).

## Global Constraints

- Runtime: Deno 2.9.x (Docker), `deno.json` tasks are the single source of truth for permission flags. Formatter indent width is **4**.
- Every change must pass `deno task format`, `deno task check`, `deno task lint` and `deno task test` (`SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa`).
- The Invidious ↔ companion contract (routes, query names, status codes, response bodies, `check`/`enc`/`data` wire format) must not change unless the finding says so explicitly; then `../invidious/` must be updated in lockstep.
- Logging goes through `logInfo/logWarn/logError/logDebug(CTX.X, msg)` from `src/lib/helpers/log.ts`. No bare `console.*` in `src/` outside `log.ts`.
- Immutability preferred; no mutation of shared objects outside `sharedState`.
- Files ≤ 800 lines, functions ≤ 50 lines where reasonably achievable.
- Tests: pure-unit tests must not need network. Integration tests live behind `main_test.ts`. Test names describe behaviour.
- Commit format: `<type>: <description>` (feat, fix, refactor, docs, test, chore, perf, ci). Attribution trailers as configured for the session.
- **Plan-specific:** `getFetchClient.ts` must keep exporting exactly `getFetchClient`, `setOnYouTubeBlock`, `setOnActiveProxyChange`, `getSessionEgressProxy`, `rotateSessionEgressProxy` (used by `main.ts`, `potoken.ts`, `worker.ts`, `videoPlaybackProxy.ts`). `deno compile --include ./src/lib/helpers/getFetchClient.ts` bundles static imports transitively, so new helper modules need no `--include` change. The dynamic-import allowlist in `dynamicImportValidation.ts` keys on the module name `getFetchClient`, which does not change.
- **Plan-specific invariant:** `checkYouTubeBlock` must never read a body whose content-type is not json/html/text (video bodies would OOM). Preserve the content-type guard in every task that touches it.

## How to run things

Single test file (copy of the `test` task flags, from CLAUDE.md):

```bash
DENO_JOBS=1 deno test src/tests/<file>_test.ts \
  --allow-import=github.com:443,jsr.io:443,cdn.jsdelivr.net:443,esm.sh:443,deno.land:443 \
  --allow-net --allow-env --allow-sys=hostname \
  --allow-read=.,/tmp,/var/tmp/youtubei.js,/tmp/invidious-companion.sock,$HOME/.cache/deno \
  --allow-write=/var/tmp/youtubei.js,/tmp
```

Below this is abbreviated as `RUN_TEST src/tests/<file>_test.ts`. Full suite: `SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test`. Static checks: `deno task format && deno task check && deno task lint`.

Existing test conventions to reuse (see `src/tests/proxy_pool_test.ts:66-147`): replace `globalThis.fetch` and `Deno.createHttpClient` in a `try`, restore them in `finally`; build a config with `parseConfig()` after `Deno.env.set("SERVER_SECRET_KEY", "aaaaaaaaaaaaaaaa")`, then spread a fresh object so the `getFetchClient` singleton (keyed on config identity) is rebuilt per test; mark tests that create `Deno.HttpClient`s with `sanitizeResources: false` only when the mock returns real clients (the mocks here return plain objects, so it is not needed).

---

## File structure

| File | Responsibility after this plan |
|---|---|
| `src/lib/helpers/getFetchClient.ts` | Singleton, mode selection, single-proxy/IPv6 path, direct path, `closeClientWhenDone`, hook setters, egress-proxy accessors. ~250 lines. |
| `src/lib/helpers/fetchShim.ts` (new, Task 9) | `fetchShim`, `buildFetchSignal`, the shared fetch types. |
| `src/lib/helpers/fetchGate.ts` (new, Task 7) | `FetchGate` rate limiter class. |
| `src/lib/helpers/youtubeBlockDetection.ts` (new, Task 8) | `YOUTUBE_BLOCK_SIGNALS`, `checkYouTubeBlock`, `maskProxyUrl`. |
| `src/lib/helpers/proxyPool.ts` (new, Task 10) | `createProxyPool(deps)`: failover pool with health probes, blacklist, per-proxy gates, in-request block failover. |
| `src/lib/helpers/googlevideoUrl.ts` (new, Task 3) | `isGooglevideoHost`, `resolveRedirectTarget`, `isValidExpire`. |
| `src/routes/videoPlaybackProxy.ts` | Route: validation, manual redirect loop, streaming passthrough. |
| `src/tests/fetchSignal_test.ts` (new) | `buildFetchSignal` unit tests. |
| `src/tests/fetchClient_init_test.ts` (new) | Pool path forwards `redirect`/`signal`/`streaming`. |
| `src/tests/googlevideoUrl_test.ts` (new) | URL helper unit tests. |
| `src/tests/videoPlaybackProxy_test.ts` (new) | Route tests via `app.request` with mocked `fetch`. |
| `src/tests/youtubeBlock_test.ts` (new) | Block detection via the direct path and `setOnYouTubeBlock`. |
| `src/tests/proxy_pool_revalidate_test.ts` (new) | Single-flight cooldown revalidation. |

---

### Task 1: `streaming` flag and `buildFetchSignal` (spec B1)

**Files:**
- Modify: `src/lib/helpers/getFetchClient.ts:7-15` (types) and `:678-704` (`fetchShim`)
- Test: `src/tests/fetchSignal_test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export type FetchInitParameterWithClient = RequestInit & { client?: Deno.HttpClient; streaming?: boolean }`; `export function buildFetchSignal(timeoutMs: number | undefined, callerSignal: AbortSignal | null | undefined, streaming: boolean | undefined): AbortSignal | null`. Task 4 passes `streaming: true`; Task 2 forwards it on the pool path; Task 9 moves both to `fetchShim.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/tests/fetchSignal_test.ts`:

```ts
import { assert, assertEquals } from "./deps.ts";
import { buildFetchSignal } from "../lib/helpers/getFetchClient.ts";

Deno.test("buildFetchSignal", async (t) => {
    await t.step("returns null when streaming and no caller signal", () => {
        assertEquals(buildFetchSignal(30_000, undefined, true), null);
    });

    await t.step("returns the caller signal untouched when streaming", () => {
        const controller = new AbortController();
        const signal = buildFetchSignal(30_000, controller.signal, true);
        assert(signal === controller.signal);
    });

    await t.step("returns a timeout signal when not streaming", () => {
        const signal = buildFetchSignal(30_000, undefined, false);
        assert(signal instanceof AbortSignal);
        assertEquals(signal.aborted, false);
    });

    await t.step("returns null when no timeout and not streaming", () => {
        assertEquals(buildFetchSignal(undefined, undefined, false), null);
    });

    await t.step("combines caller signal and timeout when not streaming", () => {
        const controller = new AbortController();
        const signal = buildFetchSignal(30_000, controller.signal, false);
        assert(signal !== null);
        assert(signal !== controller.signal);
        assertEquals(signal!.aborted, false);
        controller.abort();
        assertEquals(signal!.aborted, true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `RUN_TEST src/tests/fetchSignal_test.ts`
Expected: FAIL with `Module '"../lib/helpers/getFetchClient.ts"' has no exported member 'buildFetchSignal'` (type-check error before running).

- [ ] **Step 3: Replace the fetch types and add `buildFetchSignal`**

In `src/lib/helpers/getFetchClient.ts`, replace lines 7–15:

```ts
type FetchInputParameter = Parameters<typeof fetch>[0];
type FetchInitParameterWithClient =
    | RequestInit
    | RequestInit & { client: Deno.HttpClient };
type FetchReturn = ReturnType<typeof fetch>;
type FetchFn = (
    input: FetchInputParameter,
    init?: FetchInitParameterWithClient,
) => FetchReturn;
```

with:

```ts
export type FetchInputParameter = Parameters<typeof fetch>[0];
/**
 * `client`: a pre-built Deno.HttpClient (proxy / local address binding).
 * `streaming`: set by callers that stream a large body (video proxy). When
 * true, fetchShim attaches NO timeout signal, because `AbortSignal.timeout`
 * covers the whole body read and would cut long transfers. A header-phase
 * timeout for streaming requests is a follow-up (not covered here).
 */
export type FetchInitParameterWithClient = RequestInit & {
    client?: Deno.HttpClient;
    streaming?: boolean;
};
export type FetchReturn = ReturnType<typeof fetch>;
export type FetchFn = (
    input: FetchInputParameter,
    init?: FetchInitParameterWithClient,
) => FetchReturn;

/**
 * Decide which AbortSignal a fetch gets.
 * - streaming: only the caller's signal (or none); never a timeout.
 * - otherwise: the timeout signal, combined with the caller's signal when one
 *   is given so neither is silently dropped.
 */
export function buildFetchSignal(
    timeoutMs: number | undefined,
    callerSignal: AbortSignal | null | undefined,
    streaming: boolean | undefined,
): AbortSignal | null {
    if (streaming || !timeoutMs) {
        return callerSignal ?? null;
    }
    const timeoutSignal = AbortSignal.timeout(Number(timeoutMs));
    if (!callerSignal) {
        return timeoutSignal;
    }
    return AbortSignal.any([callerSignal, timeoutSignal]);
}
```

- [ ] **Step 4: Use it in `fetchShim`**

Replace the current `fetchShim` (lines 678–704 before this edit) with:

```ts
function fetchShim(
    config: Config,
    retryOptions: RetryOptions,
    input: FetchInputParameter,
    init?: FetchInitParameterWithClient,
    // Per-proxy rate gate. When provided (proxy-pool path) it overrides the
    // process-wide gate so each egress IP is throttled independently.
    gate?: FetchGate,
): FetchReturn {
    const fetchTimeout = config.networking.fetch?.timeout_ms;
    const fetchRetry = config.networking.fetch?.retry?.enabled;
    const activeGate = gate ?? fetchGate;
    // `streaming` is our own flag, never handed to the native fetch.
    const { streaming, signal: callerSignal, ...nativeInit } = init ?? {};
    let attempt = 0;
    const callFetch = () => {
        // Every invocation after the first is a retry.
        if (attempt++ > 0) metricsRef?.upstreamRetries.inc();
        const doFetch = () =>
            fetch(input, {
                ...nativeInit,
                // A fresh timeout per attempt, so retries get the full budget.
                signal: buildFetchSignal(fetchTimeout, callerSignal, streaming),
            });
        return activeGate ? activeGate.run(doFetch) : doFetch();
    };
    return fetchRetry ? retry(callFetch, retryOptions) : callFetch();
}
```

- [ ] **Step 5: Run test to verify it passes, then the static checks**

Run: `RUN_TEST src/tests/fetchSignal_test.ts`
Expected: `ok | 1 passed (5 steps) | 0 failed`

Run: `deno task format && deno task check && deno task lint`
Expected: all three succeed (format may reformat; re-run `deno fmt src/lib/helpers/getFetchClient.ts src/tests/fetchSignal_test.ts` if `--check` complains, then re-run).

- [ ] **Step 6: Run the full suite**

Run: `SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test`
Expected: `0 failed`. (The proxy-pool tests exercise `fetchShim` with mocked `fetch`.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/helpers/getFetchClient.ts src/tests/fetchSignal_test.ts
git commit -m "fix: add streaming flag so fetch timeout no longer covers video bodies

AbortSignal.timeout applies until the body is fully read, so the default
30 s fetch timeout cut any video transfer longer than that (downloads via
/latest_version, progressive itag 18). Callers can now pass
\`streaming: true\`; fetchShim then attaches no timeout. Caller signals
and the timeout are combined with AbortSignal.any instead of the caller
signal silently replacing the timeout."
```

---

### Task 2: Pool path forwards `redirect`, `signal` and `streaming` (spec B3)

**Files:**
- Modify: `src/lib/helpers/getFetchClient.ts` — the `fetchShim(...)` call inside the pool `fn` (search for `headers: init?.headers,`)
- Test: `src/tests/fetchClient_init_test.ts`

**Interfaces:**
- Consumes: `FetchInitParameterWithClient.streaming` and `buildFetchSignal` from Task 1.
- Produces: pool path honours `init.redirect`, `init.signal`, `init.streaming`. Task 4 relies on this so the video proxy's manual redirect handling works in pool mode.

- [ ] **Step 1: Write the failing test**

Create `src/tests/fetchClient_init_test.ts`:

```ts
import { assert, assertEquals } from "./deps.ts";

Deno.test({
    name:
        "proxy pool path forwards redirect, streaming and caller signal to fetch",
    fn: async () => {
        const originalFetch = globalThis.fetch;
        const originalCreateHttpClient = Deno.createHttpClient;
        const originalSecret = Deno.env.get("SERVER_SECRET_KEY");
        const captured: RequestInit[] = [];

        Deno.createHttpClient = (() => {
            return { __clientId: 1 } as unknown as Deno.HttpClient;
        }) as typeof Deno.createHttpClient;

        globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            if (!String(input).includes("generate_204")) {
                captured.push(init ?? {});
            }
            return Promise.resolve(
                new Response(JSON.stringify({ status: "OK" }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
            );
        }) as typeof fetch;

        try {
            Deno.env.set("SERVER_SECRET_KEY", "aaaaaaaaaaaaaaaa");
            const { getFetchClient } = await import(
                "../lib/helpers/getFetchClient.ts"
            );
            const { parseConfig } = await import("../lib/helpers/config.ts");
            const config = await parseConfig();
            const testConfig = {
                ...config,
                networking: {
                    ...config.networking,
                    proxy_pool: {
                        enabled: true,
                        rotation: "round-robin" as const,
                        health_check: true,
                        switch_proxy_on_limit: false,
                        proxies: ["http://u:p@proxy1:8080"],
                    },
                },
            };

            const fetchClient = getFetchClient(testConfig);
            const controller = new AbortController();
            await fetchClient("https://example.com/videoplayback", {
                method: "GET",
                redirect: "manual",
                streaming: true,
                signal: controller.signal,
            });

            assertEquals(captured.length, 1);
            assertEquals(captured[0].redirect, "manual");
            // streaming: the caller signal is passed through untouched.
            assert(captured[0].signal === controller.signal);
            // Our own flag must never reach the native fetch.
            assertEquals("streaming" in captured[0], false);
        } finally {
            globalThis.fetch = originalFetch;
            Deno.createHttpClient = originalCreateHttpClient;
            if (originalSecret === undefined) {
                Deno.env.delete("SERVER_SECRET_KEY");
            } else {
                Deno.env.set("SERVER_SECRET_KEY", originalSecret);
            }
        }
    },
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `RUN_TEST src/tests/fetchClient_init_test.ts`
Expected: FAIL at `assertEquals(captured[0].redirect, "manual")` with `undefined` vs `"manual"`.

- [ ] **Step 3: Forward the init fields on the pool path**

In `src/lib/helpers/getFetchClient.ts`, inside the pool `fn`, replace:

```ts
                    const fetchRes = await fetchShim(
                        config,
                        retryOptions,
                        input,
                        {
                            client,
                            headers: init?.headers,
                            method: init?.method,
                            body: init?.body,
                        },
                        proxyGates.get(proxyUrl),
                    );
```

with:

```ts
                    const fetchRes = await fetchShim(
                        config,
                        retryOptions,
                        input,
                        {
                            client,
                            headers: init?.headers,
                            method: init?.method,
                            body: init?.body,
                            redirect: init?.redirect,
                            signal: init?.signal,
                            streaming: init?.streaming,
                        },
                        proxyGates.get(proxyUrl),
                    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `RUN_TEST src/tests/fetchClient_init_test.ts`
Expected: `ok | 1 passed | 0 failed`

- [ ] **Step 5: Static checks and full suite**

Run: `deno task format && deno task check && deno task lint && SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test`
Expected: all pass, `0 failed`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/helpers/getFetchClient.ts src/tests/fetchClient_init_test.ts
git commit -m "fix: forward redirect, signal and streaming on the proxy-pool fetch path

The pool path rebuilt the fetch init from headers/method/body only, so
redirect: \"manual\" and caller abort signals were dropped and behaviour
differed from the single-proxy path."
```

---

### Task 3: googlevideo URL helpers (spec B2, B6)

**Files:**
- Create: `src/lib/helpers/googlevideoUrl.ts`
- Test: `src/tests/googlevideoUrl_test.ts`

**Interfaces:**
- Produces:
  - `export const GOOGLEVIDEO_HOST_PATTERN: RegExp` (`/^[\w-]+\.googlevideo\.com$/`)
  - `export function isGooglevideoHost(host: string | undefined): boolean`
  - `export function resolveRedirectTarget(locationHeader: string, base: string): string | null` — absolute `https://<googlevideo host>/...` URL or `null` when the target is not an https googlevideo host or unparsable.
  - `export function isValidExpire(expire: string | undefined, nowSeconds: number): boolean` — true only for a non-negative integer string ≥ `nowSeconds`.
- Task 4 uses all three.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/googlevideoUrl_test.ts`:

```ts
import { assertEquals } from "./deps.ts";
import {
    isGooglevideoHost,
    isValidExpire,
    resolveRedirectTarget,
} from "../lib/helpers/googlevideoUrl.ts";

Deno.test("isGooglevideoHost", async (t) => {
    await t.step("accepts a googlevideo subdomain", () => {
        assertEquals(isGooglevideoHost("rr3---sn-4g5edne6.googlevideo.com"), true);
    });

    await t.step("rejects suffix and userinfo tricks", () => {
        assertEquals(isGooglevideoHost("rr3.googlevideo.com.evil.com"), false);
        assertEquals(isGooglevideoHost("rr3.googlevideo.com@evil.com"), false);
        assertEquals(isGooglevideoHost("googlevideo.com"), false);
        assertEquals(isGooglevideoHost(undefined), false);
        assertEquals(isGooglevideoHost(""), false);
    });
});

Deno.test("resolveRedirectTarget", async (t) => {
    const base = "https://rr1---sn-a.googlevideo.com/videoplayback?id=1";

    await t.step("returns an absolute googlevideo https URL", () => {
        assertEquals(
            resolveRedirectTarget(
                "https://rr2---sn-b.googlevideo.com/videoplayback?id=1&x=2",
                base,
            ),
            "https://rr2---sn-b.googlevideo.com/videoplayback?id=1&x=2",
        );
    });

    await t.step("resolves a relative Location against the base", () => {
        assertEquals(
            resolveRedirectTarget("/videoplayback?id=1&r=1", base),
            "https://rr1---sn-a.googlevideo.com/videoplayback?id=1&r=1",
        );
    });

    await t.step("rejects non-googlevideo hosts", () => {
        assertEquals(
            resolveRedirectTarget("https://evil.com/videoplayback", base),
            null,
        );
    });

    await t.step("rejects non-https targets", () => {
        assertEquals(
            resolveRedirectTarget(
                "http://rr2---sn-b.googlevideo.com/videoplayback",
                base,
            ),
            null,
        );
    });

    await t.step("rejects unparsable Location values", () => {
        assertEquals(resolveRedirectTarget("http://[::1", base), null);
    });
});

Deno.test("isValidExpire", async (t) => {
    const now = 1_700_000_000;

    await t.step("accepts a future integer timestamp", () => {
        assertEquals(isValidExpire(String(now + 60), now), true);
    });

    await t.step("accepts the current second", () => {
        assertEquals(isValidExpire(String(now), now), true);
    });

    await t.step("rejects a past timestamp", () => {
        assertEquals(isValidExpire(String(now - 1), now), false);
    });

    await t.step("rejects non-numeric, float, empty and missing values", () => {
        assertEquals(isValidExpire("abc", now), false);
        assertEquals(isValidExpire("NaN", now), false);
        assertEquals(isValidExpire("1700000000.5", now), false);
        assertEquals(isValidExpire("", now), false);
        assertEquals(isValidExpire(undefined, now), false);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `RUN_TEST src/tests/googlevideoUrl_test.ts`
Expected: FAIL with `Module not found "file:///.../src/lib/helpers/googlevideoUrl.ts"`.

- [ ] **Step 3: Implement the helpers**

Create `src/lib/helpers/googlevideoUrl.ts`:

```ts
/**
 * Helpers for validating googlevideo.com URLs handled by the video proxy.
 *
 * The host check is anchored on purpose: an unanchored regex would accept
 * "rr3.googlevideo.com.evil.com" or "rr3.googlevideo.com@evil.com" and turn
 * the proxy into an open relay / SSRF primitive.
 */
export const GOOGLEVIDEO_HOST_PATTERN = /^[\w-]+\.googlevideo\.com$/;

export function isGooglevideoHost(host: string | undefined): boolean {
    return !!host && GOOGLEVIDEO_HOST_PATTERN.test(host);
}

/**
 * Resolve a redirect `Location` header against the request URL and accept it
 * only if it points at an https googlevideo host. Returns the absolute URL or
 * null when the target must not be followed.
 */
export function resolveRedirectTarget(
    locationHeader: string,
    base: string,
): string | null {
    let target: URL;
    try {
        target = new URL(locationHeader, base);
    } catch {
        return null;
    }
    if (target.protocol !== "https:") return null;
    if (!isGooglevideoHost(target.hostname)) return null;
    return target.toString();
}

const UNSIGNED_INTEGER = /^\d+$/;

/**
 * `expire` is a unix timestamp in seconds. A non-integer value (which
 * `Number()` would turn into NaN and let through a `<` comparison) is rejected.
 */
export function isValidExpire(
    expire: string | undefined,
    nowSeconds: number,
): boolean {
    if (!expire || !UNSIGNED_INTEGER.test(expire)) return false;
    return Number(expire) >= nowSeconds;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `RUN_TEST src/tests/googlevideoUrl_test.ts`
Expected: `ok | 3 passed (12 steps) | 0 failed`

- [ ] **Step 5: Static checks**

Run: `deno task format && deno task check && deno task lint`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/helpers/googlevideoUrl.ts src/tests/googlevideoUrl_test.ts
git commit -m "feat: add googlevideo URL validation helpers for the video proxy"
```

---

### Task 4: Video proxy — streaming flag, manual redirect loop, input hygiene (spec B1, B2, B6)

**Files:**
- Modify: `src/routes/videoPlaybackProxy.ts` (whole handler from `videoPlaybackProxy.get("/", …)` to the end)
- Test: `src/tests/videoPlaybackProxy_test.ts`

**Interfaces:**
- Consumes: `streaming` flag (Task 1, forwarded by Task 2); `isGooglevideoHost`, `resolveRedirectTarget`, `isValidExpire` (Task 3).
- Produces: route behaviour —
  - 400 `"Invalid host"` (unchanged), 400 `"Expired URL"` (now also for non-integer `expire`), 400 `"Missing client"` (unchanged), 400 `"Invalid encrypted data parameter"` (unchanged)
  - follows up to `MAX_REDIRECTS = 5` googlevideo redirects manually; 400 `"Invalid redirect target."` for a non-googlevideo/https target; 502 `"Too many redirects."` after 5
  - `enc`, `data`, `host`, `title` are removed from the upstream query.
  - Contract note: the new 400/502 bodies only occur on paths that previously produced a broken 302 (direct mode) or an implicit follow (pool mode), so Invidious needs no change.

- [ ] **Step 1: Write the failing route tests**

Create `src/tests/videoPlaybackProxy_test.ts`:

```ts
import { Hono } from "hono";
import { assert, assertEquals } from "./deps.ts";
import type { HonoVariables } from "../lib/types/HonoVariables.ts";
import type { Config } from "../lib/helpers/config.ts";

const GV_A = "rr1---sn-a.googlevideo.com";
const GV_B = "rr2---sn-b.googlevideo.com";

type FetchCall = { url: string; init: RequestInit };

/**
 * Build an app with the real videoPlaybackProxy mounted and config/metrics
 * injected, and replace globalThis.fetch with `respond`. The default config
 * has no proxy and no pool, so getFetchClient uses the direct path, which
 * calls globalThis.fetch. A fresh config object per test rebuilds the
 * getFetchClient singleton.
 */
async function withProxyApp(
    respond: (call: FetchCall, index: number) => Response,
    run: (
        app: Hono<{ Variables: HonoVariables }>,
        calls: FetchCall[],
    ) => Promise<void>,
): Promise<void> {
    const originalFetch = globalThis.fetch;
    const originalSecret = Deno.env.get("SERVER_SECRET_KEY");
    const calls: FetchCall[] = [];
    try {
        Deno.env.set("SERVER_SECRET_KEY", "aaaaaaaaaaaaaaaa");
        const { parseConfig } = await import("../lib/helpers/config.ts");
        const { default: videoPlaybackProxy } = await import(
            "../routes/videoPlaybackProxy.ts"
        );
        const base = await parseConfig();
        // Force the direct path regardless of PROXY / IPv6 env on the host.
        const config: Config = {
            ...base,
            networking: {
                ...base.networking,
                proxy: null,
                ipv6_block: null,
                proxy_pool: { ...base.networking.proxy_pool, enabled: false },
            },
        };

        globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            const call = { url: String(input), init: init ?? {} };
            calls.push(call);
            return Promise.resolve(respond(call, calls.length - 1));
        }) as typeof fetch;

        const app = new Hono<{ Variables: HonoVariables }>();
        app.use("*", async (c, next) => {
            c.set("config", config);
            c.set("metrics", undefined);
            await next();
        });
        app.route("/videoplayback", videoPlaybackProxy);

        await run(app, calls);
    } finally {
        globalThis.fetch = originalFetch;
        if (originalSecret === undefined) {
            Deno.env.delete("SERVER_SECRET_KEY");
        } else {
            Deno.env.set("SERVER_SECRET_KEY", originalSecret);
        }
    }
}

function futureExpire(): string {
    return String(Math.floor(Date.now() / 1000) + 3600);
}

function videoResponse(status = 200): Response {
    return new Response("video-bytes", {
        status,
        headers: { "content-type": "video/mp4", "content-length": "11" },
    });
}

Deno.test("videoPlaybackProxy", async (t) => {
    await t.step("streams a 200 through and marks the fetch as streaming", async () => {
        await withProxyApp(() => videoResponse(), async (app, calls) => {
            const res = await app.request(
                `/videoplayback?host=${GV_A}&c=WEB&expire=${futureExpire()}&id=abc`,
            );
            assertEquals(res.status, 200);
            assertEquals(await res.text(), "video-bytes");
            assertEquals(res.headers.get("content-type"), "video/mp4");
            assertEquals(calls.length, 1);
            assert(calls[0].url.startsWith(`https://${GV_A}/videoplayback?`));
            // streaming: no timeout signal must be attached.
            assertEquals(calls[0].init.signal ?? null, null);
            assertEquals(calls[0].init.redirect, "manual");
        });
    });

    await t.step("follows a googlevideo redirect and returns the final body", async () => {
        await withProxyApp(
            (_call, index) =>
                index === 0
                    ? new Response(null, {
                        status: 302,
                        headers: {
                            location: `https://${GV_B}/videoplayback?id=abc&r=1`,
                        },
                    })
                    : videoResponse(),
            async (app, calls) => {
                const res = await app.request(
                    `/videoplayback?host=${GV_A}&c=WEB&expire=${futureExpire()}&id=abc`,
                );
                assertEquals(res.status, 200);
                assertEquals(await res.text(), "video-bytes");
                assertEquals(calls.length, 2);
                assertEquals(
                    calls[1].url,
                    `https://${GV_B}/videoplayback?id=abc&r=1`,
                );
            },
        );
    });

    await t.step("returns 502 after five redirects", async () => {
        await withProxyApp(
            () =>
                new Response(null, {
                    status: 302,
                    headers: {
                        location: `https://${GV_B}/videoplayback?id=abc`,
                    },
                }),
            async (app, calls) => {
                const res = await app.request(
                    `/videoplayback?host=${GV_A}&c=WEB&expire=${futureExpire()}&id=abc`,
                );
                assertEquals(res.status, 502);
                assertEquals(await res.text(), "Too many redirects.");
                // initial request + 5 followed redirects, then stop.
                assertEquals(calls.length, 6);
            },
        );
    });

    await t.step("returns 400 for a redirect to a foreign host", async () => {
        await withProxyApp(
            () =>
                new Response(null, {
                    status: 302,
                    headers: { location: "https://evil.com/videoplayback" },
                }),
            async (app, calls) => {
                const res = await app.request(
                    `/videoplayback?host=${GV_A}&c=WEB&expire=${futureExpire()}&id=abc`,
                );
                assertEquals(res.status, 400);
                assertEquals(await res.text(), "Invalid redirect target.");
                assertEquals(calls.length, 1);
            },
        );
    });

    await t.step("passes Range through and returns 206 with content-range", async () => {
        await withProxyApp(
            () =>
                new Response("art", {
                    status: 206,
                    headers: {
                        "content-type": "video/mp4",
                        "content-range": "bytes 0-2/11",
                        "content-length": "3",
                    },
                }),
            async (app, calls) => {
                const res = await app.request(
                    `/videoplayback?host=${GV_A}&c=WEB&expire=${futureExpire()}&id=abc`,
                    { headers: { range: "bytes=0-2" } },
                );
                assertEquals(res.status, 206);
                assertEquals(res.headers.get("content-range"), "bytes 0-2/11");
                const sent = new Headers(calls[0].init.headers);
                assertEquals(sent.get("range"), "bytes=0-2");
            },
        );
    });

    await t.step("rejects a non-integer expire with 400", async () => {
        await withProxyApp(() => videoResponse(), async (app, calls) => {
            const res = await app.request(
                `/videoplayback?host=${GV_A}&c=WEB&expire=abc&id=abc`,
            );
            assertEquals(res.status, 400);
            assertEquals(await res.text(), "Expired URL");
            assertEquals(calls.length, 0);
        });
    });

    await t.step("rejects a past expire with 400", async () => {
        await withProxyApp(() => videoResponse(), async (app, calls) => {
            const res = await app.request(
                `/videoplayback?host=${GV_A}&c=WEB&expire=1&id=abc`,
            );
            assertEquals(res.status, 400);
            assertEquals(await res.text(), "Expired URL");
            assertEquals(calls.length, 0);
        });
    });

    await t.step("rejects a non-googlevideo host with 400", async () => {
        await withProxyApp(() => videoResponse(), async (app, calls) => {
            const res = await app.request(
                `/videoplayback?host=rr1.googlevideo.com.evil.com&c=WEB&expire=${futureExpire()}`,
            );
            assertEquals(res.status, 400);
            assertEquals(await res.text(), "Invalid host");
            assertEquals(calls.length, 0);
        });
    });

    await t.step("strips host, title, enc and data from the upstream query", async () => {
        await withProxyApp(() => videoResponse(), async (app, calls) => {
            const res = await app.request(
                `/videoplayback?host=${GV_A}&c=WEB&expire=${futureExpire()}&id=abc&title=t&enc=false&data=xyz`,
            );
            assertEquals(res.status, 200);
            const upstream = new URL(calls[0].url);
            assertEquals(upstream.searchParams.has("host"), false);
            assertEquals(upstream.searchParams.has("title"), false);
            assertEquals(upstream.searchParams.has("enc"), false);
            assertEquals(upstream.searchParams.has("data"), false);
            assertEquals(upstream.searchParams.get("id"), "abc");
        });
    });

    await t.step("returns 400 for an undecryptable enc payload", async () => {
        await withProxyApp(() => videoResponse(), async (app, calls) => {
            const res = await app.request(
                `/videoplayback?host=${GV_A}&c=WEB&expire=${futureExpire()}&enc=true&data=not-base64`,
            );
            assertEquals(res.status, 400);
            assertEquals(await res.text(), "Invalid encrypted data parameter");
            assertEquals(calls.length, 0);
        });
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `RUN_TEST src/tests/videoPlaybackProxy_test.ts`
Expected: FAIL. The first step fails at `assertEquals(calls[0].init.signal ?? null, null)` (a timeout signal is attached); the redirect steps fail with status 302 instead of 200/502/400; the `expire=abc` step fails with 200 instead of 400; the strip step fails because `enc`/`data` are still present.

- [ ] **Step 3: Rewrite the handler**

Replace everything in `src/routes/videoPlaybackProxy.ts` from the line `videoPlaybackProxy.get("/", async (c) => {` to the end of the file with:

```ts
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
```

And replace the import block at the top of the file (lines 1–9) with:

```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { USER_AGENT } from "bgutils";
import { decryptQuery } from "../lib/helpers/encryptQuery.ts";
import type { Config } from "../lib/helpers/config.ts";
import type { FetchFn } from "../lib/helpers/getFetchClient.ts";
import {
    isGooglevideoHost,
    isValidExpire,
    resolveRedirectTarget,
} from "../lib/helpers/googlevideoUrl.ts";

import { resolveAndValidateFetchClientLocation } from "../lib/helpers/dynamicImportValidation.ts";

const getFetchClientLocation = resolveAndValidateFetchClientLocation();
const { getFetchClient } = await import(getFetchClientLocation);
```

Keep the `const videoPlaybackProxy = new Hono();` line and the existing `videoPlaybackProxy.options("/", …)` handler unchanged between the imports and the new code.

- [ ] **Step 4: Run tests to verify they pass**

Run: `RUN_TEST src/tests/videoPlaybackProxy_test.ts`
Expected: `ok | 1 passed (10 steps) | 0 failed`

- [ ] **Step 5: Static checks and full suite**

Run: `deno task format && deno task check && deno task lint && SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test`
Expected: all pass. `main_test` still passes its `/latest_version` 302 smoke step.

- [ ] **Step 6: Commit**

```bash
git add src/routes/videoPlaybackProxy.ts src/tests/videoPlaybackProxy_test.ts
git commit -m "fix: follow googlevideo redirects manually and stream without a body timeout

The fork had lost upstream's redirect loop: in direct mode a CDN 302 was
returned to the client with the Location header stripped, in pool mode
it was followed blindly. Redirects are now followed up to 5 times and
only to https googlevideo hosts (400 otherwise, 502 when exceeded). The
fetch is marked streaming so no whole-body timeout applies. Non-integer
expire values are rejected and enc/data are no longer forwarded upstream."
```

---

### Task 5: 403/429 without a body signal is not a bot block (spec B4)

**Files:**
- Modify: `src/lib/helpers/getFetchClient.ts` — `checkYouTubeBlock` (search for `async function checkYouTubeBlock`)
- Test: `src/tests/youtubeBlock_test.ts`

**Interfaces:**
- Consumes: `setOnYouTubeBlock` (existing export), direct fetch path.
- Produces: `checkYouTubeBlock` semantics — returns true only when the first 8 KiB of a json/html/text body contains one of `YOUTUBE_BLOCK_SIGNALS`; status alone never counts. A private helper `bodyHasBlockSignal(response)` is introduced (moved verbatim in Task 8).

- [ ] **Step 1: Write the failing test**

Create `src/tests/youtubeBlock_test.ts`:

```ts
import { assertEquals } from "./deps.ts";

/**
 * Drive checkYouTubeBlock through the direct fetch path: no proxy, no pool,
 * so getFetchClient calls globalThis.fetch and, on a detected block, fires
 * the onYouTubeBlock hook. Counting hook calls is the observable.
 */
async function blockDetected(response: Response): Promise<boolean> {
    const originalFetch = globalThis.fetch;
    const originalSecret = Deno.env.get("SERVER_SECRET_KEY");
    let hookCalls = 0;
    try {
        Deno.env.set("SERVER_SECRET_KEY", "aaaaaaaaaaaaaaaa");
        const { getFetchClient, setOnYouTubeBlock } = await import(
            "../lib/helpers/getFetchClient.ts"
        );
        const { parseConfig } = await import("../lib/helpers/config.ts");
        // Fresh object so the singleton is rebuilt; a single proxy URL
        // selects the single-proxy path (the only non-pool path that runs
        // checkYouTubeBlock). No connection is made: fetch is mocked.
        const base = await parseConfig();
        const config = {
            ...base,
            networking: {
                ...base.networking,
                proxy: "http://u:p@127.0.0.1:1",
                ipv6_block: null,
                proxy_pool: { ...base.networking.proxy_pool, enabled: false },
            },
        };
        globalThis.fetch = (() => Promise.resolve(response)) as typeof fetch;
        setOnYouTubeBlock(() => {
            hookCalls += 1;
        });

        const fetchClient = getFetchClient(config);
        const res = await fetchClient("https://www.youtube.com/youtubei/v1/player");
        await res.body?.cancel().catch(() => {});
        return hookCalls > 0;
    } finally {
        globalThis.fetch = originalFetch;
        const { setOnYouTubeBlock } = await import(
            "../lib/helpers/getFetchClient.ts"
        );
        setOnYouTubeBlock(() => {});
        if (originalSecret === undefined) {
            Deno.env.delete("SERVER_SECRET_KEY");
        } else {
            Deno.env.set("SERVER_SECRET_KEY", originalSecret);
        }
    }
}

Deno.test({
    name: "checkYouTubeBlock",
    fn: async (t) => {
        await t.step("403 text/plain without a signal is not a block", async () => {
            assertEquals(
                await blockDetected(
                    new Response("", {
                        status: 403,
                        headers: { "content-type": "text/plain" },
                    }),
                ),
                false,
            );
        });

        await t.step("429 html without a signal is not a block", async () => {
            assertEquals(
                await blockDetected(
                    new Response("<html>slow down</html>", {
                        status: 429,
                        headers: { "content-type": "text/html" },
                    }),
                ),
                false,
            );
        });

        await t.step("403 html with 'unusual traffic' is a block", async () => {
            assertEquals(
                await blockDetected(
                    new Response("<html>Our systems have detected unusual traffic</html>", {
                        status: 403,
                        headers: { "content-type": "text/html" },
                    }),
                ),
                true,
            );
        });

        await t.step("200 json with 'protect our community' is a block", async () => {
            assertEquals(
                await blockDetected(
                    new Response(
                        JSON.stringify({
                            playabilityStatus: {
                                subreason: "This helps protect our community.",
                            },
                        }),
                        {
                            status: 200,
                            headers: { "content-type": "application/json" },
                        },
                    ),
                ),
                true,
            );
        });

        await t.step("403 video/mp4 is never inspected and never a block", async () => {
            assertEquals(
                await blockDetected(
                    new Response("unusual traffic", {
                        status: 403,
                        headers: { "content-type": "video/mp4" },
                    }),
                ),
                false,
            );
        });
    },
    // The single-proxy path creates one Deno.HttpClient per config; it is
    // reused, never closed in this unit test.
    sanitizeResources: false,
});
```

Note: the single-proxy path is used (a proxy URL to `127.0.0.1:1`) rather than the direct path because the direct path never calls `checkYouTubeBlock`; the mocked `fetch` ignores the `client`.

- [ ] **Step 2: Run test to verify it fails**

Run: `RUN_TEST src/tests/youtubeBlock_test.ts`
Expected: FAIL on the first two steps (`true` vs `false`): a 403/429 with text content currently returns true even without a signal. The other three steps pass.

- [ ] **Step 3: Make status alone insufficient**

In `src/lib/helpers/getFetchClient.ts`, replace the whole `checkYouTubeBlock` function (from its doc comment to its closing brace) with:

```ts
/**
 * Read up to 8 KiB from the start of a (cloned) body and look for known
 * block phrases. Never called for binary content — see checkYouTubeBlock.
 */
async function bodyHasBlockSignal(response: Response): Promise<boolean> {
    try {
        const cloned = response.clone();
        const reader = cloned.body?.getReader();
        if (!reader) return false;
        const { value } = await reader.read();
        reader.releaseLock();
        if (!value) return false;
        const text = new TextDecoder().decode(value.slice(0, 8192))
            .toLowerCase();
        return YOUTUBE_BLOCK_SIGNALS.some((s) => text.includes(s));
    } catch {
        // Can't read body — treat as not blocked.
        return false;
    }
}

/**
 * Check if a YouTube response contains bot detection signals.
 *
 * IMPORTANT: Only checks API/HTML responses (JSON, HTML, text content types).
 * Video CDN responses (video/mp4, application/octet-stream) are NEVER checked
 * because:
 * 1. YouTube's CDN legitimately returns 403 for unsupported request patterns
 *    (e.g., expired URLs, invalid ranges) — these are NOT bot blocks
 * 2. Reading video response bodies would buffer entire videos into memory (OOM)
 * 3. Treating video CDN 403s as bot blocks would falsely blacklist proxies
 *
 * A block is ONLY reported when the body carries one of YOUTUBE_BLOCK_SIGNALS.
 * A 403/429 with no such phrase (e.g. a CDN 403 served as text/plain, or a
 * generic 429) is not a bot block: treating it as one blacklisted proxies
 * and triggered session regenerations for ordinary CDN errors.
 *
 * Checked statuses: 403, 429 and 200 (YouTube returns 200 OK with the block
 * message inside playabilityStatus for Innertube calls).
 */
async function checkYouTubeBlock(response: Response): Promise<boolean> {
    const contentType = (response.headers.get("content-type") || "")
        .toLowerCase();
    const isTextContent = contentType.includes("json") ||
        contentType.includes("html") ||
        contentType.includes("text");
    if (!isTextContent) {
        return false;
    }
    const inspectedStatus = response.status === 403 ||
        response.status === 429 || response.status === 200;
    if (!inspectedStatus) {
        return false;
    }
    return await bodyHasBlockSignal(response);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `RUN_TEST src/tests/youtubeBlock_test.ts`
Expected: `ok | 1 passed (5 steps) | 0 failed`

- [ ] **Step 5: Static checks and full suite**

Run: `deno task format && deno task check && deno task lint && SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test`
Expected: all pass. The proxy-pool failover test in `proxy_pool_test.ts` uses a 200 JSON body containing "protect our community", which is still detected.

- [ ] **Step 6: Commit**

```bash
git add src/lib/helpers/getFetchClient.ts src/tests/youtubeBlock_test.ts
git commit -m "fix: only count a YouTube response as a bot block when the body says so

A 403/429 with a text content-type but no block phrase (e.g. a CDN 403
served as text/plain) was treated as a bot block, which counted proxy
failures and triggered session regenerations for ordinary CDN errors."
```

---

### Task 6: Single-flight, throttled cooldown revalidation (spec B5)

**Files:**
- Modify: `src/lib/helpers/getFetchClient.ts` — `revalidateCooldownProxies` inside the pool block (search for `const revalidateCooldownProxies`)
- Test: `src/tests/proxy_pool_revalidate_test.ts`

**Interfaces:**
- Produces: inside the pool, `REVALIDATE_MIN_INTERVAL_MS = 30_000`; `revalidateCooldownProxies()` shares one in-flight promise between concurrent callers and runs at most once per interval. Behaviour change to document: after a 1-hour blacklist expires, recovery may be delayed by up to 30 s. Task 10 moves this verbatim.

- [ ] **Step 1: Write the failing test**

Create `src/tests/proxy_pool_revalidate_test.ts`:

```ts
import { assertEquals } from "./deps.ts";

Deno.test({
    name:
        "proxy pool revalidation - concurrent requests share one probe per cooled-down proxy",
    fn: async () => {
        const originalFetch = globalThis.fetch;
        const originalCreateHttpClient = Deno.createHttpClient;
        const originalDateNow = Date.now;
        const originalSecret = Deno.env.get("SERVER_SECRET_KEY");
        let now = 1_000_000;
        let createdClients = 0;
        const probesByClient = new Map<number, number>();
        let requestCount = 0;

        Date.now = () => now;
        Deno.createHttpClient = (() => {
            createdClients += 1;
            return { __clientId: createdClients } as unknown as Deno.HttpClient;
        }) as typeof Deno.createHttpClient;

        globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            const clientId =
                (init as RequestInit & { client?: { __clientId?: number } })
                    ?.client?.__clientId || 0;
            const url = String(input);
            if (url.includes("generate_204")) {
                probesByClient.set(
                    clientId,
                    (probesByClient.get(clientId) || 0) + 1,
                );
                // Probes are slow so concurrent callers overlap.
                return new Promise((resolve) =>
                    setTimeout(
                        () =>
                            resolve(
                                new Response(JSON.stringify({ status: "OK" }), {
                                    status: 200,
                                    headers: {
                                        "content-type": "application/json",
                                    },
                                }),
                            ),
                        20,
                    )
                );
            }
            requestCount += 1;
            // Client 1 is always blocked so it gets blacklisted; client 2 works.
            if (clientId === 1) {
                return Promise.resolve(
                    new Response(
                        "<html>please sign in to confirm you're not a bot</html>",
                        {
                            status: 403,
                            headers: { "content-type": "text/html" },
                        },
                    ),
                );
            }
            return Promise.resolve(
                new Response(JSON.stringify({ playabilityStatus: "OK" }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
            );
        }) as typeof fetch;

        try {
            Deno.env.set("SERVER_SECRET_KEY", "aaaaaaaaaaaaaaaa");
            const { getFetchClient } = await import(
                "../lib/helpers/getFetchClient.ts"
            );
            const { parseConfig } = await import("../lib/helpers/config.ts");
            const config = await parseConfig();
            const testConfig = {
                ...config,
                networking: {
                    ...config.networking,
                    proxy_pool: {
                        enabled: true,
                        rotation: "round-robin" as const,
                        health_check: true,
                        switch_proxy_on_limit: false,
                        proxies: [
                            "http://u:p@proxy1:8080",
                            "http://u:p@proxy2:8080",
                        ],
                    },
                },
            };
            const fetchClient = getFetchClient(testConfig);

            // Three blocked responses on proxy1 blacklist it (failover lands
            // on proxy2 within each request).
            await fetchClient("http://example.com/1");
            await fetchClient("http://example.com/2");
            await fetchClient("http://example.com/3");
            const probesBefore = probesByClient.get(1) || 0;

            // Cooldown expires; five concurrent requests arrive at once.
            now += 3_600_001;
            await Promise.all([
                fetchClient("http://example.com/a"),
                fetchClient("http://example.com/b"),
                fetchClient("http://example.com/c"),
                fetchClient("http://example.com/d"),
                fetchClient("http://example.com/e"),
            ]);

            // Exactly one cooldown probe for proxy1, not five.
            assertEquals((probesByClient.get(1) || 0) - probesBefore, 1);
            assertEquals(requestCount >= 8, true);
        } finally {
            Date.now = originalDateNow;
            globalThis.fetch = originalFetch;
            Deno.createHttpClient = originalCreateHttpClient;
            if (originalSecret === undefined) {
                Deno.env.delete("SERVER_SECRET_KEY");
            } else {
                Deno.env.set("SERVER_SECRET_KEY", originalSecret);
            }
        }
    },
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `RUN_TEST src/tests/proxy_pool_revalidate_test.ts`
Expected: FAIL at the probe-count assertion: `5` (or more) vs `1`.

- [ ] **Step 3: Single-flight the revalidation**

In `src/lib/helpers/getFetchClient.ts`, inside the pool block, add next to `const BLACKLIST_MS = 3_600_000; // 1 hour`:

```ts
        // Cooldown re-validation is a network probe. Run it at most once per
        // interval and share one in-flight run between concurrent requests,
        // otherwise every request that arrives after a blacklist expires
        // probes the same proxy in parallel (and pays the probe latency).
        const REVALIDATE_MIN_INTERVAL_MS = 30_000;
        let revalidateInFlight: Promise<void> | null = null;
        let lastRevalidateAt = 0;
```

Then replace the existing `revalidateCooldownProxies` definition with:

```ts
        const runCooldownRevalidation = async (): Promise<void> => {
            const candidates = getCooldownExpiredProxies();
            for (const proxyUrl of candidates) {
                const isHealthy = await probeProxyHealth(proxyUrl);
                if (isHealthy) {
                    healthyProxies.add(proxyUrl);
                    failureCounts.set(proxyUrl, 0);
                    metricsRef?.proxyRecoveries.inc();
                    logInfo(
                        CTX.PROXY,
                        `Recovered after cooldown and probe: ${
                            maskProxyUrl(proxyUrl)
                        }`,
                    );
                } else {
                    lastBlacklistTime.set(proxyUrl, Date.now());
                    logWarn(
                        CTX.PROXY,
                        `Probe failed after cooldown; keeping blacklisted: ${
                            maskProxyUrl(proxyUrl)
                        }`,
                    );
                }
            }
        };

        const revalidateCooldownProxies = (): Promise<void> => {
            if (revalidateInFlight) return revalidateInFlight;
            const now = Date.now();
            if (now - lastRevalidateAt < REVALIDATE_MIN_INTERVAL_MS) {
                return Promise.resolve();
            }
            lastRevalidateAt = now;
            revalidateInFlight = runCooldownRevalidation().finally(() => {
                revalidateInFlight = null;
            });
            return revalidateInFlight;
        };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `RUN_TEST src/tests/proxy_pool_revalidate_test.ts`
Expected: `ok | 1 passed | 0 failed`

- [ ] **Step 5: Static checks and full suite**

Run: `deno task format && deno task check && deno task lint && SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test`
Expected: all pass. In particular `proxy_pool_test.ts` "cooldown expiry triggers probe and failed proxy is blacklisted again" still passes: its `now += 3_600_001` jump exceeds the 30 s interval.

- [ ] **Step 6: Commit**

```bash
git add src/lib/helpers/getFetchClient.ts src/tests/proxy_pool_revalidate_test.ts
git commit -m "perf: single-flight and throttle proxy cooldown revalidation

revalidateCooldownProxies ran on every request and could probe the same
cooled-down proxy from many concurrent requests. It now shares one
in-flight run and executes at most once per 30 s."
```

---

### Task 7: Extract `FetchGate` (spec B7, part 1)

**Files:**
- Create: `src/lib/helpers/fetchGate.ts`
- Modify: `src/lib/helpers/getFetchClient.ts` (remove the class, add import)

**Interfaces:**
- Produces: `export class FetchGate` with the existing public surface `constructor(maxConcurrent: number, minIntervalMs: number)`, `run<T>(fn: () => Promise<T>): Promise<T>`, `saturated(): boolean`. Tasks 9 and 10 import it.

- [ ] **Step 1: Create the module by moving the class verbatim**

Create `src/lib/helpers/fetchGate.ts`:

```ts
/**
 * Best-effort outbound rate limiter. Caps the number of concurrent in-flight
 * requests and optionally enforces a minimum spacing between request starts.
 * Shared process-wide; combined with the failover-only proxy pool this
 * throttles how hard the single active egress IP is hit.
 */
export class FetchGate {
    private active = 0;
    private readonly waiters: Array<() => void> = [];
    private nextStart = 0;

    constructor(
        private readonly maxConcurrent: number,
        private readonly minIntervalMs: number,
    ) {}

    async run<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }

    // True when no concurrency slot is free right now. Used by the proxy pool
    // to decide whether to hop to another proxy instead of queuing here.
    saturated(): boolean {
        return this.active >= this.maxConcurrent;
    }

    private async acquire(): Promise<void> {
        if (this.active >= this.maxConcurrent) {
            await new Promise<void>((resolve) => this.waiters.push(resolve));
        }
        this.active++;
        if (this.minIntervalMs > 0) {
            const now = Date.now();
            const startAt = Math.max(now, this.nextStart);
            this.nextStart = startAt + this.minIntervalMs;
            const wait = startAt - now;
            if (wait > 0) {
                await new Promise((resolve) => setTimeout(resolve, wait));
            }
        }
    }

    private release(): void {
        this.active--;
        const next = this.waiters.shift();
        if (next) next();
    }
}
```

- [ ] **Step 2: Remove the class from `getFetchClient.ts` and import it**

Delete the `class FetchGate { … }` block (with its doc comment) from `src/lib/helpers/getFetchClient.ts` and add at the top, after the `@std/async` import:

```ts
import { FetchGate } from "./fetchGate.ts";
```

- [ ] **Step 3: Verify nothing changed behaviourally**

Run: `deno task format && deno task check && deno task lint && SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test`
Expected: all pass, `0 failed`. `wc -l src/lib/helpers/getFetchClient.ts` is about 50 lines shorter.

- [ ] **Step 4: Commit**

```bash
git add src/lib/helpers/fetchGate.ts src/lib/helpers/getFetchClient.ts
git commit -m "refactor: move FetchGate rate limiter into its own module"
```

---

### Task 8: Extract block detection and URL masking (spec B7, part 2)

**Files:**
- Create: `src/lib/helpers/youtubeBlockDetection.ts`
- Modify: `src/lib/helpers/getFetchClient.ts`

**Interfaces:**
- Produces: `export const YOUTUBE_BLOCK_SIGNALS: string[]`, `export async function checkYouTubeBlock(response: Response): Promise<boolean>` (Task 5 semantics), `export function maskProxyUrl(url: string): string`. Task 10 imports `checkYouTubeBlock` and `maskProxyUrl`.

- [ ] **Step 1: Create the module by moving the code verbatim**

Create `src/lib/helpers/youtubeBlockDetection.ts` containing, in this order:

```ts
/**
 * Detection of YouTube anti-bot responses and safe logging of proxy URLs.
 */
export const YOUTUBE_BLOCK_SIGNALS = [
    "unusual traffic",
    "protect our community",
    "please sign in to confirm you're not a bot",
    "captcha",
];
```

followed by the `bodyHasBlockSignal` function and the `checkYouTubeBlock` function exactly as written in Task 5 Step 3, with `async function checkYouTubeBlock` changed to `export async function checkYouTubeBlock`, followed by:

```ts
/**
 * Mask credentials in proxy URLs for safe logging.
 * http://user:pass@1.2.3.4:8080 → http://1.2.3.4:8080
 */
export function maskProxyUrl(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.username || parsed.password) {
            return `${parsed.protocol}//${parsed.host}`;
        }
        return url;
    } catch {
        return url;
    }
}
```

- [ ] **Step 2: Remove the moved code from `getFetchClient.ts` and import it**

Delete `YOUTUBE_BLOCK_SIGNALS`, `bodyHasBlockSignal`, `checkYouTubeBlock` and `maskProxyUrl` from `src/lib/helpers/getFetchClient.ts`. Add after the `fetchGate.ts` import:

```ts
import {
    checkYouTubeBlock,
    maskProxyUrl,
} from "./youtubeBlockDetection.ts";
```

- [ ] **Step 3: Verify**

Run: `deno task format && deno task check && deno task lint && SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test`
Expected: all pass. `youtubeBlock_test.ts` from Task 5 still passes unchanged (it goes through `getFetchClient`).

- [ ] **Step 4: Commit**

```bash
git add src/lib/helpers/youtubeBlockDetection.ts src/lib/helpers/getFetchClient.ts
git commit -m "refactor: move YouTube block detection and proxy URL masking into their own module"
```

---

### Task 9: Extract `fetchShim`, `buildFetchSignal` and the fetch types (spec B7, part 3)

**Files:**
- Create: `src/lib/helpers/fetchShim.ts`
- Modify: `src/lib/helpers/getFetchClient.ts`, `src/tests/fetchSignal_test.ts` (import path), `src/routes/videoPlaybackProxy.ts` (type import path)

**Interfaces:**
- Produces from `fetchShim.ts`: `FetchInputParameter`, `FetchInitParameterWithClient`, `FetchReturn`, `FetchFn` (types from Task 1), `buildFetchSignal` (Task 1), and
  `export function fetchShim(config: Config, retryOptions: RetryOptions, input: FetchInputParameter, init: FetchInitParameterWithClient | undefined, gate: FetchGate | undefined, onRetry: () => void): FetchReturn`.
  The last parameter replaces the module-level `metricsRef?.upstreamRetries.inc()` so `fetchShim.ts` has no module state. `getFetchClient.ts` re-exports the types (`export type { FetchFn, … } from "./fetchShim.ts"`) so `videoPlaybackProxy.ts` may import from either; use `fetchShim.ts` directly.

- [ ] **Step 1: Create the module**

Create `src/lib/helpers/fetchShim.ts`:

```ts
import { retry, type RetryOptions } from "@std/async";
import type { Config } from "./config.ts";
import type { FetchGate } from "./fetchGate.ts";

export type FetchInputParameter = Parameters<typeof fetch>[0];
/**
 * `client`: a pre-built Deno.HttpClient (proxy / local address binding).
 * `streaming`: set by callers that stream a large body (video proxy). When
 * true, fetchShim attaches NO timeout signal, because `AbortSignal.timeout`
 * covers the whole body read and would cut long transfers. A header-phase
 * timeout for streaming requests is a follow-up (not covered here).
 */
export type FetchInitParameterWithClient = RequestInit & {
    client?: Deno.HttpClient;
    streaming?: boolean;
};
export type FetchReturn = ReturnType<typeof fetch>;
export type FetchFn = (
    input: FetchInputParameter,
    init?: FetchInitParameterWithClient,
) => FetchReturn;

/**
 * Decide which AbortSignal a fetch gets.
 * - streaming: only the caller's signal (or none); never a timeout.
 * - otherwise: the timeout signal, combined with the caller's signal when one
 *   is given so neither is silently dropped.
 */
export function buildFetchSignal(
    timeoutMs: number | undefined,
    callerSignal: AbortSignal | null | undefined,
    streaming: boolean | undefined,
): AbortSignal | null {
    if (streaming || !timeoutMs) {
        return callerSignal ?? null;
    }
    const timeoutSignal = AbortSignal.timeout(Number(timeoutMs));
    if (!callerSignal) {
        return timeoutSignal;
    }
    return AbortSignal.any([callerSignal, timeoutSignal]);
}

/**
 * The one place every outbound YouTube request passes through: applies the
 * timeout policy, the optional retry loop and the rate gate.
 * `onRetry` is invoked for every attempt after the first (metrics hook).
 */
export function fetchShim(
    config: Config,
    retryOptions: RetryOptions,
    input: FetchInputParameter,
    init: FetchInitParameterWithClient | undefined,
    gate: FetchGate | undefined,
    onRetry: () => void,
): FetchReturn {
    const fetchTimeout = config.networking.fetch?.timeout_ms;
    const fetchRetry = config.networking.fetch?.retry?.enabled;
    // `streaming` is our own flag, never handed to the native fetch.
    const { streaming, signal: callerSignal, ...nativeInit } = init ?? {};
    let attempt = 0;
    const callFetch = () => {
        // Every invocation after the first is a retry.
        if (attempt++ > 0) onRetry();
        const doFetch = () =>
            fetch(input, {
                ...nativeInit,
                // A fresh timeout per attempt, so retries get the full budget.
                signal: buildFetchSignal(fetchTimeout, callerSignal, streaming),
            });
        return gate ? gate.run(doFetch) : doFetch();
    };
    return fetchRetry ? retry(callFetch, retryOptions) : callFetch();
}
```

- [ ] **Step 2: Update `getFetchClient.ts`**

Delete the type block, `buildFetchSignal` and `fetchShim` from `src/lib/helpers/getFetchClient.ts`. Replace the top-of-file imports with:

```ts
import type { RetryOptions } from "@std/async";
import type { Config } from "./config.ts";
import type { Metrics } from "./metrics.ts";
import { generateRandomIPv6 } from "./ipv6Rotation.ts";
import { CTX, logInfo, logWarn } from "./log.ts";
import { FetchGate } from "./fetchGate.ts";
import { checkYouTubeBlock, maskProxyUrl } from "./youtubeBlockDetection.ts";
import {
    type FetchInitParameterWithClient,
    type FetchInputParameter,
    type FetchFn,
    fetchShim as rawFetchShim,
} from "./fetchShim.ts";

export type {
    FetchFn,
    FetchInitParameterWithClient,
    FetchInputParameter,
    FetchReturn,
} from "./fetchShim.ts";
export { buildFetchSignal } from "./fetchShim.ts";
```

Add, right after the `let fetchGate: FetchGate | undefined;` line, a local adapter that keeps every existing call site unchanged (they call `fetchShim(config, retryOptions, input, init[, gate])`):

```ts
// Adapter: keeps the module-level gate and the retry metric out of fetchShim.ts.
function fetchShim(
    config: Config,
    retryOptions: RetryOptions,
    input: FetchInputParameter,
    init?: FetchInitParameterWithClient,
    gate?: FetchGate,
) {
    return rawFetchShim(
        config,
        retryOptions,
        input,
        init,
        gate ?? fetchGate,
        () => metricsRef?.upstreamRetries.inc(),
    );
}
```

- [ ] **Step 3: Update the two importers**

In `src/tests/fetchSignal_test.ts` change the import to:

```ts
import { buildFetchSignal } from "../lib/helpers/fetchShim.ts";
```

In `src/routes/videoPlaybackProxy.ts` change the type import to:

```ts
import type { FetchFn } from "../lib/helpers/fetchShim.ts";
```

- [ ] **Step 4: Verify**

Run: `deno task format && deno task check && deno task lint && SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test`
Expected: all pass, `0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/helpers/fetchShim.ts src/lib/helpers/getFetchClient.ts src/tests/fetchSignal_test.ts src/routes/videoPlaybackProxy.ts
git commit -m "refactor: move fetchShim, buildFetchSignal and fetch types into fetchShim.ts"
```

---

### Task 10: Extract the proxy pool (spec B7, part 4)

**Files:**
- Create: `src/lib/helpers/proxyPool.ts`
- Modify: `src/lib/helpers/getFetchClient.ts` (replace the pool block with a `createProxyPool` call)

**Interfaces:**
- Consumes: `FetchGate` (Task 7), `checkYouTubeBlock`, `maskProxyUrl` (Task 8), `fetchShim` types (Task 9).
- Produces:

```ts
export interface ProxyPoolDeps {
    config: Config;
    retryOptions: RetryOptions;
    fetchShim: (
        config: Config,
        retryOptions: RetryOptions,
        input: FetchInputParameter,
        init?: FetchInitParameterWithClient,
        gate?: FetchGate,
    ) => FetchReturn;
    getMetrics: () => Metrics | undefined;
    getOnYouTubeBlock: () => (() => void) | undefined;
    getOnActiveProxyChange: () => ((proxyUrl: string) => void) | undefined;
}
export interface ProxyPool {
    fetch: FetchFn;
    ensureActiveProxy: (excluded?: Set<string>) => Promise<string | null>;
    rotateActiveProxy: () => Promise<string | null>;
}
export function createProxyPool(deps: ProxyPoolDeps): ProxyPool;
```

  `getFetchClient.ts` wires `poolActiveProxySelector = pool.ensureActiveProxy`, `rotateActiveEgressProxy = pool.rotateActiveProxy`, `cachedFetchFn = pool.fetch`. The accessors are functions (not values) because `metricsRef`, `onYouTubeBlock` and `onActiveProxyChange` are set after the pool may have been created.

- [ ] **Step 1: Create `proxyPool.ts` with the pool body moved verbatim**

Create `src/lib/helpers/proxyPool.ts`. The body between `// ---- moved verbatim ----` markers is the existing pool block from `getFetchClient.ts` (everything from `const proxyClients = new Map…` to the end of `const fn: FetchFn = …`), with exactly these substitutions: `metricsRef?.` → `deps.getMetrics()?.`, `onYouTubeBlock?.()` → `deps.getOnYouTubeBlock()?.()`, `onActiveProxyChange?.(proxyUrl)` → `deps.getOnActiveProxyChange()?.(proxyUrl)`, `fetchShim(` → `deps.fetchShim(`, `config` → `deps.config` where it is passed to `fetchShim`, `retryOptions` → `deps.retryOptions`, and the `proxyPool`/`rl` locals derived from `deps.config`.

```ts
import type { RetryOptions } from "@std/async";
import type { Config } from "./config.ts";
import type { Metrics } from "./metrics.ts";
import { CTX, logInfo, logWarn } from "./log.ts";
import { FetchGate } from "./fetchGate.ts";
import { checkYouTubeBlock, maskProxyUrl } from "./youtubeBlockDetection.ts";
import type {
    FetchFn,
    FetchInitParameterWithClient,
    FetchInputParameter,
    FetchReturn,
} from "./fetchShim.ts";

export interface ProxyPoolDeps {
    config: Config;
    retryOptions: RetryOptions;
    fetchShim: (
        config: Config,
        retryOptions: RetryOptions,
        input: FetchInputParameter,
        init?: FetchInitParameterWithClient,
        gate?: FetchGate,
    ) => FetchReturn;
    getMetrics: () => Metrics | undefined;
    getOnYouTubeBlock: () => (() => void) | undefined;
    getOnActiveProxyChange: () => ((proxyUrl: string) => void) | undefined;
}

export interface ProxyPool {
    fetch: FetchFn;
    ensureActiveProxy: (excluded?: Set<string>) => Promise<string | null>;
    rotateActiveProxy: () => Promise<string | null>;
}

const FAILURE_THRESHOLD = 3;
const BLACKLIST_MS = 3_600_000; // 1 hour
// Cooldown re-validation is a network probe. Run it at most once per
// interval and share one in-flight run between concurrent requests,
// otherwise every request that arrives after a blacklist expires
// probes the same proxy in parallel (and pays the probe latency).
const REVALIDATE_MIN_INTERVAL_MS = 30_000;

/**
 * Failover-only proxy pool. It pins a single active proxy and routes
 * everything through it; `rotation` (round-robin | random) only decides
 * which proxy becomes active *next* after the current one is blacklisted
 * (3 failures / a detected block / a failed health probe). This is
 * deliberate: one logical session should egress from one IP so PO tokens,
 * visitor_data, and stream requests stay IP-consistent. It does NOT spread
 * load across proxies within a session (except the rate-limit-aware hop
 * when `switch_proxy_on_limit` is enabled).
 *
 * Precondition (checked by the caller): `config.networking.proxy_pool` is
 * enabled with at least one proxy.
 */
export function createProxyPool(deps: ProxyPoolDeps): ProxyPool {
    const proxyPool = deps.config.networking.proxy_pool;
    const rl = deps.config.networking.rate_limit;

    // ---- moved verbatim from getFetchClient.ts (pool block) ----
    const proxyClients = new Map<string, Deno.HttpClient>();
    const allProxyUrls = [...proxyPool.proxies]; // permanent list for recovery
    const healthyProxies = new Set(proxyPool.proxies);
    const failureCounts = new Map<string, number>();
    const lastBlacklistTime = new Map<string, number>();
    let activeProxyUrl: string | null = null;
    let revalidateInFlight: Promise<void> | null = null;
    let lastRevalidateAt = 0;

    const switchProxyOnLimit = proxyPool.switch_proxy_on_limit &&
        !!rl?.enabled;

    // Per-proxy rate gates: throttle each egress IP independently rather
    // than process-wide. The caller disables its shared gate on this path.
    const proxyGates = new Map<string, FetchGate>();
    if (rl?.enabled) {
        for (const proxyUrl of allProxyUrls) {
            proxyGates.set(
                proxyUrl,
                new FetchGate(rl.max_concurrent, rl.min_interval_ms),
            );
        }
    }

    const setActiveProxy = (proxyUrl: string): void => {
        const changed = activeProxyUrl !== proxyUrl;
        activeProxyUrl = proxyUrl;
        if (changed && switchProxyOnLimit) {
            deps.getOnActiveProxyChange()?.(proxyUrl);
        }
    };

    for (const proxyUrl of proxyPool.proxies) {
        try {
            proxyClients.set(
                proxyUrl,
                Deno.createHttpClient({ proxy: { url: proxyUrl } }),
            );
        } catch (e) {
            logWarn(
                CTX.PROXY,
                `Failed to init: ${maskProxyUrl(proxyUrl)} — ${e}`,
            );
            healthyProxies.delete(proxyUrl);
        }
    }

    let rrIndex = 0;

    const getCooldownExpiredProxies = (): string[] => {
        const now = Date.now();
        const recovered: string[] = [];
        for (const proxyUrl of allProxyUrls) {
            if (healthyProxies.has(proxyUrl)) continue;
            const lastBlacklist = lastBlacklistTime.get(proxyUrl) || 0;
            if (now - lastBlacklist > BLACKLIST_MS) {
                recovered.push(proxyUrl);
            }
        }
        return recovered;
    };

    const getNextHealthyProxy = (
        excluded: Set<string> = new Set(),
    ): string | null => {
        if (healthyProxies.size === 0) return null;
        const candidates = Array.from(healthyProxies).filter((proxy) =>
            !excluded.has(proxy)
        );
        if (candidates.length === 0) return null;
        if (proxyPool.rotation === "random") {
            return candidates[Math.floor(Math.random() * candidates.length)];
        }
        // Round-robin
        const proxy = candidates[rrIndex % candidates.length];
        rrIndex = (rrIndex + 1) % candidates.length;
        return proxy;
    };

    const probeProxyHealth = async (proxyUrl: string): Promise<boolean> => {
        const client = proxyClients.get(proxyUrl);
        if (!client) return false;
        try {
            const response = await deps.fetchShim(
                deps.config,
                deps.retryOptions,
                "https://www.youtube.com/generate_204",
                { client, method: "GET" },
            );
            const isBlocked = await checkYouTubeBlock(response);
            return !isBlocked && response.ok;
        } catch {
            return false;
        }
    };

    const runCooldownRevalidation = async (): Promise<void> => {
        const candidates = getCooldownExpiredProxies();
        for (const proxyUrl of candidates) {
            const isHealthy = await probeProxyHealth(proxyUrl);
            if (isHealthy) {
                healthyProxies.add(proxyUrl);
                failureCounts.set(proxyUrl, 0);
                deps.getMetrics()?.proxyRecoveries.inc();
                logInfo(
                    CTX.PROXY,
                    `Recovered after cooldown and probe: ${
                        maskProxyUrl(proxyUrl)
                    }`,
                );
            } else {
                lastBlacklistTime.set(proxyUrl, Date.now());
                logWarn(
                    CTX.PROXY,
                    `Probe failed after cooldown; keeping blacklisted: ${
                        maskProxyUrl(proxyUrl)
                    }`,
                );
            }
        }
    };

    const revalidateCooldownProxies = (): Promise<void> => {
        if (revalidateInFlight) return revalidateInFlight;
        const now = Date.now();
        if (now - lastRevalidateAt < REVALIDATE_MIN_INTERVAL_MS) {
            return Promise.resolve();
        }
        lastRevalidateAt = now;
        revalidateInFlight = runCooldownRevalidation().finally(() => {
            revalidateInFlight = null;
        });
        return revalidateInFlight;
    };

    const markProxyFailure = (proxyUrl: string) => {
        if (!proxyPool.health_check) return;
        const count = (failureCounts.get(proxyUrl) || 0) + 1;
        failureCounts.set(proxyUrl, count);
        if (count >= FAILURE_THRESHOLD) {
            deps.getMetrics()?.proxyBlacklists.inc();
            logWarn(
                CTX.PROXY,
                `Blacklisted for 1h: ${
                    maskProxyUrl(proxyUrl)
                } (${count} failures)`,
            );
            healthyProxies.delete(proxyUrl);
            lastBlacklistTime.set(proxyUrl, Date.now());
            if (activeProxyUrl === proxyUrl) {
                activeProxyUrl = null;
            }
        }
    };

    const markProxySuccess = (proxyUrl: string) => {
        failureCounts.set(proxyUrl, 0);
        setActiveProxy(proxyUrl);
    };

    const ensureActiveProxy = async (
        excluded: Set<string> = new Set(),
    ): Promise<string | null> => {
        await revalidateCooldownProxies();

        if (
            activeProxyUrl && healthyProxies.has(activeProxyUrl) &&
            !excluded.has(activeProxyUrl)
        ) {
            return activeProxyUrl;
        }

        const tried = new Set<string>(excluded);
        while (tried.size < allProxyUrls.length) {
            const candidate = getNextHealthyProxy(tried);
            if (!candidate) break;
            tried.add(candidate);

            const healthy = await probeProxyHealth(candidate);
            if (healthy) {
                markProxySuccess(candidate);
                return candidate;
            }

            markProxyFailure(candidate);
            if (!healthyProxies.has(candidate)) {
                logWarn(
                    CTX.PROXY,
                    `Startup/selection probe failed: ${
                        maskProxyUrl(candidate)
                    }`,
                );
            }
        }
        return null;
    };

    const rotateActiveProxy = async (): Promise<string | null> => {
        const previous = activeProxyUrl;
        activeProxyUrl = null;
        // Exclude the proxy we were just on so we land on a different IP;
        // ensureActiveProxy health-probes the candidate before pinning it.
        const excluded = previous
            ? new Set<string>([previous])
            : new Set<string>();
        const next = await ensureActiveProxy(excluded);
        if (next) {
            logInfo(
                CTX.PROXY,
                `Rotated session egress proxy to ${maskProxyUrl(next)}`,
            );
            return next;
        }
        // No other healthy proxy (single-proxy pool, or all others
        // unhealthy): fall back to whatever is available rather than
        // leaving the session with no egress proxy.
        return await ensureActiveProxy();
    };

    const pickUnsaturatedAlternative = (
        proxyUrl: string,
        excluded: Set<string>,
    ): string => {
        // Rate-limit-aware hop: if the chosen proxy's gate is currently
        // saturated, prefer a healthy proxy that still has capacity
        // instead of queuing behind the busy one. This is what lets
        // sustained load fan out across the pool. setActiveProxy fires
        // the session swap so the new egress carries its own session.
        if (!switchProxyOnLimit || !proxyGates.get(proxyUrl)?.saturated()) {
            return proxyUrl;
        }
        const candidates = Array.from(healthyProxies).filter((p) =>
            !excluded.has(p) && !proxyGates.get(p)?.saturated()
        );
        if (candidates.length === 0) return proxyUrl;
        const alt = candidates[rrIndex % candidates.length];
        rrIndex = (rrIndex + 1) % candidates.length;
        setActiveProxy(alt);
        return alt;
    };

    const poolFetch: FetchFn = async (
        input: FetchInputParameter,
        init?: FetchInitParameterWithClient,
    ) => {
        // On a detected block, fail the current proxy over to a different
        // healthy one within the same request instead of returning the
        // blocked response. Capped so we don't burn the whole pool on one
        // request. (Player bodies are JSON strings, safe to re-send.)
        const excluded = new Set<string>();
        const maxAttempts = Math.min(Math.max(allProxyUrls.length, 1), 3);
        let lastRes: Response | undefined;
        let lastErr: unknown;
        let sawBlock = false;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const pinned = await ensureActiveProxy(excluded);
            if (!pinned) break;
            const proxyUrl = pickUnsaturatedAlternative(pinned, excluded);
            deps.getMetrics()?.proxySelections.inc();

            const client = proxyClients.get(proxyUrl)!;

            try {
                const fetchRes = await deps.fetchShim(
                    deps.config,
                    deps.retryOptions,
                    input,
                    {
                        client,
                        headers: init?.headers,
                        method: init?.method,
                        body: init?.body,
                        redirect: init?.redirect,
                        signal: init?.signal,
                        streaming: init?.streaming,
                    },
                    proxyGates.get(proxyUrl),
                );

                const isBlocked = await checkYouTubeBlock(fetchRes);

                if (isBlocked) {
                    sawBlock = true;
                    markProxyFailure(proxyUrl);
                    excluded.add(proxyUrl);
                    logWarn(
                        CTX.PROXY,
                        `Detected YouTube anti-bot response on ${
                            maskProxyUrl(proxyUrl)
                        }; failing over to another proxy.`,
                    );
                    // Discard the superseded blocked body to avoid a leak.
                    if (lastRes) {
                        await lastRes.body?.cancel().catch(() => {});
                    }
                    lastRes = fetchRes;
                    if (attempt < maxAttempts - 1) {
                        deps.getMetrics()?.proxyBlockRetries.inc();
                    }
                    continue;
                }

                markProxySuccess(proxyUrl);
                return fetchRes;
            } catch (e) {
                deps.getMetrics()?.upstreamFailures.inc();
                markProxyFailure(proxyUrl);
                excluded.add(proxyUrl);
                lastErr = e;
            }
        }

        // Exhausted attempts. A block we couldn't route around should kick
        // off a proactive session regeneration.
        if (sawBlock) deps.getOnYouTubeBlock()?.();
        if (lastRes) return lastRes;
        if (lastErr) throw lastErr;
        throw new Error(
            "All proxies in the pool are blacklisted or unhealthy. No healthy proxy available.",
        );
    };
    // ---- end of moved block ----

    return { fetch: poolFetch, ensureActiveProxy, rotateActiveProxy };
}
```

The only non-verbatim edit inside the block is `pickUnsaturatedAlternative`, which extracts the inline "rate-limit-aware hop" `if` from the request loop to keep `poolFetch` under 50 lines; its logic is unchanged.

- [ ] **Step 2: Replace the pool block in `getFetchClient.ts`**

In `src/lib/helpers/getFetchClient.ts`, replace everything from the comment `// The proxy pool is FAILOVER-ONLY, not load-balancing.` through the closing `}` of `if (proxyPool?.enabled && proxyPool.proxies.length > 0) { … }` with:

```ts
    // The proxy pool is failover-only (see proxyPool.ts). Per-proxy rate
    // gates live inside the pool, so the shared module-level gate would
    // double-count and is disabled on this path.
    const proxyPool = config.networking.proxy_pool;
    if (proxyPool?.enabled && proxyPool.proxies.length > 0) {
        if (rl?.enabled) fetchGate = undefined;
        const pool = createProxyPool({
            config,
            retryOptions,
            fetchShim,
            getMetrics: () => metricsRef,
            getOnYouTubeBlock: () => onYouTubeBlock,
            getOnActiveProxyChange: () => onActiveProxyChange,
        });
        // Expose the selector so the session bootstrap can pin to this pool's
        // active egress proxy (see getSessionEgressProxy), and the rotator so
        // the startup bootstrap can hop between PO-token attempts.
        poolActiveProxySelector = pool.ensureActiveProxy;
        rotateActiveEgressProxy = pool.rotateActiveProxy;

        cachedFetchFn = pool.fetch;
        cachedConfigRef = config;
        return pool.fetch;
    }
```

Add the import:

```ts
import { createProxyPool } from "./proxyPool.ts";
```

- [ ] **Step 3: Verify**

Run: `deno task format && deno task check && deno task lint && SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test`
Expected: all pass, `0 failed`. All of `proxy_pool_test.ts`, `proxy_pool_revalidate_test.ts`, `fetchClient_init_test.ts` and `youtubeBlock_test.ts` exercise the moved code through the unchanged `getFetchClient` exports.

Run: `wc -l src/lib/helpers/getFetchClient.ts src/lib/helpers/proxyPool.ts`
Expected: `getFetchClient.ts` ≈ 250 lines, `proxyPool.ts` ≈ 380 lines.

Run: `grep -n '^export' src/lib/helpers/getFetchClient.ts`
Expected: `getFetchClient`, `setOnYouTubeBlock`, `setOnActiveProxyChange`, `getSessionEgressProxy`, `rotateSessionEgressProxy`, plus the type re-exports and `buildFetchSignal` added in Task 9. Nothing removed.

- [ ] **Step 4: Compile check (bundling of the new modules)**

Run: `deno task compile && ./invidious_companion --help 2>&1 | head -3; rm -f invidious_companion`
Expected: the binary compiles; static imports of `proxyPool.ts`, `fetchShim.ts`, `fetchGate.ts`, `youtubeBlockDetection.ts` are bundled through the `--include ./src/lib/helpers/getFetchClient.ts` entry. (Output of `--help` is irrelevant; the point is a successful compile.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/helpers/proxyPool.ts src/lib/helpers/getFetchClient.ts
git commit -m "refactor: extract the proxy pool from getFetchClient into proxyPool.ts

getFetchClient.ts keeps the singleton, mode selection and the
single-proxy/direct paths; the failover pool (health probes, blacklist,
per-proxy gates, in-request block failover) now lives in its own module
behind createProxyPool(). Public exports are unchanged."
```

---

## Self-review

**Spec coverage.**
- B1 (timeout aborts video streams): Task 1 (`streaming` flag, `buildFetchSignal`), Task 4 (proxy passes `streaming: true`, test asserts no signal). ✔
- B2 (redirect handling): Task 3 (`resolveRedirectTarget`), Task 4 (manual loop, 400/502, tests for follow / too many / foreign host). ✔
- B3 (pool drops `redirect`/`signal`; single path signal handling): Task 2 (forwarding + test), Task 1 (`AbortSignal.any` combination + test). ✔
- B4 (403/429 always a block): Task 5. ✔
- B5 (probes inline, no single-flight): Task 6 (single-flight + 30 s interval + concurrency test). ✔
- B6 (NaN expire, enc/data forwarded): Task 3 (`isValidExpire`), Task 4 (delete `enc`/`data`, tests). ✔
- B7 (split the file; exports unchanged): Tasks 7–10. Export list verified in Task 10 Step 3. ✔
- Not covered on purpose: a header-phase timeout for streaming requests (spec B1 says "may remain"; documented as a follow-up in the `streaming` doc comment).

**Placeholder scan.** No TBD/TODO; every code step has full code; every test step has full test code; run commands have expected outcomes.

**Type consistency.**
- `FetchInitParameterWithClient` gains `client?` and `streaming?` in Task 1; the same definition is moved to `fetchShim.ts` in Task 9; `proxyPool.ts` (Task 10) imports it from there. ✔
- `buildFetchSignal(timeoutMs, callerSignal, streaming)` signature identical in Tasks 1 and 9; test import path updated in Task 9 Step 3. ✔
- `fetchShim` call sites keep the 5-argument form `(config, retryOptions, input, init, gate?)` via the adapter in Task 9; `ProxyPoolDeps.fetchShim` in Task 10 has that same 5-argument type. ✔
- `checkYouTubeBlock` / `maskProxyUrl` names unchanged across Tasks 5, 8, 10. ✔
- `resolveRedirectTarget`, `isGooglevideoHost`, `isValidExpire` (Task 3) match their uses in Task 4. ✔
- `ProxyPool.rotateActiveProxy` (Task 10) is assigned to the pre-existing module variable `rotateActiveEgressProxy`, whose type `(() => Promise<string | null>) | null` matches. ✔
- Task 5's test uses the single-proxy path (which calls `checkYouTubeBlock`), not the direct path; the note in Step 1 explains why. ✔
