# Session Lifecycle Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the YouTube session / PO-token worker lifecycle race-free and self-healing: workers are terminated by identity, generations never overlap, worker crashes and hangs are surfaced, and readiness reflects real mint health.

**Architecture:** Session state (in-flight guard, pending trigger, readiness flags, timestamps, per-proxy session cache) moves out of `src/main.ts` into a testable `SessionLifecycle` class in `src/lib/session/sessionLifecycle.ts`. Worker ownership moves into `src/lib/session/workerRegistry.ts`, which terminates only workers no cached session references. `poTokenGenerate` gets a worker `error` listener, a bounded generation timeout, an injectable worker factory (for tests), and returns the worker plus the egress proxy it was pinned to. `main.ts` keeps `sharedState` and wires callbacks/cron/shutdown to the lifecycle.

**Tech Stack:** Deno 2.9, TypeScript, Hono, youtubei.js v18, prom-client, `@std/async`, `@std/assert` (tests).

**Spec:** `docs/superpowers/specs/2026-09-16-code-review-findings.md`, section A (A1–A7).

## Global Constraints

- Runtime: Deno 2.9.x (Docker), `deno.json` tasks are the single source of truth for permission flags. Formatter indent width is **4**.
- Every change must pass `deno task format`, `deno task check`, `deno task lint` and `deno task test` (`SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa`).
- The Invidious ↔ companion contract (routes, query names, status codes, response bodies, `check`/`enc`/`data` wire format) must not change unless the finding says so explicitly; then `../invidious/` must be updated in lockstep.
- Logging goes through `logInfo/logWarn/logError/logDebug(CTX.X, msg)` from `src/lib/helpers/log.ts`. No bare `console.*` in `src/` outside `log.ts`.
- Immutability preferred; no mutation of shared objects outside `sharedState`.
- Files ≤ 800 lines, functions ≤ 50 lines where reasonably achievable.
- Tests: pure-unit tests must not need network. Integration tests live behind `main_test.ts`. Test names describe behaviour.
- Commit format: `<type>: <description>` (feat, fix, refactor, docs, test, chore, perf, ci). Attribution trailers as configured for the session.

**Plan-specific notes**

- Run a single test file with `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/<file>` (the task accepts extra args).
- `main_test.ts` boots the real server and hits YouTube; run it at the end of Tasks 5 and 7 as the integration gate.
- `readiness_test.ts` currently passes a config of `{ server: {} }`; the readiness change in Task 6 must keep that test green.
- `../invidious/` is not touched by this plan (no contract change).

---

## File map

| Path | Responsibility |
|---|---|
| `src/lib/session/workerRegistry.ts` (new) | Owns the set of live PO-token workers; terminate by identity; `cleanupWorkers()` for shutdown. |
| `src/lib/session/sessionLifecycle.ts` (new) | `SessionLifecycle` class: regen guard + coalescing, bootstrap guard, readiness flags, timestamps, per-proxy session cache, block cooldown, minter wrapping for `lastMintOkMs`. |
| `src/lib/helpers/pendingWrites.ts` (new) | Tracks fire-and-forget KV writes so shutdown can await them. |
| `src/lib/jobs/potoken.ts` (modify) | Worker error/timeout handling, injectable worker factory, returns `worker` + `egressProxyUrl`, mint metrics, serving-client options (gl/hl/UA/cache). Re-exports `cleanupWorkers`. |
| `src/lib/jobs/worker.ts` (modify) | `getFetchClient(...)` moved inside the `try`. |
| `src/lib/helpers/metrics.ts` (modify) | `mintTimeouts`, `mintFailures`, `sessionRegenDropped` counters. |
| `src/lib/helpers/youtubePlayerHandling.ts` (modify) | Cache-write IIFEs tracked via `trackPendingWrite`. |
| `src/lib/types/HonoVariables.ts` (modify) | `lastMintOkMs?: number`. |
| `src/routes/readiness.ts` (modify) | `token_mint_fresh` check. |
| `src/main.ts` (modify) | Uses `SessionLifecycle`; cron gated; shutdown order fixed. |
| `src/tests/helpers/fakeWorker.ts` (new) | `FakeWorker` test double. |
| `src/tests/workerRegistry_test.ts`, `sessionLifecycle_test.ts`, `potoken_test.ts`, `pendingWrites_test.ts` (new); `shutdown_test.ts`, `metrics_test.ts`, `readiness_test.ts` (modify) | Unit coverage. |

---

### Task 1: Worker registry with identity-based termination

**Files:**
- Create: `src/lib/session/workerRegistry.ts`
- Create: `src/tests/helpers/fakeWorker.ts`
- Create: `src/tests/workerRegistry_test.ts`
- Modify: `src/tests/shutdown_test.ts` (replace the tautological test)

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `interface TerminableWorker { terminate(): void }`
  - `registerWorker(worker: TerminableWorker): void`
  - `releaseWorker(worker: TerminableWorker): void` — terminates and forgets one worker (no-op if unknown).
  - `terminateUnreferenced(keep: ReadonlySet<TerminableWorker>): number` — terminates every registered worker not in `keep`, returns the number terminated.
  - `registeredWorkerCount(): number`
  - `cleanupWorkers(): void` — terminates all (shutdown).
  - Test double: `class FakeWorker extends EventTarget` with `terminated: boolean`, `posted: unknown[]`, `postMessage(m)`, `terminate()`, `emit(data)`, `emitError(message)`.

- [ ] **Step 1: Create the fake worker test helper**

```ts
// src/tests/helpers/fakeWorker.ts
/**
 * Minimal stand-in for a Web Worker: records posted messages, lets a test
 * emit "message" / "error" events, and remembers whether it was terminated.
 */
export class FakeWorker extends EventTarget {
    public terminated = false;
    public readonly posted: unknown[] = [];

    postMessage(message: unknown): void {
        this.posted.push(message);
    }

    terminate(): void {
        this.terminated = true;
    }

    emit(data: unknown): void {
        this.dispatchEvent(new MessageEvent("message", { data }));
    }

    emitError(message: string): void {
        this.dispatchEvent(new ErrorEvent("error", { message }));
    }
}
```

- [ ] **Step 2: Write the failing registry tests**

```ts
// src/tests/workerRegistry_test.ts
import { assertEquals } from "./deps.ts";
import {
    cleanupWorkers,
    registeredWorkerCount,
    registerWorker,
    releaseWorker,
    terminateUnreferenced,
} from "../lib/session/workerRegistry.ts";
import { FakeWorker } from "./helpers/fakeWorker.ts";

Deno.test("workerRegistry", async (t) => {
    await t.step("cleanupWorkers does not throw with no workers", () => {
        cleanupWorkers();
        assertEquals(registeredWorkerCount(), 0);
    });

    await t.step("terminateUnreferenced keeps referenced workers alive", () => {
        const a = new FakeWorker();
        const b = new FakeWorker();
        registerWorker(a);
        registerWorker(b);

        const terminated = terminateUnreferenced(new Set([a]));

        assertEquals(terminated, 1);
        assertEquals(a.terminated, false);
        assertEquals(b.terminated, true);
        assertEquals(registeredWorkerCount(), 1);
        cleanupWorkers();
    });

    await t.step("releaseWorker terminates exactly that worker", () => {
        const a = new FakeWorker();
        const b = new FakeWorker();
        registerWorker(a);
        registerWorker(b);

        releaseWorker(a);

        assertEquals(a.terminated, true);
        assertEquals(b.terminated, false);
        assertEquals(registeredWorkerCount(), 1);
        cleanupWorkers();
    });

    await t.step("releaseWorker ignores unknown workers", () => {
        const stranger = new FakeWorker();
        releaseWorker(stranger);
        assertEquals(stranger.terminated, false);
    });

    await t.step("cleanupWorkers terminates every registered worker", () => {
        const a = new FakeWorker();
        const b = new FakeWorker();
        registerWorker(a);
        registerWorker(b);

        cleanupWorkers();

        assertEquals(a.terminated, true);
        assertEquals(b.terminated, true);
        assertEquals(registeredWorkerCount(), 0);
    });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/workerRegistry_test.ts`
Expected: FAIL with `Module not found "file:///.../src/lib/session/workerRegistry.ts"`.

- [ ] **Step 4: Implement the registry**

```ts
// src/lib/session/workerRegistry.ts
import { CTX, logError, logInfo } from "../helpers/log.ts";

/** The only capability the registry needs from a worker. */
export interface TerminableWorker {
    terminate(): void;
}

// Live PO-token workers. A Set (not an array) so termination is by identity,
// never by position: the "kill everything but the newest" loop this replaces
// assumed the completing worker was the last one pushed, which is false as
// soon as two generations overlap.
const registered = new Set<TerminableWorker>();

function safeTerminate(worker: TerminableWorker): void {
    try {
        worker.terminate();
    } catch (err) {
        logError(CTX.PO_TOKEN, "Failed to terminate worker", err);
    }
}

export function registerWorker(worker: TerminableWorker): void {
    registered.add(worker);
}

/** Terminate and forget one worker. No-op for unknown workers. */
export function releaseWorker(worker: TerminableWorker): void {
    if (!registered.delete(worker)) return;
    safeTerminate(worker);
}

/**
 * Terminate every registered worker that is not in `keep`. Called after a
 * session is adopted with the set of workers still referenced by the current
 * session and any cached per-proxy sessions.
 */
export function terminateUnreferenced(
    keep: ReadonlySet<TerminableWorker>,
): number {
    let terminated = 0;
    for (const worker of registered) {
        if (keep.has(worker)) continue;
        releaseWorker(worker);
        terminated++;
    }
    return terminated;
}

export function registeredWorkerCount(): number {
    return registered.size;
}

/** Shutdown: terminate everything. */
export function cleanupWorkers(): void {
    if (registered.size === 0) return;
    logInfo(
        CTX.PO_TOKEN,
        `Cleaning up ${registered.size} worker(s) for shutdown`,
    );
    for (const worker of registered) {
        releaseWorker(worker);
    }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/workerRegistry_test.ts`
Expected: `ok | 1 passed (5 steps) | 0 failed`.

- [ ] **Step 6: Replace the tautological shutdown test**

Overwrite `src/tests/shutdown_test.ts` with:

```ts
import { assertEquals } from "./deps.ts";
import {
    cleanupWorkers,
    registeredWorkerCount,
    registerWorker,
} from "../lib/session/workerRegistry.ts";
import { FakeWorker } from "./helpers/fakeWorker.ts";

Deno.test("cleanupWorkers terminates a registered worker and empties the registry", () => {
    const worker = new FakeWorker();
    registerWorker(worker);

    cleanupWorkers();

    assertEquals(worker.terminated, true);
    assertEquals(registeredWorkerCount(), 0);
});
```

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/shutdown_test.ts`
Expected: `ok | 1 passed | 0 failed`.

- [ ] **Step 7: Format, lint, commit**

```bash
deno fmt src/lib/session/workerRegistry.ts src/tests/helpers/fakeWorker.ts src/tests/workerRegistry_test.ts src/tests/shutdown_test.ts
deno task lint
git add src/lib/session/workerRegistry.ts src/tests/helpers/fakeWorker.ts src/tests/workerRegistry_test.ts src/tests/shutdown_test.ts
git commit -m "feat: add identity-based PO-token worker registry"
```

---

### Task 2: Mint and regeneration metrics

**Files:**
- Modify: `src/lib/helpers/metrics.ts:134-142`
- Modify: `src/tests/metrics_test.ts:73-97`

**Interfaces:**
- Produces on `Metrics`: `mintTimeouts: Counter`, `mintFailures: Counter`, `sessionRegenDropped: Counter` (registered as `invidious_companion_mint_timeouts_total`, `invidious_companion_mint_failures_total`, `invidious_companion_session_regen_dropped_total`).

- [ ] **Step 1: Extend the registry test**

In `src/tests/metrics_test.ts`, extend `expectedNewMetrics` (the array in the third test) so it reads:

```ts
    const expectedNewMetrics = [
        "invidious_companion_graceful_shutdowns_total",
        "invidious_companion_video_playback_requests_total",
        "invidious_companion_potoken_generation_success_total",
        "invidious_companion_upstream_failures_total",
        "invidious_companion_upstream_retries_total",
        "invidious_companion_proxy_selections_total",
        "invidious_companion_proxy_blacklists_total",
        "invidious_companion_proxy_recoveries_total",
        "invidious_companion_request_latency_seconds",
        "invidious_companion_mint_timeouts_total",
        "invidious_companion_mint_failures_total",
        "invidious_companion_session_regen_dropped_total",
    ];
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/metrics_test.ts`
Expected: FAIL with `Expected metric invidious_companion_mint_timeouts_total not found in registry`.

- [ ] **Step 3: Add the counters**

In `src/lib/helpers/metrics.ts`, directly after the `blockTriggeredRegens` counter (before `requestLatency`), add:

```ts
    public mintTimeouts = this.createCounter(
        "mint_timeouts_total",
        "Number of per-video content-token mints that hit the mint timeout",
    );

    public mintFailures = this.createCounter(
        "mint_failures_total",
        "Number of per-video content-token mints the worker reported as failed",
    );

    public sessionRegenDropped = this.createCounter(
        "session_regen_dropped_total",
        "Number of session regeneration triggers coalesced into an already in-flight regeneration",
    );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/metrics_test.ts`
Expected: `ok | 3 passed | 0 failed`.

- [ ] **Step 5: Commit**

```bash
deno fmt src/lib/helpers/metrics.ts src/tests/metrics_test.ts
git add src/lib/helpers/metrics.ts src/tests/metrics_test.ts
git commit -m "feat: add mint timeout/failure and regen-dropped metrics"
```

---

### Task 3: Robust `poTokenGenerate` (worker error listener, timeout, identity, egress proxy, serving-client options)

Covers A1 (registry instead of positional kill), A3 (error listener, worker try, generation timeout), A4 (serving client options), A5 (return pinned egress proxy), A7 (mint metrics).

**Files:**
- Modify: `src/lib/jobs/potoken.ts` (whole `poTokenGenerate`, `createMinter`, imports, exports)
- Modify: `src/lib/jobs/worker.ts:96-98`
- Create: `src/tests/potoken_test.ts`

**Interfaces:**
- Consumes: `registerWorker`, `releaseWorker` from Task 1; `Metrics.mintTimeouts`, `Metrics.mintFailures` from Task 2.
- Produces:
  - `interface TokenGeneratorWorker` (message/error/messageerror listeners, `postMessage(InputMessage)`, `terminate()`).
  - `interface PoTokenGenerateOptions { timeoutMs?: number; createWorker?: () => TokenGeneratorWorker; cache?: UniversalCache }`
  - `interface GeneratedPoTokenSession { innertubeClient: Innertube; tokenMinter: TokenMinter; worker: TokenGeneratorWorker; egressProxyUrl: string | null; sessionTtlSecs?: number }`
  - `poTokenGenerate(config: Config, metrics: Metrics | undefined, options?: PoTokenGenerateOptions): Promise<GeneratedPoTokenSession>`
  - `createMinter(worker: TokenGeneratorWorker, metrics: Metrics | undefined, timeoutMs?: number): TokenMinter` (exported for tests)
  - `export { cleanupWorkers }` re-exported from the registry (keeps `main.ts` import working).

- [ ] **Step 1: Write the failing tests**

```ts
// src/tests/potoken_test.ts
Deno.env.set("SERVER_SECRET_KEY", "aaaaaaaaaaaaaaaa");

import { assertEquals, assertRejects } from "./deps.ts";
import { createMinter, poTokenGenerate } from "../lib/jobs/potoken.ts";
import { registeredWorkerCount } from "../lib/session/workerRegistry.ts";
import { parseConfig } from "../lib/helpers/config.ts";
import { Metrics } from "../lib/helpers/metrics.ts";
import { FakeWorker } from "./helpers/fakeWorker.ts";

async function counterValue(
    counter: { get(): Promise<{ values: { value: number }[] }> },
): Promise<number> {
    return (await counter.get()).values[0]?.value ?? 0;
}

Deno.test("poTokenGenerate", async (t) => {
    const config = await parseConfig();

    await t.step("posts initialise once the worker reports ready", async () => {
        const worker = new FakeWorker();
        const pending = poTokenGenerate(config, undefined, {
            createWorker: () => worker,
            timeoutMs: 200,
        });

        worker.emit({ type: "ready" });
        // Let the async message listener run.
        await new Promise((resolve) => setTimeout(resolve, 0));

        assertEquals(worker.posted.length, 1);
        assertEquals(
            (worker.posted[0] as { type: string }).type,
            "initialise",
        );
        // Never initialised → the generation timeout settles the promise.
        await assertRejects(() => pending, Error, "timed out");
        assertEquals(worker.terminated, true);
    });

    await t.step("rejects and terminates the worker on a worker error event", async () => {
        const worker = new FakeWorker();
        const pending = poTokenGenerate(config, undefined, {
            createWorker: () => worker,
            timeoutMs: 5_000,
        });

        worker.emitError("boom");

        await assertRejects(() => pending, Error, "boom");
        assertEquals(worker.terminated, true);
        assertEquals(registeredWorkerCount(), 0);
    });

    await t.step("rejects on a fatal error message without requestId", async () => {
        const worker = new FakeWorker();
        const pending = poTokenGenerate(config, undefined, {
            createWorker: () => worker,
            timeoutMs: 5_000,
        });

        worker.emit({ type: "error", error: "attestation failed" });

        await assertRejects(() => pending, Error, "attestation failed");
        assertEquals(worker.terminated, true);
    });

    await t.step("rejects when generation exceeds the timeout", async () => {
        const worker = new FakeWorker();
        const pending = poTokenGenerate(config, undefined, {
            createWorker: () => worker,
            timeoutMs: 20,
        });

        await assertRejects(() => pending, Error, "timed out after 20ms");
        assertEquals(worker.terminated, true);
    });
});

Deno.test("createMinter", async (t) => {
    await t.step("resolves with the content token for the matching requestId", async () => {
        const worker = new FakeWorker();
        const minter = createMinter(worker, undefined, 1_000);

        const pending = minter("dQw4w9WgXcQ");
        const request = worker.posted[0] as { requestId: string };
        worker.emit({
            type: "content-token",
            contentToken: "tok",
            requestId: request.requestId,
        });

        assertEquals(await pending, "tok");
    });

    await t.step("counts a mint timeout and rejects", async () => {
        const worker = new FakeWorker();
        const metrics = new Metrics();
        const minter = createMinter(worker, metrics, 10);

        await assertRejects(() => minter("dQw4w9WgXcQ"), Error, "timed out");
        assertEquals(await counterValue(metrics.mintTimeouts), 1);
    });

    await t.step("counts a worker-reported mint failure and rejects", async () => {
        const worker = new FakeWorker();
        const metrics = new Metrics();
        const minter = createMinter(worker, metrics, 1_000);

        const pending = minter("dQw4w9WgXcQ");
        const request = worker.posted[0] as { requestId: string };
        worker.emit({
            type: "error",
            error: "minter not ready",
            requestId: request.requestId,
        });

        await assertRejects(() => pending, Error, "minter not ready");
        assertEquals(await counterValue(metrics.mintFailures), 1);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/potoken_test.ts`
Expected: FAIL at type-check: `Module '"../lib/jobs/potoken.ts"' has no exported member 'createMinter'`.

- [ ] **Step 3: Rewrite the top of `potoken.ts` (imports, types, `createMinter`)**

Replace lines 1–82 of `src/lib/jobs/potoken.ts` (everything up to and including `export type TokenMinter = ...`) with:

```ts
import { Innertube, type UniversalCache } from "youtubei.js";
import { USER_AGENT } from "bgutils";
import {
    youtubePlayerParsing,
    youtubeVideoInfo,
} from "../helpers/youtubePlayerHandling.ts";
import type { Config } from "../helpers/config.ts";
import { Metrics } from "../helpers/metrics.ts";
import { CTX, logError, logInfo, logWarn } from "../helpers/log.ts";
import { resolveAndValidateFetchClientLocation } from "../helpers/dynamicImportValidation.ts";
import { registerWorker, releaseWorker } from "../session/workerRegistry.ts";

// Kept as a re-export so existing importers (main.ts, tests) keep working.
export { cleanupWorkers } from "../session/workerRegistry.ts";

const getFetchClientLocation = resolveAndValidateFetchClientLocation();
const { getFetchClient, getSessionEgressProxy } = await import(
    getFetchClientLocation
);

import { InputMessage, OutputMessageSchema } from "./worker.ts";

/**
 * The slice of the Worker API the generator uses. A structural interface so
 * tests can inject a fake instead of spawning worker.ts (which needs jsdom,
 * BotGuard and the network).
 */
export interface TokenGeneratorWorker {
    addEventListener(
        type: "message" | "messageerror",
        listener: (event: MessageEvent) => void,
    ): void;
    addEventListener(
        type: "error",
        listener: (event: ErrorEvent) => void,
    ): void;
    removeEventListener(
        type: "message",
        listener: (event: MessageEvent) => void,
    ): void;
    postMessage(message: InputMessage): void;
    terminate(): void;
}

// Upper bound on how long a single content-token mint may take. Without it, a
// worker that dies or stalls leaves the mint promise pending forever — and
// with request single-flighting that hung promise poisons the videoId for all
// later callers until restart.
const MINT_TIMEOUT_MS = 10_000;

// Upper bound for a whole session generation (worker boot, BotGuard
// attestation, integrity token, validation). A worker that never reports
// "initialised" would otherwise leave the caller's in-flight guard set
// forever and silently disable every later regeneration.
const GENERATION_TIMEOUT_MS = 120_000;

export function createMinter(
    worker: TokenGeneratorWorker,
    metrics: Metrics | undefined,
    timeoutMs: number = MINT_TIMEOUT_MS,
) {
    return (videoId: string): Promise<string> => {
        const { promise, resolve, reject } = Promise.withResolvers<string>();
        const requestId = crypto.randomUUID();

        const cleanup = () => {
            worker.removeEventListener("message", listener);
            clearTimeout(timer);
        };

        const listener = (message: MessageEvent) => {
            // Ignore messages that don't match the schema instead of throwing
            // inside the event listener; the mint timeout covers the case
            // where the expected reply never arrives in a valid shape.
            const parsed = OutputMessageSchema.safeParse(message.data);
            if (!parsed.success) return;
            const parsedMessage = parsed.data;
            if (
                parsedMessage.type === "content-token" &&
                parsedMessage.requestId === requestId
            ) {
                cleanup();
                resolve(parsedMessage.contentToken);
            } else if (
                parsedMessage.type === "error" &&
                parsedMessage.requestId === requestId
            ) {
                cleanup();
                metrics?.mintFailures.inc();
                reject(new Error(String(parsedMessage.error)));
            }
        };

        const timer = setTimeout(() => {
            cleanup();
            metrics?.mintTimeouts.inc();
            reject(
                new Error(
                    `Content-token mint timed out after ${timeoutMs}ms for ${videoId}`,
                ),
            );
        }, timeoutMs);

        worker.addEventListener("message", listener);
        worker.postMessage({
            type: "content-token-request",
            videoId,
            requestId,
        });

        return promise;
    };
}

export type TokenMinter = ReturnType<typeof createMinter>;

export interface PoTokenGenerateOptions {
    /** Overall generation timeout. Defaults to GENERATION_TIMEOUT_MS. */
    timeoutMs?: number;
    /** Test seam: supply a fake worker instead of spawning worker.ts. */
    createWorker?: () => TokenGeneratorWorker;
    /** Shared youtubei.js cache so the serving client reuses parsed player JS. */
    cache?: UniversalCache;
}

export interface GeneratedPoTokenSession {
    innertubeClient: Innertube;
    tokenMinter: TokenMinter;
    /** The worker that owns this session's minter. Terminated via the registry. */
    worker: TokenGeneratorWorker;
    /** Egress proxy the attestation was pinned to (null: direct / IPv6). */
    egressProxyUrl: string | null;
    // YouTube's estimated integrity-token TTL (seconds), forwarded from the
    // worker so the caller can refresh the session before it expires.
    sessionTtlSecs?: number;
}

const defaultCreateWorker = (): TokenGeneratorWorker =>
    new Worker(
        new URL("./worker.ts", import.meta.url).href,
        {
            type: "module",
            name: "PO Token Generator",
        },
    );
```

- [ ] **Step 4: Rewrite `poTokenGenerate`**

Replace the old `// Adapted from ...` comment through the end of `poTokenGenerate` (the block ending with `return promise;\n};`) with:

```ts
// Adapted from https://github.com/LuanRT/BgUtils/blob/main/examples/node/index.ts
export const poTokenGenerate = (
    config: Config,
    metrics: Metrics | undefined,
    options: PoTokenGenerateOptions = {},
): Promise<GeneratedPoTokenSession> => {
    const { promise, resolve, reject } = Promise.withResolvers<
        GeneratedPoTokenSession
    >();
    const timeoutMs = options.timeoutMs ?? GENERATION_TIMEOUT_MS;
    const worker = (options.createWorker ?? defaultCreateWorker)();
    registerWorker(worker);

    // Exactly one of fail/succeed settles the promise. fail() also releases
    // the worker; succeed() leaves it alive because the minter posts to it.
    let settled = false;
    let generationTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        if (generationTimer !== undefined) clearTimeout(generationTimer);
        releaseWorker(worker);
        reject(err instanceof Error ? err : new Error(String(err)));
    };
    const succeed = (session: GeneratedPoTokenSession): void => {
        if (settled) return;
        settled = true;
        if (generationTimer !== undefined) clearTimeout(generationTimer);
        resolve(session);
    };

    generationTimer = setTimeout(() => {
        fail(new Error(`PO-token generation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // A worker-level failure (module load error, an exception outside the
    // worker's own try/catch) surfaces here, not as a message. Without this
    // listener it would either crash the process or leave us pending forever.
    worker.addEventListener("error", (event) => {
        event.preventDefault();
        logError(CTX.PO_TOKEN, `Worker crashed: ${event.message}`);
        fail(new Error(`PO-token worker crashed: ${event.message}`));
    });
    worker.addEventListener("messageerror", () => {
        fail(new Error("PO-token worker sent an unserialisable message"));
    });

    // Egress proxy the attestation is pinned to; the caller keys its per-proxy
    // session cache on this instead of re-resolving it after the fact.
    let egressProxyUrl: string | null = config.networking.proxy ?? null;

    worker.addEventListener("message", async (event) => {
        const parsed = OutputMessageSchema.safeParse(event.data);
        if (!parsed.success) {
            logError(
                CTX.PO_TOKEN,
                `Malformed message from worker: ${parsed.error}`,
            );
            fail(
                new Error(
                    `Malformed message from PO-token worker: ${parsed.error}`,
                ),
            );
            return;
        }
        const parsedMessage = parsed.data;

        if (parsedMessage.type === "ready") {
            worker.postMessage({
                type: "initialise",
                config: await pinWorkerConfig(config, (proxy) => {
                    egressProxyUrl = proxy;
                }),
            });
        }

        // Only fatal setup/initialise errors (no requestId) tear down the
        // worker. Per-request mint errors carry a requestId and are handled by
        // the dedicated listener in createMinter, so they must not kill the
        // whole session here.
        if (parsedMessage.type === "error" && !parsedMessage.requestId) {
            logError(CTX.PO_TOKEN, `Worker error: ${parsedMessage.error}`);
            fail(parsedMessage.error);
        }

        if (parsedMessage.type === "initialised") {
            try {
                const instantiatedInnertubeClient = await Innertube.create({
                    enable_session_cache: false,
                    po_token: parsedMessage.sessionPoToken,
                    visitor_data: parsedMessage.visitorData,
                    fetch: getFetchClient(config),
                    generate_session_locally: true,
                    cookie: config.youtube_session.cookies || undefined,
                    player_id: config.youtube_session.player_id,
                    // Same UA/locale the worker attested under, and the shared
                    // cache so the player JS is not re-fetched per regen.
                    user_agent: USER_AGENT,
                    location: config.youtube_session.gl || undefined,
                    lang: config.youtube_session.hl || undefined,
                    cache: options.cache,
                });
                const minter = createMinter(worker, metrics);
                await checkToken({
                    instantiatedInnertubeClient,
                    config,
                    integrityTokenBasedMinter: minter,
                    metrics,
                });
                logInfo(CTX.PO_TOKEN, "Successfully generated");
                metrics?.poTokenGenerationSuccess.inc();
                succeed({
                    innertubeClient: instantiatedInnertubeClient,
                    tokenMinter: minter,
                    worker,
                    egressProxyUrl,
                    sessionTtlSecs: parsedMessage.estimatedTtlSecs,
                });
            } catch (err) {
                logWarn(
                    CTX.PO_TOKEN,
                    `Failed to get valid token, will retry: ${err}`,
                );
                fail(err);
            }
        }
    });

    return promise;
};

/**
 * Pin the worker's BotGuard attestation to the same egress proxy the request
 * path will use, so the visitor_data / PO token are minted from the IP that
 * later presents them. Only the failover proxy pool needs this; single-proxy
 * and direct are already consistent and IPv6 rotation is per-request by
 * design. Reports the chosen proxy through `onPinned`.
 */
async function pinWorkerConfig(
    config: Config,
    onPinned: (proxyUrl: string) => void,
): Promise<Config> {
    const pool = config.networking.proxy_pool;
    if (!pool.enabled || pool.proxies.length === 0) return config;
    try {
        const sessionProxy = await getSessionEgressProxy(config);
        if (!sessionProxy) return config;
        onPinned(sessionProxy);
        return {
            ...config,
            networking: {
                ...config.networking,
                proxy: sessionProxy,
                proxy_pool: { ...pool, enabled: false },
            },
        };
    } catch (err) {
        logWarn(CTX.PO_TOKEN, `Could not pin session egress proxy: ${err}`);
        return config;
    }
}
```

Then delete the old `export function cleanupWorkers(): void { ... }` at the bottom of the file (it is now re-exported from the registry) and the old `const workers: TokenGeneratorWorker[] = [];` line if still present.

- [ ] **Step 5: Move `getFetchClient` inside the worker's `try`**

In `src/lib/jobs/worker.ts`, change the `initialise` branch so the fetch client is created inside the `try`:

```ts
        if (message.type === "initialise") {
            try {
                const fetchImpl: typeof fetch = getFetchClient(message.config);
                const {
                    sessionPoToken,
                    visitorData,
                    generatedMinter,
                    estimatedTtlSecs,
                } = await setup({
                    fetchImpl,
                    innertubeClientCookies:
                        message.config.youtube_session.cookies,
                    player_id: message.config.youtube_session.player_id,
                    gl: message.config.youtube_session.gl,
                    hl: message.config.youtube_session.hl,
                });
                minter = generatedMinter;
                postMessage({
                    type: "initialised",
                    sessionPoToken,
                    visitorData,
                    estimatedTtlSecs,
                });
            } catch (err) {
                postMessage({ type: "error", error: String(err) });
            }
        }
```

(Note `error: String(err)` — an `Error` object is not structured-cloneable across the worker boundary in every case; the parent only ever stringifies it.)

- [ ] **Step 6: Type-check and run the tests**

Run: `deno task check`
Expected: no errors. If `deno check` reports that `Worker` is not assignable to `TokenGeneratorWorker` in `defaultCreateWorker`, change its body to `new Worker(...) as unknown as TokenGeneratorWorker` (the runtime object has every listed member).

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/potoken_test.ts`
Expected: `ok | 2 passed (7 steps) | 0 failed`.

- [ ] **Step 7: Format, lint, commit**

```bash
deno fmt src/lib/jobs/potoken.ts src/lib/jobs/worker.ts src/tests/potoken_test.ts
deno task lint
git add src/lib/jobs/potoken.ts src/lib/jobs/worker.ts src/tests/potoken_test.ts
git commit -m "fix: surface PO-token worker crashes, bound generation time, terminate workers by identity"
```

`main.ts` still compiles at this point because it only reads `innertubeClient`, `tokenMinter`, `sessionTtlSecs` from the result and imports `cleanupWorkers` (re-exported).

---

### Task 4: `SessionLifecycle` class

Covers A1 (bootstrap holds the guard), A2 (per-proxy sessions own their workers), A5 (coalesced triggers, cache key from pinned proxy), A7 (`lastMintOkMs`).

**Files:**
- Create: `src/lib/session/sessionLifecycle.ts`
- Create: `src/tests/sessionLifecycle_test.ts`

**Interfaces:**
- Consumes: `terminateUnreferenced` (Task 1); `TokenMinter`, `TokenGeneratorWorker` (Task 3); `Metrics.sessionRegenDropped`, `Metrics.potokenGenerationFailure`, `Metrics.blockTriggeredRegens`.
- Produces:
  - `interface GeneratedSession { innertubeClient: Innertube; tokenMinter: TokenMinter | undefined; worker: TokenGeneratorWorker | undefined; egressProxyUrl: string | null; sessionTtlSecs?: number }` (a `GeneratedPoTokenSession` is assignable to it).
  - `interface SessionLifecycleDeps { config: Config; metrics: Metrics | undefined; generate: (reason: string) => Promise<GeneratedSession>; install: (client: Innertube, minter: TokenMinter | undefined) => void; now?: () => number }`
  - `class SessionLifecycle` with:
    - getters `initialSessionReady: boolean`, `sessionGeneratedAtMs: number`, `lastMintOkMs: number`, `regenerationInFlight: boolean`
    - `effectiveSessionLifetimeMs(): number`
    - `isSessionFresh(): boolean`
    - `adopt(session: GeneratedSession): void`
    - `regenerate(reason: string): Promise<void>`
    - `bootstrap(run: () => Promise<GeneratedSession>): Promise<void>`
    - `switchToProxy(proxyUrl: string): "reused" | "regenerating" | "ignored"`
    - `onBlockDetected(): boolean`
    - `evictExpiredProxySessions(): number`

- [ ] **Step 1: Write the failing tests**

```ts
// src/tests/sessionLifecycle_test.ts
import { assertEquals } from "./deps.ts";
import { delay } from "@std/async";
import type { Innertube } from "youtubei.js";
import type { Config } from "../lib/helpers/config.ts";
import { Metrics } from "../lib/helpers/metrics.ts";
import {
    type GeneratedSession,
    SessionLifecycle,
} from "../lib/session/sessionLifecycle.ts";
import {
    cleanupWorkers,
    registerWorker,
} from "../lib/session/workerRegistry.ts";
import { FakeWorker } from "./helpers/fakeWorker.ts";

const HOUR_MS = 60 * 60 * 1000;

function makeConfig(
    overrides: { perProxy?: boolean; lifetimeHours?: number } = {},
): Config {
    return {
        jobs: {
            youtube_session: {
                session_lifetime_hours: overrides.lifetimeHours ?? 6,
            },
        },
        networking: {
            proxy_pool: {
                enabled: overrides.perProxy ?? false,
                switch_proxy_on_limit: overrides.perProxy ?? false,
            },
        },
    } as unknown as Config;
}

type TestSession = GeneratedSession & { worker: FakeWorker };

function makeSession(egressProxyUrl: string | null = null): TestSession {
    const worker = new FakeWorker();
    registerWorker(worker);
    return {
        innertubeClient: { id: crypto.randomUUID() } as unknown as Innertube,
        tokenMinter: () => Promise.resolve("token"),
        worker,
        egressProxyUrl,
    };
}

async function counterValue(
    counter: { get(): Promise<{ values: { value: number }[] }> },
): Promise<number> {
    return (await counter.get()).values[0]?.value ?? 0;
}

interface Harness {
    lifecycle: SessionLifecycle;
    installed: { client: Innertube; minter: unknown }[];
    calls: string[];
    clock: { now: number };
    metrics: Metrics;
}

function harness(
    config: Config,
    generate?: (reason: string) => Promise<GeneratedSession>,
): Harness {
    const installed: Harness["installed"] = [];
    const calls: string[] = [];
    const clock = { now: 1_000_000 };
    const metrics = new Metrics();
    const lifecycle = new SessionLifecycle({
        config,
        metrics,
        now: () => clock.now,
        install: (client, minter) => {
            installed.push({ client, minter });
        },
        generate: (reason) => {
            calls.push(reason);
            return generate
                ? generate(reason)
                : Promise.resolve(makeSession());
        },
    });
    return { lifecycle, installed, calls, clock, metrics };
}

Deno.test("SessionLifecycle", async (t) => {
    await t.step("adopt installs the session and marks it ready", () => {
        const h = harness(makeConfig());
        const session = makeSession();

        h.lifecycle.adopt(session);

        assertEquals(h.installed.length, 1);
        assertEquals(h.installed[0].client, session.innertubeClient);
        assertEquals(h.lifecycle.initialSessionReady, true);
        assertEquals(h.lifecycle.sessionGeneratedAtMs, h.clock.now);
        assertEquals(h.lifecycle.lastMintOkMs, h.clock.now);
        assertEquals(h.lifecycle.isSessionFresh(), true);
        cleanupWorkers();
    });

    await t.step("adopt terminates the previous worker when per-proxy sessions are off", () => {
        const h = harness(makeConfig());
        const first = makeSession();
        const second = makeSession();

        h.lifecycle.adopt(first);
        h.lifecycle.adopt(second);

        assertEquals(first.worker.terminated, true);
        assertEquals(second.worker.terminated, false);
        cleanupWorkers();
    });

    await t.step("per-proxy sessions keep their workers until the lifetime expires", () => {
        const h = harness(makeConfig({ perProxy: true, lifetimeHours: 6 }));
        const a = makeSession("http://a:1");
        const b = makeSession("http://b:1");

        h.lifecycle.adopt(a);
        h.lifecycle.adopt(b);
        assertEquals(a.worker.terminated, false);
        assertEquals(b.worker.terminated, false);

        h.clock.now += 7 * HOUR_MS;
        const c = makeSession("http://c:1");
        h.lifecycle.adopt(c);

        assertEquals(a.worker.terminated, true);
        assertEquals(b.worker.terminated, true);
        assertEquals(c.worker.terminated, false);
        cleanupWorkers();
    });

    await t.step("switchToProxy reuses a fresh cached session and its live worker", () => {
        const h = harness(makeConfig({ perProxy: true }));
        const a = makeSession("http://a:1");
        const b = makeSession("http://b:1");
        h.lifecycle.adopt(a);
        h.lifecycle.adopt(b);

        const outcome = h.lifecycle.switchToProxy("http://a:1");

        assertEquals(outcome, "reused");
        assertEquals(h.installed.at(-1)?.client, a.innertubeClient);
        assertEquals(a.worker.terminated, false);
        cleanupWorkers();
    });

    await t.step("switchToProxy regenerates when the cached session is stale", async () => {
        const h = harness(makeConfig({ perProxy: true, lifetimeHours: 1 }));
        h.lifecycle.adopt(makeSession("http://a:1"));
        h.lifecycle.adopt(makeSession("http://b:1"));
        h.clock.now += 2 * HOUR_MS;

        const outcome = h.lifecycle.switchToProxy("http://a:1");
        await delay(0);

        assertEquals(outcome, "regenerating");
        assertEquals(h.calls, ["proxy-switch"]);
        cleanupWorkers();
    });

    await t.step("switchToProxy is ignored before the first session is ready", () => {
        const h = harness(makeConfig({ perProxy: true }));
        assertEquals(h.lifecycle.switchToProxy("http://a:1"), "ignored");
        assertEquals(h.calls, []);
    });

    await t.step("regenerate coalesces a trigger that arrives while one is in flight", async () => {
        let release!: (s: GeneratedSession) => void;
        const h = harness(
            makeConfig(),
            () =>
                new Promise<GeneratedSession>((resolve) => {
                    release = resolve;
                }),
        );

        const first = h.lifecycle.regenerate("scheduled");
        await h.lifecycle.regenerate("block-detected");
        assertEquals(h.calls, ["scheduled"]);
        assertEquals(await counterValue(h.metrics.sessionRegenDropped), 1);

        release(makeSession());
        await delay(0);
        assertEquals(h.calls, ["scheduled", "block-detected"]);

        release(makeSession());
        await first;
        assertEquals(h.lifecycle.regenerationInFlight, false);
        assertEquals(h.installed.length, 2);
        cleanupWorkers();
    });

    await t.step("regenerate rethrows a generation failure and counts it", async () => {
        const h = harness(
            makeConfig(),
            () => Promise.reject(new Error("attestation failed")),
        );

        let message = "";
        try {
            await h.lifecycle.regenerate("scheduled");
        } catch (err) {
            message = (err as Error).message;
        }

        assertEquals(message, "attestation failed");
        assertEquals(
            await counterValue(h.metrics.potokenGenerationFailure),
            1,
        );
        assertEquals(h.lifecycle.regenerationInFlight, false);
    });

    await t.step("bootstrap holds the in-flight guard so nothing runs concurrently", async () => {
        let release!: (s: GeneratedSession) => void;
        const h = harness(makeConfig());

        const bootstrapping = h.lifecycle.bootstrap(() =>
            new Promise<GeneratedSession>((resolve) => {
                release = resolve;
            })
        );
        assertEquals(h.lifecycle.regenerationInFlight, true);

        await h.lifecycle.regenerate("scheduled");
        assertEquals(h.calls, []);

        release(makeSession());
        await bootstrapping;

        assertEquals(h.lifecycle.initialSessionReady, true);
        assertEquals(h.lifecycle.regenerationInFlight, false);
        // A trigger queued during bootstrap is discarded, not replayed.
        await delay(0);
        assertEquals(h.calls, []);
        cleanupWorkers();
    });

    await t.step("the installed minter records the last successful mint", async () => {
        const h = harness(makeConfig());
        h.lifecycle.adopt(makeSession());
        const minter = h.installed[0].minter as (id: string) => Promise<string>;

        h.clock.now += 1_000;
        const token = await minter("dQw4w9WgXcQ");

        assertEquals(token, "token");
        assertEquals(h.lifecycle.lastMintOkMs, h.clock.now);
        cleanupWorkers();
    });

    await t.step("onBlockDetected regenerates once per cooldown window", async () => {
        const h = harness(makeConfig());
        assertEquals(h.lifecycle.onBlockDetected(), false);

        h.lifecycle.adopt(makeSession());
        assertEquals(h.lifecycle.onBlockDetected(), true);
        assertEquals(h.lifecycle.onBlockDetected(), false);
        await delay(0);
        assertEquals(h.calls, ["block-detected"]);

        h.clock.now += 61_000;
        assertEquals(h.lifecycle.onBlockDetected(), true);
        await delay(0);
        assertEquals(h.calls, ["block-detected", "block-detected"]);
        cleanupWorkers();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/sessionLifecycle_test.ts`
Expected: FAIL with `Module not found "file:///.../src/lib/session/sessionLifecycle.ts"`.

- [ ] **Step 3: Implement `SessionLifecycle`**

```ts
// src/lib/session/sessionLifecycle.ts
import type { Innertube } from "youtubei.js";
import type { Config } from "../helpers/config.ts";
import type { Metrics } from "../helpers/metrics.ts";
import type { TokenGeneratorWorker, TokenMinter } from "../jobs/potoken.ts";
import { CTX, logError, logInfo, logWarn } from "../helpers/log.ts";
import {
    type TerminableWorker,
    terminateUnreferenced,
} from "./workerRegistry.ts";

/** What a generator hands back. A GeneratedPoTokenSession is assignable. */
export interface GeneratedSession {
    innertubeClient: Innertube;
    tokenMinter: TokenMinter | undefined;
    /** undefined when there is no PO-token worker (oauth / po_token disabled). */
    worker: TokenGeneratorWorker | undefined;
    /** Egress proxy the session was minted through (null: direct / IPv6). */
    egressProxyUrl: string | null;
    sessionTtlSecs?: number;
}

export interface SessionLifecycleDeps {
    config: Config;
    metrics: Metrics | undefined;
    /** Produces a brand-new session (PO-token worker or plain client). */
    generate: (reason: string) => Promise<GeneratedSession>;
    /** Installs the pair into the request path (sharedState.set). */
    install: (client: Innertube, minter: TokenMinter | undefined) => void;
    /** Clock seam for tests. */
    now?: () => number;
}

interface CachedSession {
    client: Innertube;
    minter: TokenMinter | undefined;
    worker: TokenGeneratorWorker | undefined;
    generatedAtMs: number;
    sessionTtlSecs?: number;
}

const BLOCK_REGEN_COOLDOWN_MS = 60_000;

/**
 * Owns the session lifecycle: who is generating, whether a trigger must be
 * queued, which sessions (and therefore which workers) are still referenced,
 * and the timestamps readiness and the cron reason about.
 *
 * Invariants:
 * - At most one generation runs at a time (bootstrap or regenerate).
 * - A trigger that arrives during a regeneration runs once more afterwards
 *   instead of being lost.
 * - A worker is terminated only when neither the current session nor a
 *   cached per-proxy session references it.
 */
export class SessionLifecycle {
    private regenInFlight = false;
    private pendingTrigger: string | null = null;
    private _initialSessionReady = false;
    private _sessionGeneratedAtMs = 0;
    private _lastMintOkMs = 0;
    private lastBlockRegenMs = 0;
    private sessionTtlSecs: number | undefined;
    private currentWorker: TokenGeneratorWorker | undefined;
    private readonly perProxySessions = new Map<string, CachedSession>();
    private readonly perProxyEnabled: boolean;
    private readonly now: () => number;

    constructor(private readonly deps: SessionLifecycleDeps) {
        const pool = deps.config.networking.proxy_pool;
        this.perProxyEnabled = pool.enabled && pool.switch_proxy_on_limit;
        this.now = deps.now ?? Date.now;
    }

    get initialSessionReady(): boolean {
        return this._initialSessionReady;
    }

    get sessionGeneratedAtMs(): number {
        return this._sessionGeneratedAtMs;
    }

    get lastMintOkMs(): number {
        return this._lastMintOkMs;
    }

    get regenerationInFlight(): boolean {
        return this.regenInFlight;
    }

    // Effective session lifetime: the smaller of the operator's configured cap
    // and YouTube's estimated integrity-token TTL (when the worker reported
    // one). Honouring the server estimate means we refresh before the token
    // actually expires; session_lifetime_hours stays an upper bound.
    effectiveSessionLifetimeMs(): number {
        const configMs = this.deps.config.jobs.youtube_session
            .session_lifetime_hours * 60 * 60 * 1000;
        if (this.sessionTtlSecs && this.sessionTtlSecs > 0) {
            return Math.min(configMs, this.sessionTtlSecs * 1000);
        }
        return configMs;
    }

    isSessionFresh(): boolean {
        if (this._sessionGeneratedAtMs === 0) return false;
        const age = this.now() - this._sessionGeneratedAtMs;
        return age < this.effectiveSessionLifetimeMs();
    }

    /** Install a freshly generated session and reconcile worker ownership. */
    adopt(session: GeneratedSession): void {
        const now = this.now();
        const minter = this.wrapMinter(session.tokenMinter);
        this.deps.install(session.innertubeClient, minter);
        this.currentWorker = session.worker;
        this._sessionGeneratedAtMs = now;
        this.sessionTtlSecs = session.sessionTtlSecs;
        // Generation validated a mint via checkToken, so the minter is known
        // good as of now.
        this._lastMintOkMs = now;
        this._initialSessionReady = true;

        if (this.perProxyEnabled && session.egressProxyUrl) {
            this.perProxySessions.set(session.egressProxyUrl, {
                client: session.innertubeClient,
                minter,
                worker: session.worker,
                generatedAtMs: now,
                sessionTtlSecs: session.sessionTtlSecs,
            });
        }
        this.evictExpiredProxySessions();
        terminateUnreferenced(this.referencedWorkers());
    }

    /**
     * Regenerate the session. If one is already in flight the trigger is
     * queued and exactly one more regeneration runs after the current one.
     */
    async regenerate(reason: string): Promise<void> {
        if (this.regenInFlight) {
            this.pendingTrigger = reason;
            this.deps.metrics?.sessionRegenDropped.inc();
            logInfo(
                CTX.PO_TOKEN,
                `Regeneration (${reason}) queued behind in-flight generation`,
            );
            return;
        }
        this.regenInFlight = true;
        try {
            let current: string | null = reason;
            while (current !== null) {
                this.pendingTrigger = null;
                await this.runGeneration(current);
                current = this.pendingTrigger;
            }
        } finally {
            this.pendingTrigger = null;
            this.regenInFlight = false;
        }
    }

    /**
     * Run the startup bootstrap under the same guard as regenerate, so the
     * cron / block / proxy-switch triggers cannot start a second generator
     * while the bootstrap is still searching for a valid token.
     */
    async bootstrap(run: () => Promise<GeneratedSession>): Promise<void> {
        if (this.regenInFlight) {
            throw new Error("bootstrap called while a generation is in flight");
        }
        this.regenInFlight = true;
        try {
            this.adopt(await run());
        } finally {
            // Triggers that queued during bootstrap are dropped: the bootstrap
            // just produced a fresh session, replaying them would only churn.
            this.pendingTrigger = null;
            this.regenInFlight = false;
        }
    }

    /**
     * The proxy pool hopped to `proxyUrl`. Reuse that proxy's cached session
     * if it is still fresh, otherwise mint one for it in the background.
     */
    switchToProxy(proxyUrl: string): "reused" | "regenerating" | "ignored" {
        // The bootstrap loop rotates the egress proxy itself while hunting for
        // a token; ignore those hops until a session is established.
        if (!this._initialSessionReady) return "ignored";
        const cached = this.perProxySessions.get(proxyUrl);
        if (cached && this.isCachedFresh(cached)) {
            this.deps.install(cached.client, cached.minter);
            this.currentWorker = cached.worker;
            this._sessionGeneratedAtMs = cached.generatedAtMs;
            this.sessionTtlSecs = cached.sessionTtlSecs;
            return "reused";
        }
        logInfo(
            CTX.PROXY,
            "Active egress proxy changed — minting session for new IP",
        );
        this.regenerate("proxy-switch").catch((err) =>
            logError(CTX.PROXY, "Proxy-switch session regeneration failed", err)
        );
        return "regenerating";
    }

    /**
     * A YouTube block was detected. Regenerate proactively, debounced so a
     * burst of blocked requests can't trigger a regeneration storm. Returns
     * whether a regeneration was triggered.
     */
    onBlockDetected(): boolean {
        if (!this._initialSessionReady) return false;
        const now = this.now();
        if (now - this.lastBlockRegenMs < BLOCK_REGEN_COOLDOWN_MS) return false;
        this.lastBlockRegenMs = now;
        this.deps.metrics?.blockTriggeredRegens.inc();
        logWarn(
            CTX.PO_TOKEN,
            "YouTube block detected — regenerating session proactively",
        );
        this.regenerate("block-detected").catch((err) =>
            logError(
                CTX.PO_TOKEN,
                "Block-triggered session regeneration failed",
                err,
            )
        );
        return true;
    }

    /** Drop cached per-proxy sessions past their lifetime; returns how many. */
    evictExpiredProxySessions(): number {
        let evicted = 0;
        for (const [proxyUrl, cached] of this.perProxySessions) {
            if (this.isCachedFresh(cached)) continue;
            this.perProxySessions.delete(proxyUrl);
            evicted++;
        }
        if (evicted > 0) terminateUnreferenced(this.referencedWorkers());
        return evicted;
    }

    private async runGeneration(reason: string): Promise<void> {
        try {
            this.adopt(await this.deps.generate(reason));
            logInfo(CTX.PO_TOKEN, `Session regenerated (${reason})`);
        } catch (err) {
            this.deps.metrics?.potokenGenerationFailure.inc();
            throw err;
        }
    }

    private isCachedFresh(cached: CachedSession): boolean {
        const configMs = this.deps.config.jobs.youtube_session
            .session_lifetime_hours * 60 * 60 * 1000;
        const lifetimeMs = cached.sessionTtlSecs && cached.sessionTtlSecs > 0
            ? Math.min(configMs, cached.sessionTtlSecs * 1000)
            : configMs;
        return this.now() - cached.generatedAtMs < lifetimeMs;
    }

    private referencedWorkers(): Set<TerminableWorker> {
        const keep = new Set<TerminableWorker>();
        if (this.currentWorker) keep.add(this.currentWorker);
        for (const cached of this.perProxySessions.values()) {
            if (cached.worker) keep.add(cached.worker);
        }
        return keep;
    }

    // Wrap the minter so every successful per-video mint refreshes
    // lastMintOkMs, which readiness uses to detect a dead minter.
    private wrapMinter(
        minter: TokenMinter | undefined,
    ): TokenMinter | undefined {
        if (!minter) return undefined;
        return async (videoId: string): Promise<string> => {
            const token = await minter(videoId);
            this._lastMintOkMs = this.now();
            return token;
        };
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/sessionLifecycle_test.ts`
Expected: `ok | 1 passed (11 steps) | 0 failed`.

- [ ] **Step 5: Format, lint, check, commit**

```bash
deno fmt src/lib/session/sessionLifecycle.ts src/tests/sessionLifecycle_test.ts
deno task lint && deno task check
git add src/lib/session/sessionLifecycle.ts src/tests/sessionLifecycle_test.ts
git commit -m "feat: add SessionLifecycle with coalesced regeneration and worker ownership"
```

---

### Task 5: Wire `main.ts` to `SessionLifecycle`

Covers A1 (cron gated, bootstrap under guard), A2/A5 (per-proxy cache keyed by pinned proxy), A4 (shared cache passed to the PO path).

**Files:**
- Modify: `src/main.ts:116-216` (lifecycle state + `regenerateSession`), `:230-387` (bootstrap, callbacks, cron), `:413-431` (middlewares)
- Modify: `src/lib/types/HonoVariables.ts`

**Interfaces:**
- Consumes: `SessionLifecycle`, `GeneratedSession` (Task 4); `poTokenGenerate(config, metrics, { cache })` (Task 3).
- Produces: Hono context variable `lastMintOkMs: number | undefined` (read by Task 6).

- [ ] **Step 1: Add `lastMintOkMs` to `HonoVariables`**

```ts
// src/lib/types/HonoVariables.ts
import { Innertube } from "youtubei.js";
import type { TokenMinter } from "../jobs/potoken.ts";
import type { Config } from "../helpers/config.ts";
import { Metrics } from "../helpers/metrics.ts";

export type HonoVariables = {
    innertubeClient: Innertube;
    config: Config;
    tokenMinter: TokenMinter | undefined;
    metrics: Metrics | undefined;
    /** Timestamp (ms) of the last successful content-token mint; 0 = never. */
    lastMintOkMs: number | undefined;
};
```

- [ ] **Step 2: Replace the lifecycle state block and `regenerateSession` in `main.ts`**

Delete lines 116–216 of `src/main.ts` (from the comment `// Session lifecycle state.` through the closing `}` of `regenerateSession`). In their place insert:

```ts
import {
    type GeneratedSession,
    SessionLifecycle,
} from "./lib/session/sessionLifecycle.ts";

// Produces a brand-new session for the lifecycle: a PO-token worker session
// when the job is enabled, otherwise a plain Innertube client.
const generateSession = async (): Promise<GeneratedSession> => {
    if (innertubeClientJobPoTokenEnabled) {
        return await poTokenGenerate(config, metrics, { cache });
    }
    const client = await Innertube.create({
        enable_session_cache: false,
        fetch: getFetchClient(config),
        retrieve_player: innertubeClientFetchPlayer,
        user_agent: USER_AGENT,
        cookie: innertubeClientCookies || undefined,
        player_id: config.youtube_session.player_id,
        location: config.youtube_session.gl || undefined,
        lang: config.youtube_session.hl || undefined,
        cache, // reuse cache for speed
    });
    return {
        innertubeClient: client,
        tokenMinter: undefined,
        worker: undefined,
        egressProxyUrl: null,
    };
};

const lifecycle = new SessionLifecycle({
    config,
    metrics,
    generate: generateSession,
    install: (client, minter) => sharedState.set(client, minter),
});
```

- [ ] **Step 3: Replace the bootstrap `.then/.catch` and callbacks**

In the `if (innertubeClientJobPoTokenEnabled) {` block, replace the `retry(...).then(...).catch(...)` statement with:

```ts
        lifecycle.bootstrap(() =>
            retry(
                bootstrapAttempt,
                {
                    maxAttempts: bootstrapMaxAttempts,
                    minTimeout: 1_000,
                    maxTimeout: 10_000,
                    multiplier: 2,
                    jitter: 0.2,
                },
            )
        ).then(() => {
            tokenMinterReadyResolve?.();
        }).catch((err) => {
            logError(CTX.PO_TOKEN, "Failed to initialize", err);
            metrics?.potokenGenerationFailure.inc();
            // Distinguish "startup is just slow" from "the whole proxy pool is
            // burned": if we rotated through every proxy (bootstrapMaxAttempts
            // ≥ pool size) and still couldn't mint a token, none of the
            // configured egress IPs returned a clean response. That points at
            // the pool itself, not a transient hiccup — surface it loudly.
            if (usePool) {
                logError(
                    CTX.PO_TOKEN,
                    `Swept the entire proxy pool (${config.networking.proxy_pool.proxies.length} ` +
                        `${
                            config.networking.proxy_pool.proxies.length === 1
                                ? "proxy"
                                : "proxies"
                        }) over ${bootstrapMaxAttempts} attempts without minting a ` +
                        `PO token — all egress IPs appear blocked. Consider rotating/refreshing ` +
                        `the proxy pool. The scheduled job will keep retrying.`,
                );
            }
            tokenMinterReadyResolve?.();
        });
```

Replace the `else { // No PO token ... }` branch body with:

```ts
        // No PO token: the client created above is the session. Adopt it so
        // the lifetime check below doesn't immediately regenerate it.
        lifecycle.adopt({
            innertubeClient,
            tokenMinter: undefined,
            worker: undefined,
            egressProxyUrl: null,
        });
        tokenMinterReadyResolve?.();
```

Replace the whole `setOnYouTubeBlock(() => { ... });` statement with:

```ts
    // Proactively regenerate the session when a block is detected, instead of
    // waiting for the next scheduled tick (debounced inside the lifecycle).
    setOnYouTubeBlock(() => {
        lifecycle.onBlockDetected();
    });
```

Replace the whole `if (perProxySessionsEnabled) { setOnActiveProxyChange(...) }` block with:

```ts
    // When the proxy pool hops the active egress (rate-limit-driven, only with
    // switch_proxy_on_limit), swap in that proxy's session so its IP and tokens
    // stay consistent. Reuse a still-fresh cached session synchronously;
    // otherwise mint a new one in the background pinned to the new proxy.
    if (
        config.networking.proxy_pool.enabled &&
        config.networking.proxy_pool.switch_proxy_on_limit
    ) {
        setOnActiveProxyChange((proxyUrl: string) => {
            lifecycle.switchToProxy(proxyUrl);
        });
    }
```

Replace the `Deno.cron(...)` callback body with:

```ts
        async () => {
            lifecycle.evictExpiredProxySessions();
            // The startup bootstrap (or a triggered regen) is the sole
            // generator while it runs; never start a second one.
            if (lifecycle.regenerationInFlight) {
                logInfo(
                    CTX.PO_TOKEN,
                    "Generation in flight, skipping scheduled regeneration",
                );
                return;
            }
            // Skip the expensive full regeneration while the current session is
            // still within its effective lifetime (the smaller of the configured
            // cap and YouTube's estimated token TTL). The alive worker keeps
            // minting per-video content tokens in the meantime; early token
            // expiry or a detected block forces a regen out of band.
            if (lifecycle.isSessionFresh()) {
                const age = Date.now() - lifecycle.sessionGeneratedAtMs;
                logInfo(
                    CTX.PO_TOKEN,
                    `Session still fresh (${
                        Math.round(age / 1000)
                    }s old), skipping scheduled regeneration`,
                );
                return;
            }
            await lifecycle.regenerate("scheduled");
        },
```

- [ ] **Step 4: Expose `lastMintOkMs` in both middlewares**

In both `companionApp.use("*", ...)` and `app.use("*", ...)` add, after `c.set("metrics", metrics);`:

```ts
    c.set("lastMintOkMs", lifecycle.lastMintOkMs);
```

- [ ] **Step 5: Type-check and remove dead code**

Run: `deno task check`
Expected: errors only for now-unused identifiers, if any. Remove any leftover references to `sessionGeneratedAtMs`, `sessionRegenInFlight`, `lastBlockRegenMs`, `BLOCK_REGEN_COOLDOWN_MS`, `sessionTtlSecs`, `effectiveSessionLifetimeMs`, `initialSessionReady`, `perProxySessions`, `perProxySessionsEnabled` in `main.ts`; then run `deno task lint` (it flags unused imports such as `getSessionEgressProxy`, which is no longer needed in `main.ts` — remove it from the dynamic-import destructuring).

Run: `deno task check && deno task lint && deno task format`
Expected: all three succeed.

- [ ] **Step 6: Integration gate**

Run: `SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test`
Expected: `ok | N passed | 0 failed`, and in the `main_test.ts` output the lines `[INFO]  [PO-TOKEN] Successfully generated` and `Check if it can get an OK playabilityStatus on /youtubei/v1/player ... ok`.

- [ ] **Step 7: Commit**

```bash
git add src/main.ts src/lib/types/HonoVariables.ts
git commit -m "refactor: drive session regeneration through SessionLifecycle"
```

---

### Task 6: Readiness reflects mint health

Covers A7 (readiness).

**Files:**
- Modify: `src/routes/readiness.ts:33-39`
- Modify: `src/tests/readiness_test.ts` (add cases)

**Interfaces:**
- Consumes: context variable `lastMintOkMs` (Task 5).
- Produces: `/readyz` JSON gains `checks.token_mint_fresh` when PO tokens are enabled. (`/readyz` is not called by Invidious; no contract impact.)

- [ ] **Step 1: Add failing tests**

Append to `src/tests/readiness_test.ts`:

```ts
const HOUR_MS = 60 * 60 * 1000;

function appWithSession(
    { minter, lastMintOkMs }: { minter: boolean; lastMintOkMs: number },
) {
    const app = new Hono<{ Variables: HonoVariables }>();
    app.use("*", async (c, next) => {
        c.set(
            "config" as never,
            {
                server: {},
                jobs: {
                    youtube_session: {
                        po_token_enabled: true,
                        session_lifetime_hours: 6,
                    },
                },
            } as never,
        );
        c.set("innertubeClient" as never, { fake: true } as never);
        c.set(
            "tokenMinter" as never,
            (minter ? () => Promise.resolve("t") : undefined) as never,
        );
        c.set("lastMintOkMs" as never, lastMintOkMs as never);
        await next();
    });
    app.route("/readyz", readiness);
    return app;
}

Deno.test("Readiness endpoint - ready when the minter minted within the session lifetime", async () => {
    const app = appWithSession({ minter: true, lastMintOkMs: Date.now() });

    const res = await app.request("/readyz");

    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.checks.token_minter, true);
    assertEquals(body.checks.token_mint_fresh, true);
});

Deno.test("Readiness endpoint - not ready when the last mint is older than the session lifetime", async () => {
    const app = appWithSession({
        minter: true,
        lastMintOkMs: Date.now() - 7 * HOUR_MS,
    });

    const res = await app.request("/readyz");

    assertEquals(res.status, 503);
    const body = await res.json();
    assertEquals(body.checks.token_mint_fresh, false);
});

Deno.test("Readiness endpoint - not ready without a token minter when PO tokens are enabled", async () => {
    const app = appWithSession({ minter: false, lastMintOkMs: Date.now() });

    const res = await app.request("/readyz");

    assertEquals(res.status, 503);
    const body = await res.json();
    assertEquals(body.checks.token_minter, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/readiness_test.ts`
Expected: FAIL — `body.checks.token_mint_fresh` is `undefined` (first new test) and the stale-mint test gets 200 instead of 503.

- [ ] **Step 3: Implement the freshness check**

Replace the `if (config?.jobs?.youtube_session?.po_token_enabled) { ... }` block in `src/routes/readiness.ts` with:

```ts
    // When PO tokens are enabled, the token minter must be initialized before
    // the service can actually serve player/DASH/captions traffic — and it
    // must have minted successfully within the session lifetime, otherwise a
    // minter whose worker died would keep reporting ready while every
    // playback request times out.
    if (config?.jobs?.youtube_session?.po_token_enabled) {
        const tokenMinter = c.get("tokenMinter");
        checks["token_minter"] = !!tokenMinter;
        if (!tokenMinter) allReady = false;

        const lifetimeHours =
            config.jobs.youtube_session.session_lifetime_hours;
        // lifetime 0 means "regenerate every tick"; no meaningful window.
        const windowMs = lifetimeHours > 0
            ? lifetimeHours * 60 * 60 * 1000
            : Number.POSITIVE_INFINITY;
        const lastMintOkMs = c.get("lastMintOkMs") ?? 0;
        const mintFresh = lastMintOkMs > 0 &&
            Date.now() - lastMintOkMs < windowMs;
        checks["token_mint_fresh"] = mintFresh;
        if (!mintFresh) allReady = false;
    }
```

Also update the doc comment's `Checks:` list with a fourth bullet: `- the minter minted successfully within session_lifetime_hours`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/readiness_test.ts`
Expected: `ok | 5 passed | 0 failed` (the two pre-existing tests stay green: their config has no `jobs`).

- [ ] **Step 5: Commit**

```bash
deno fmt src/routes/readiness.ts src/tests/readiness_test.ts
deno task check && deno task lint
git add src/routes/readiness.ts src/tests/readiness_test.ts
git commit -m "feat: readiness requires a recent successful content-token mint"
```

---

### Task 7: Shutdown order and tracked cache writes

Covers A6.

**Files:**
- Create: `src/lib/helpers/pendingWrites.ts`
- Create: `src/tests/pendingWrites_test.ts`
- Modify: `src/lib/helpers/youtubePlayerHandling.ts:191-214, 223-241`
- Modify: `src/main.ts` shutdown handler (`cleanupWorkers()` placement, await pending writes)

**Interfaces:**
- Produces: `trackPendingWrite(write: Promise<unknown>): void`, `awaitPendingWrites(): Promise<void>`, `pendingWriteCount(): number`.

- [ ] **Step 1: Write the failing test**

```ts
// src/tests/pendingWrites_test.ts
import { assertEquals } from "./deps.ts";
import {
    awaitPendingWrites,
    pendingWriteCount,
    trackPendingWrite,
} from "../lib/helpers/pendingWrites.ts";

Deno.test("pendingWrites", async (t) => {
    await t.step("awaitPendingWrites resolves once every tracked write settled", async () => {
        let resolveWrite!: () => void;
        trackPendingWrite(
            new Promise<void>((resolve) => {
                resolveWrite = resolve;
            }),
        );
        assertEquals(pendingWriteCount(), 1);

        let drained = false;
        const draining = awaitPendingWrites().then(() => {
            drained = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        assertEquals(drained, false);

        resolveWrite();
        await draining;
        assertEquals(drained, true);
        assertEquals(pendingWriteCount(), 0);
    });

    await t.step("a rejected write is forgotten and does not reject the drain", async () => {
        trackPendingWrite(Promise.reject(new Error("disk full")));

        await awaitPendingWrites();

        assertEquals(pendingWriteCount(), 0);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/pendingWrites_test.ts`
Expected: FAIL with `Module not found "file:///.../src/lib/helpers/pendingWrites.ts"`.

- [ ] **Step 3: Implement the tracker**

```ts
// src/lib/helpers/pendingWrites.ts
/**
 * Tracks fire-and-forget KV writes so graceful shutdown can drain them
 * before closing the store. Callers handle (log) their own rejections; the
 * tracker only cares that the promise settled.
 */
const pending = new Set<Promise<unknown>>();

export function trackPendingWrite(write: Promise<unknown>): void {
    const tracked: Promise<unknown> = write
        .catch(() => undefined)
        .finally(() => {
            pending.delete(tracked);
        });
    pending.add(tracked);
}

export async function awaitPendingWrites(): Promise<void> {
    await Promise.allSettled(Array.from(pending));
}

export function pendingWriteCount(): number {
    return pending.size;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `DENO_JOBS=1 SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/pendingWrites_test.ts`
Expected: `ok | 1 passed (2 steps) | 0 failed`.

- [ ] **Step 5: Track the two cache-write IIFEs**

In `src/lib/helpers/youtubePlayerHandling.ts` add the import:

```ts
import { trackPendingWrite } from "./pendingWrites.ts";
```

Change the positive-cache write (inside `if (cacheEnabled) {` under `status == "OK"`) from `(async () => { ... })();` to:

```ts
                trackPendingWrite((async () => {
                    try {
                        await kv.set(
                            ["video_cache", videoId],
                            compress(
                                new TextEncoder().encode(
                                    JSON.stringify(videoOnlyNecessaryInfo),
                                ),
                            ),
                            {
                                expireIn: ttlMs,
                            },
                        );
                    } catch (err) {
                        logError(
                            CTX.CACHE,
                            `Failed to write ${videoId} to cache`,
                            err,
                        );
                    }
                })());
```

and the negative-cache write (inside `if (cacheEnabled && negativeTtl > 0) {`) to:

```ts
                trackPendingWrite((async () => {
                    try {
                        await kv.set(
                            ["video_cache", videoId],
                            compress(
                                new TextEncoder().encode(
                                    JSON.stringify(videoOnlyNecessaryInfo),
                                ),
                            ),
                            { expireIn: negativeTtl * 1000 },
                        );
                    } catch (err) {
                        logError(
                            CTX.CACHE,
                            `Failed to write negative cache for ${videoId}`,
                            err,
                        );
                    }
                })());
```

(If plan D has already replaced these blocks with `writePlayerCache(...)`, wrap that call instead: `trackPendingWrite(writePlayerCache(...))`.)

- [ ] **Step 6: Fix the shutdown order in `main.ts`**

In the `shutdown` function inside `if (import.meta.main) {`: delete the two lines

```ts
        // Cleanup PO token workers
        cleanupWorkers();
```

that currently sit right after `controller.abort();`, and change the tail of the function (from `clearTimeout(forceExit);`) to:

```ts
        clearTimeout(forceExit);
        // Workers are torn down only after in-flight requests drained, so a
        // request that reaches tokenMinter() during the drain still gets a
        // token instead of waiting out the mint timeout.
        cleanupWorkers();
        // Let fire-and-forget cache writes land, then flush and close the
        // on-disk KV cache once nothing can touch it.
        await awaitPendingWrites();
        await closeKv().catch((err) =>
            logWarn(CTX.SHUTDOWN, `Failed to close KV cache: ${err}`)
        );
        logInfo(CTX.SHUTDOWN, "Graceful shutdown completed");
        Deno.exit(0);
```

and add the import near `closeKv`:

```ts
import { awaitPendingWrites } from "./lib/helpers/pendingWrites.ts";
```

- [ ] **Step 7: Verify**

Run: `deno task format && deno task check && deno task lint`
Expected: all succeed.

Run: `SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test`
Expected: `ok | N passed | 0 failed`.

Manual shutdown check: start `SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task dev`, wait for `[PO-TOKEN] Successfully generated`, press Ctrl-C.
Expected log order: `Caught SIGINT, initiating graceful shutdown...` → `Cleaning up 1 worker(s) for shutdown` → `Graceful shutdown completed`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/helpers/pendingWrites.ts src/tests/pendingWrites_test.ts src/lib/helpers/youtubePlayerHandling.ts src/main.ts
git commit -m "fix: terminate PO-token workers after drain and await pending cache writes"
```

---

## Self-review

**Spec coverage**

| Finding | Task |
|---|---|
| A1 positional kill / concurrent generations | Task 1 (registry), Task 3 (no positional loop), Task 4 (`bootstrap` guard, coalescing), Task 5 (cron gated on `regenerationInFlight`) |
| A2 per-proxy sessions reference dead workers | Task 4 (`CachedSession.worker`, `referencedWorkers`, `evictExpiredProxySessions`) |
| A3 no error listener / timeout / worker try | Task 3 (`error` + `messageerror` listeners, `GENERATION_TIMEOUT_MS`, worker.ts try) |
| A4 serving client options | Task 3 (`user_agent`, `location`, `lang`, `cache`), Task 5 passes `cache` |
| A5 dropped triggers, cache key | Task 3 (`egressProxyUrl` from `pinWorkerConfig`), Task 4 (`pendingTrigger`, `sessionRegenDropped`, key = `session.egressProxyUrl`) |
| A6 shutdown order, cache writes | Task 7 |
| A7 mint metrics, readiness | Task 2, Task 3 (counters incremented), Task 4 (`lastMintOkMs`), Task 5 (context var), Task 6 |

**Placeholder scan:** no TBD/TODO; every code step contains the code. The one conditional instruction (Task 3 Step 6 cast fallback; Task 7 Step 5 plan-D note) states the exact alternative.

**Type consistency:** `TokenGeneratorWorker`, `GeneratedPoTokenSession` (Task 3) ⊂ `GeneratedSession` (Task 4) — same field names `innertubeClient`, `tokenMinter`, `worker`, `egressProxyUrl`, `sessionTtlSecs`. `createMinter(worker, metrics, timeoutMs)` signature matches its test. `lifecycle.lastMintOkMs` getter ↔ `c.set("lastMintOkMs", …)` ↔ `c.get("lastMintOkMs")` in readiness. `cleanupWorkers` is re-exported from `potoken.ts`, so `main.ts`'s existing import compiles until Task 7 keeps using it. `terminateUnreferenced` takes `ReadonlySet<TerminableWorker>`; `referencedWorkers()` returns `Set<TerminableWorker>`.

**Overlap with other plans:** Task 1 rewrites `shutdown_test.ts` (also listed under E3); Task 7 touches the cache-write blocks that plan D5 refactors — the note in Task 7 Step 5 covers both orders.
