# Security and Routes Hardening (Spec C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three HIGH security holes (import allowlist bypass, PO-token log leakage, unvalidated caption host), then remove the duplicated guard chain, add inbound rate limiting, and tighten input handling, config, logging and metrics on the companion's HTTP surface.

**Architecture:** Every change is contract-neutral towards Invidious: status codes and response bodies stay byte-identical, only failure paths gain new 4xx/5xx responses. New behaviour lands in small single-purpose modules (`crypto.ts`, `guards.ts`, `rateLimit.ts`, `errorHandler.ts`) that routes call; each module ships with a network-free unit test using Hono's `app.request()` and a stub context. Existing routes are edited in place.

**Tech Stack:** Deno 2.9, Hono 4.13 (`hono`, `hono/http-exception`, `hono/deno`), Zod 3, Web Crypto (AES-256-GCM), `@std/encoding/base64`, `deno test`.

**Spec:** `docs/superpowers/specs/2026-09-16-code-review-findings.md`, section C (C1–C11).

## Global Constraints

- Runtime: Deno 2.9.x (Docker), `deno.json` tasks are the single source of truth for permission flags. Formatter indent width is **4**.
- Every change must pass `deno task format`, `deno task check`, `deno task lint` and `deno task test` (`SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa`).
- The Invidious ↔ companion contract (routes, query names, status codes, response bodies, `check`/`enc`/`data` wire format) must not change unless the finding says so explicitly; then `../invidious/` must be updated in lockstep.
- Logging goes through `logInfo/logWarn/logError/logDebug(CTX.X, msg)` from `src/lib/helpers/log.ts`. No bare `console.*` in `src/` outside `log.ts`.
- Immutability preferred; no mutation of shared objects outside `sharedState`.
- Files ≤ 800 lines, functions ≤ 50 lines where reasonably achievable.
- Tests: pure-unit tests must not need network. Integration tests live behind `main_test.ts`. Test names describe behaviour.
- Commit format: `<type>: <description>` (feat, fix, refactor, docs, test, chore, perf, ci). Attribution trailers as configured for the session.

## Running a single test file

Every "Run" step below uses `$TEST_FLAGS`. Define it once per shell (copied from the `test` task in `deno.json`):

```bash
export TEST_FLAGS="--allow-import=github.com:443,jsr.io:443,cdn.jsdelivr.net:443,esm.sh:443,deno.land:443 --allow-net --allow-env --allow-sys=hostname --allow-read=.,/tmp,/var/tmp/youtubei.js,/tmp/invidious-companion.sock,$HOME/.cache/deno --allow-write=/var/tmp/youtubei.js,/tmp"
```

Then: `DENO_JOBS=1 deno test src/tests/<file>_test.ts $TEST_FLAGS`

Before every commit run the four project checks:

```bash
deno task format && deno task check && deno task lint
```

(`deno task format` is `deno fmt --check`; if it fails, run `deno fmt src/**` and re-check.)

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/lib/helpers/dynamicImportValidation.ts` | Validate env-configurable import paths; reject remote/traversal before allowlisting | 1 |
| `src/lib/helpers/log.ts` | Leveled logger; now redacts every message and error; gains `CTX.HTTP` | 2, 9 |
| `src/routes/errorHandler.ts` (new) | Hono `onError`: pass HTTPExceptions through, log everything else redacted, return generic 500 | 2 |
| `src/lib/helpers/youtubeTranscriptsHandling.ts` | Build a host-validated timedtext URL; fetch captions with a bounded error path | 3 |
| `src/lib/helpers/crypto.ts` (new) | Single AES-256-GCM key derivation, `encryptGcm`, `decryptGcm` | 4 |
| `src/lib/helpers/encryptQuery.ts` | `encryptQuery` (throws on failure) / `decryptQuery` on top of `crypto.ts` | 4, 5 |
| `src/lib/helpers/verifyRequest.ts` | `check` verification on top of `crypto.ts`, strict integer timestamp | 4 |
| `src/tests/helpers/testConfig.ts` (new) | `makeTestConfig()` for unit tests | 4 |
| `src/tests/helpers/check.ts` (new) | `makeCheck()` builds a valid Invidious-style `check` token | 4 |
| `src/routes/invidious_routes/latestVersion.ts` | Uses guards; 500 on encryption failure | 5, 6 |
| `src/routes/invidious_routes/dashManifest.ts` | Uses guards; 500 on encryption failure | 5, 6 |
| `src/routes/guards.ts` (new) | `requireValidVideoId`, `requireTokenMinter`, `requireVerifiedCheck` | 6 |
| `src/routes/invidious_routes/captions.ts` | Uses guards; counts caption requests | 6, 10 |
| `src/routes/invidious_routes/download.ts` | Uses guards; guarded `formData()`, bounded `title`/`ext` | 6, 7 |
| `src/lib/helpers/config.ts` | `server.trust_proxy`, `server.rate_limit.*`, `.min(0)` on retry fields | 8, 11 |
| `src/routes/rateLimit.ts` (new) | Per-client-IP token-bucket middleware | 8 |
| `src/main.ts` | Registers `errorHandler` and `rateLimit` | 2, 8 |
| `src/routes/compactLogger.ts` | Access log via `logInfo(CTX.HTTP)`, labelled latency, 401 counter | 9, 10 |
| `src/lib/helpers/redactSensitive.ts` | Adds `ip`, `data`, `cookies` to the redaction list | 9 |
| `src/lib/helpers/metrics.ts` | New counters and labelled `requestLatency` | 6, 8, 10 |
| `config/config.example.toml`, `README.md` | New keys documented; valid `secret_key` placeholder; `player_id` example | 8, 11 |

---

### Task 1: Reorder the dynamic-import allowlist so remote URLs and traversal are rejected first (C1)

**Files:**
- Modify: `src/lib/helpers/dynamicImportValidation.ts:45-88`
- Test: `src/tests/dynamicImportValidation_test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: unchanged exports `resolveAndValidateImportLocation(envVarName: string, moduleName: string): string`, `resolveAndValidateFetchClientLocation(): string`, `resolveAndValidatePlayerReqLocation(): string`. Behaviour change: a remote scheme or `..` traversal now throws even when the basename is an allowed module name.

- [ ] **Step 1: Write the failing tests**

Append these three steps inside the existing `Deno.test("Dynamic import validation", …)` block in `src/tests/dynamicImportValidation_test.ts`, directly before the closing `});` (after the "accepts compiled path with allowed basename" step):

```ts
    await t.step(
        "rejects a remote URL even when its basename is an allowed module",
        () => {
            Deno.env.set(
                "GET_FETCH_CLIENT_LOCATION",
                "https://evil.example/getFetchClient.ts",
            );
            Deno.env.delete("DENO_COMPILED");
            try {
                assertThrows(
                    () => resolveAndValidateFetchClientLocation(),
                    Error,
                    "remote module URLs are not allowed",
                );
            } finally {
                cleanup();
            }
        },
    );

    await t.step(
        "rejects path traversal even when its basename is an allowed module",
        () => {
            Deno.env.set(
                "GET_FETCH_CLIENT_LOCATION",
                "../../../tmp/getFetchClient.ts",
            );
            Deno.env.delete("DENO_COMPILED");
            try {
                assertThrows(
                    () => resolveAndValidateFetchClientLocation(),
                    Error,
                    "suspicious path traversal",
                );
            } finally {
                cleanup();
            }
        },
    );

    await t.step(
        "rejects traversal hidden behind the allowed ../lib/ prefix",
        () => {
            Deno.env.set(
                "GET_FETCH_CLIENT_LOCATION",
                "../lib/../../tmp/getFetchClient.ts",
            );
            Deno.env.delete("DENO_COMPILED");
            try {
                assertThrows(
                    () => resolveAndValidateFetchClientLocation(),
                    Error,
                    "suspicious path traversal",
                );
            } finally {
                cleanup();
            }
        },
    );
```

- [ ] **Step 2: Run the test file to verify the new steps fail**

Run: `DENO_JOBS=1 deno test src/tests/dynamicImportValidation_test.ts $TEST_FLAGS`
Expected: FAILED, 3 failed steps, each with `AssertionError: Expected function to throw.`

- [ ] **Step 3: Reorder the checks and route the warning through the logger**

Replace `src/lib/helpers/dynamicImportValidation.ts` lines 45–88 (from `const allowedModules = allowedInternalModules(moduleName);` to the closing `return location;` of the function) with:

```ts
    const allowedModules = allowedInternalModules(moduleName);

    if (allowedModules.includes(location)) {
        return location;
    }

    // Reject remote schemes BEFORE any basename-based acceptance. Otherwise
    // "https://evil.example/getFetchClient.ts" would be accepted purely
    // because its basename matches an allowed module name.
    if (/^(https?:|npm:|node:|jsr:)/i.test(location)) {
        throw new Error(
            `${envVarName} rejected: remote module URLs are not allowed. ` +
                `Got: "${envLocation}". Only local/internal module paths are permitted.`,
        );
    }

    // Reject path traversal BEFORE basename-based acceptance, for the same
    // reason. At most one leading "../lib/" prefix is tolerated; any ".."
    // beyond that (including "../lib/../../etc/passwd") is rejected.
    const afterAllowedPrefix = location.startsWith(TRAVERSAL_ALLOWED_PREFIX)
        ? location.slice(TRAVERSAL_ALLOWED_PREFIX.length)
        : location;
    if (afterAllowedPrefix.includes("..")) {
        throw new Error(
            `${envVarName} rejected: suspicious path traversal detected. ` +
                `Got: "${envLocation}". Only internal module paths are permitted.`,
        );
    }

    // Now that remote and traversal inputs are excluded, a path ending in an
    // allowed module name is safe. This covers compiled paths such as
    // file:///path/to/<moduleName>.
    const basename = location.split("/").pop()?.replace(/\.ts$/, "") || "";
    if (allowedModules.includes(basename)) {
        return location;
    }

    // Local path with an unrecognised module name: allow, but warn.
    logWarn(
        CTX.CONFIG,
        `${envVarName} uses non-standard module path: "${envLocation}". ` +
            `Allowed modules: ${allowedModules.join(", ")}`,
    );

    return location;
```

Add the import at the top of the file, after the doc comment (line 8):

```ts
import { CTX, logWarn } from "./log.ts";
```

- [ ] **Step 4: Run the test file to verify all steps pass**

Run: `DENO_JOBS=1 deno test src/tests/dynamicImportValidation_test.ts $TEST_FLAGS`
Expected: `ok | 1 passed (10 steps) | 0 failed`

- [ ] **Step 5: Run project checks and commit**

```bash
deno task format && deno task check && deno task lint
git add src/lib/helpers/dynamicImportValidation.ts src/tests/dynamicImportValidation_test.ts
git commit -m "fix: reject remote and traversal import paths before allowlist basename match"
```

---

### Task 2: Redact all log output and register a Hono `onError` handler (C2)

**Files:**
- Modify: `src/lib/helpers/log.ts:42-84`
- Create: `src/routes/errorHandler.ts`
- Modify: `src/main.ts:19, 55`
- Test: `src/tests/log_test.ts` (new), `src/tests/errorHandler_test.ts` (new)

**Interfaces:**
- Consumes: `redactString(str: string): string` from `src/lib/helpers/redactSensitive.ts`.
- Produces: `errorHandler: ErrorHandler` (Hono type) exported from `src/routes/errorHandler.ts`. `logError(context, message, err?)` keeps its signature but prints `redactString(message)` and, for `err`, `redactString(err.stack ?? String(err))`. `logInfo`, `logWarn`, `logDebug` also redact their message.

- [ ] **Step 1: Write the failing logger test**

Create `src/tests/log_test.ts`:

```ts
import { assert, assertEquals } from "./deps.ts";
import { CTX, logError, logWarn } from "../lib/helpers/log.ts";

function captureConsole(
    method: "error" | "warn",
    fn: () => void,
): string[] {
    const lines: string[] = [];
    const original = console[method];
    console[method] = (...args: unknown[]) => {
        lines.push(args.map((a) => String(a)).join(" "));
    };
    try {
        fn();
    } finally {
        console[method] = original;
    }
    return lines;
}

Deno.test("logError redacts secrets in the message", () => {
    const lines = captureConsole("error", () => {
        logError(
            CTX.SERVER,
            "request to https://x/timedtext?v=1&pot=SECRETTOKEN failed",
        );
    });
    assertEquals(lines.length, 1);
    assert(!lines[0].includes("SECRETTOKEN"));
    assert(lines[0].includes("pot=[REDACTED]"));
});

Deno.test("logError redacts secrets inside the error object", () => {
    const err = new Error(
        "error sending request for url (https://x/timedtext?pot=SECRETTOKEN&fmt=vtt)",
    );
    const lines = captureConsole("error", () => {
        logError(CTX.CAPTIONS, "caption fetch failed", err);
    });
    assertEquals(lines.length, 1);
    assert(!lines[0].includes("SECRETTOKEN"));
    assert(lines[0].includes("pot=[REDACTED]"));
    assert(lines[0].includes("caption fetch failed"));
});

Deno.test("logWarn redacts secrets in the message", () => {
    const lines = captureConsole("warn", () => {
        logWarn(CTX.PROXY, "Bearer abc123 was rejected");
    });
    assertEquals(lines.length, 1);
    assert(!lines[0].includes("abc123"));
    assert(lines[0].includes("Bearer [REDACTED]"));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `DENO_JOBS=1 deno test src/tests/log_test.ts $TEST_FLAGS`
Expected: FAILED, 3 failed (`AssertionError` on the `!includes("SECRETTOKEN")` / `!includes("abc123")` assertions).

- [ ] **Step 3: Make every log level redact**

In `src/lib/helpers/log.ts`, add after line 3 (inside the doc comment is fine; put the import after the closing `*/` on line 17):

```ts
import { redactString } from "./redactSensitive.ts";
```

Replace lines 42–84 (the four exported functions) with:

```ts
export function logInfo(context: string, message: string): void {
    if (!shouldLog("info")) return;
    console.log(`[INFO]  [${context}] ${redactString(message)}`);
}

/**
 * Warning-level log. For recoverable issues that may need attention.
 * @param context - Short module/context tag
 * @param message - Human-readable message
 */
export function logWarn(context: string, message: string): void {
    if (!shouldLog("warn")) return;
    console.warn(`[WARN]  [${context}] ${redactString(message)}`);
}

/**
 * Render an unknown error as text (stack when available) so it can be
 * redacted before it reaches the console. Deno embeds full request URLs
 * (including `pot=`/`sig=` values) in fetch error messages.
 */
function describeError(err: unknown): string {
    if (err instanceof Error) {
        return err.stack ?? `${err.name}: ${err.message}`;
    }
    return String(err);
}

/**
 * Error-level log. For failures requiring investigation.
 * @param context - Short module/context tag
 * @param message - Human-readable message
 * @param err - Optional error object; rendered and redacted before printing
 */
export function logError(
    context: string,
    message: string,
    err?: unknown,
): void {
    if (!shouldLog("error")) return;
    const line = `[ERROR] [${context}] ${redactString(message)}`;
    if (err !== undefined) {
        console.error(line, redactString(describeError(err)));
    } else {
        console.error(line);
    }
}

/**
 * Debug-level log. Only shown when LOG_LEVEL=debug.
 * @param context - Short module/context tag
 * @param message - Human-readable message
 */
export function logDebug(context: string, message: string): void {
    if (!shouldLog("debug")) return;
    console.log(`[DEBUG] [${context}] ${redactString(message)}`);
}
```

(Keep the `logInfo` doc comment that precedes line 42 as is.)

- [ ] **Step 4: Run the logger test to verify it passes**

Run: `DENO_JOBS=1 deno test src/tests/log_test.ts $TEST_FLAGS`
Expected: `ok | 3 passed | 0 failed`

- [ ] **Step 5: Write the failing error-handler test**

Create `src/tests/errorHandler_test.ts`:

```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { assert, assertEquals } from "./deps.ts";
import { errorHandler } from "../routes/errorHandler.ts";

function captureConsoleError(fn: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
        lines.push(args.map((a) => String(a)).join(" "));
    };
    return fn().then(() => lines).finally(() => {
        console.error = original;
    });
}

function buildApp(): Hono {
    const app = new Hono();
    app.onError(errorHandler);
    app.get("/boom", () => {
        throw new Error(
            "error sending request for url (https://x/timedtext?pot=SECRETTOKEN)",
        );
    });
    app.get("/teapot", () => {
        throw new HTTPException(418, { res: new Response("short and stout") });
    });
    return app;
}

Deno.test("errorHandler returns a generic 500 and logs a redacted error", async () => {
    const app = buildApp();
    let res: Response | undefined;
    const lines = await captureConsoleError(async () => {
        res = await app.request("/boom");
    });
    assertEquals(res?.status, 500);
    assertEquals(await res?.text(), "Internal Server Error");
    assertEquals(lines.length, 1);
    assert(lines[0].includes("[ERROR] [SERVER]"));
    assert(lines[0].includes("GET /boom"));
    assert(!lines[0].includes("SECRETTOKEN"));
});

Deno.test("errorHandler passes HTTPException responses through unchanged", async () => {
    const app = buildApp();
    let res: Response | undefined;
    const lines = await captureConsoleError(async () => {
        res = await app.request("/teapot");
    });
    assertEquals(res?.status, 418);
    assertEquals(await res?.text(), "short and stout");
    assertEquals(lines.length, 0);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `DENO_JOBS=1 deno test src/tests/errorHandler_test.ts $TEST_FLAGS`
Expected: FAIL at type-check / module resolution: `Module not found "file:///.../src/routes/errorHandler.ts"`.

- [ ] **Step 7: Create the error handler**

Create `src/routes/errorHandler.ts`:

```ts
import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { CTX, logError } from "../lib/helpers/log.ts";

/**
 * Hono `onError` handler for both Hono apps.
 *
 * HTTPExceptions are deliberate responses (400/403/503/…) and pass through
 * untouched, so the Invidious contract is unchanged. Anything else is an
 * unexpected failure: it is logged through the redacting logger (Hono's
 * default handler would `console.error` the raw error, and Deno embeds full
 * request URLs — including `pot=` values — in fetch errors) and answered
 * with the same generic body Hono's default produces.
 */
export const errorHandler: ErrorHandler = (err, c) => {
    if (err instanceof HTTPException) {
        return err.getResponse();
    }
    const path = new URL(c.req.url).pathname;
    logError(
        CTX.SERVER,
        `Unhandled error on ${c.req.method} ${path}`,
        err,
    );
    return c.text("Internal Server Error", 500);
};
```

- [ ] **Step 8: Run the error-handler test to verify it passes**

Run: `DENO_JOBS=1 deno test src/tests/errorHandler_test.ts $TEST_FLAGS`
Expected: `ok | 2 passed | 0 failed`

- [ ] **Step 9: Register the handler on both apps in `main.ts`**

In `src/main.ts`, add after line 19 (`import { CTX, logError, logInfo, logWarn } from "./lib/helpers/log.ts";`):

```ts
import { errorHandler } from "./routes/errorHandler.ts";
```

Add after line 55 (`const metrics = config.server.enable_metrics ? new Metrics() : undefined;`):

```ts
// Unexpected errors must never reach Hono's default handler, which prints
// the raw error (and with it any URL-embedded PO token) to the console.
app.onError(errorHandler);
companionApp.onError(errorHandler);
```

- [ ] **Step 10: Run project checks, the full suite, and commit**

```bash
deno task format && deno task check && deno task lint
SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test
git add src/lib/helpers/log.ts src/routes/errorHandler.ts src/main.ts src/tests/log_test.ts src/tests/errorHandler_test.ts
git commit -m "fix: redact all log output and handle unexpected route errors without leaking tokens"
```

Expected test summary: `ok | N passed | 0 failed` (N = previous count + 5).

---

### Task 3: Validate the caption track host before attaching a PO token (C3)

**Files:**
- Modify: `src/lib/helpers/youtubeTranscriptsHandling.ts:1-4, 46-79`
- Test: `src/tests/youtubeTranscriptsHandling_test.ts` (new)

**Interfaces:**
- Consumes: `HTTPException` from `hono/http-exception`; `CTX`, `logWarn` from `log.ts`.
- Produces: new export `buildCaptionUrl(baseUrl: string, poToken: string, clientName: string): URL` (throws `HTTPException(502)` with body `"Invalid caption track URL."` when `baseUrl` is not `https://www.youtube.com/...`). `handleTranscripts` signature unchanged.

- [ ] **Step 1: Write the failing test**

Create `src/tests/youtubeTranscriptsHandling_test.ts`:

```ts
import { HTTPException } from "hono/http-exception";
import { assertEquals, assertThrows } from "./deps.ts";
import { buildCaptionUrl } from "../lib/helpers/youtubeTranscriptsHandling.ts";

const VALID_BASE =
    "https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw&lang=en&caps=asr";

function assertRejectedWith502(baseUrl: string) {
    const err = assertThrows(
        () => buildCaptionUrl(baseUrl, "POT", "WEB"),
        HTTPException,
    );
    assertEquals(err.status, 502);
}

Deno.test("buildCaptionUrl keeps the original query and adds pot parameters", () => {
    const url = buildCaptionUrl(VALID_BASE, "POT123", "WEB");
    assertEquals(url.hostname, "www.youtube.com");
    assertEquals(url.pathname, "/api/timedtext");
    assertEquals(url.searchParams.get("v"), "jNQXAC9IVRw");
    assertEquals(url.searchParams.get("lang"), "en");
    assertEquals(url.searchParams.get("fmt"), "vtt");
    assertEquals(url.searchParams.get("potc"), "1");
    assertEquals(url.searchParams.get("pot"), "POT123");
    assertEquals(url.searchParams.get("c"), "WEB");
});

Deno.test("buildCaptionUrl works for a base URL without a query string", () => {
    const url = buildCaptionUrl("https://www.youtube.com/api/timedtext", "P", "WEB");
    assertEquals(url.search, "?fmt=vtt&potc=1&pot=P&c=WEB");
});

Deno.test("buildCaptionUrl rejects a foreign host", () => {
    assertRejectedWith502("https://evil.example/api/timedtext?v=abc");
});

Deno.test("buildCaptionUrl rejects a look-alike host", () => {
    assertRejectedWith502("https://www.youtube.com.evil.example/api/timedtext");
});

Deno.test("buildCaptionUrl rejects plain http", () => {
    assertRejectedWith502("http://www.youtube.com/api/timedtext?v=abc");
});

Deno.test("buildCaptionUrl rejects an unparsable URL", () => {
    assertRejectedWith502("not a url");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `DENO_JOBS=1 deno test src/tests/youtubeTranscriptsHandling_test.ts $TEST_FLAGS`
Expected: FAIL at type-check: `Module '".../youtubeTranscriptsHandling.ts"' has no exported member 'buildCaptionUrl'`.

- [ ] **Step 3: Implement `buildCaptionUrl` and use it**

In `src/lib/helpers/youtubeTranscriptsHandling.ts`, replace lines 1–4 (the imports) with:

```ts
import { Innertube } from "youtubei.js";
import type { CaptionTrackData } from "youtubei.js/PlayerCaptionsTracklist";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { CTX, logWarn } from "./log.ts";

// The only origin a caption track's base_url may point at. The URL comes
// from the (cacheable) player response; without this check a manipulated
// response could receive a freshly minted, video-bound PO token.
const CAPTIONS_ALLOWED_HOST = "www.youtube.com";
const INVALID_CAPTION_URL_MESSAGE = "Invalid caption track URL.";
```

Add this exported function directly before `export async function handleTranscripts(` (after `shiftVttToCenter`):

```ts
/**
 * Build the timedtext URL for a caption track, attaching the PO token only
 * after confirming the track really points at YouTube.
 */
export function buildCaptionUrl(
    baseUrl: string,
    poToken: string,
    clientName: string,
): URL {
    let url: URL;
    try {
        url = new URL(baseUrl);
    } catch {
        throw new HTTPException(502, {
            res: new Response(INVALID_CAPTION_URL_MESSAGE),
        });
    }
    if (url.protocol !== "https:" || url.hostname !== CAPTIONS_ALLOWED_HOST) {
        throw new HTTPException(502, {
            res: new Response(INVALID_CAPTION_URL_MESSAGE),
        });
    }
    url.searchParams.set("fmt", "vtt");
    url.searchParams.set("potc", "1");
    url.searchParams.set("pot", poToken);
    url.searchParams.set("c", clientName);
    return url;
}
```

Replace the `if (poToken && clientName) { … }` branch of `handleTranscripts` (lines 53–79 of the original file, from `const baseUrl = selectedCaption.base_url;` through `return vttText;`) with:

```ts
        const url = buildCaptionUrl(
            selectedCaption.base_url,
            poToken,
            clientName,
        );

        let response: Response;
        try {
            response = await innertubeClient.session.http.fetch(url, {
                method: "GET",
            });
        } catch (err) {
            // Never let the raw fetch error escape: Deno embeds the full URL
            // (including pot=) in its message.
            logWarn(
                CTX.CAPTIONS,
                `Caption fetch failed for ${videoId}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            throw new HTTPException(502, {
                res: new Response("Failed to fetch captions."),
            });
        }

        if (!response.ok) {
            throw new HTTPException(response.status as ContentfulStatusCode, {
                res: new Response("Failed to fetch captions."),
            });
        }

        const vttText = await response.text();

        if (!vttText.startsWith("WEBVTT")) {
            throw new HTTPException(404, {
                res: new Response("No valid captions found."),
            });
        }

        return shiftVttToCenter(vttText);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `DENO_JOBS=1 deno test src/tests/youtubeTranscriptsHandling_test.ts $TEST_FLAGS`
Expected: `ok | 6 passed | 0 failed`

- [ ] **Step 5: Run project checks and commit**

```bash
deno task format && deno task check && deno task lint
git add src/lib/helpers/youtubeTranscriptsHandling.ts src/tests/youtubeTranscriptsHandling_test.ts
git commit -m "fix: only send caption PO tokens to www.youtube.com and bound fetch errors"
```

---

### Task 4: Single AES-GCM helper shared by `encryptQuery` and `verifyRequest`, with contract round-trip tests (C11, E1 part)

**Files:**
- Create: `src/lib/helpers/crypto.ts`
- Modify: `src/lib/helpers/encryptQuery.ts` (whole file)
- Modify: `src/lib/helpers/verifyRequest.ts` (whole file)
- Create: `src/tests/helpers/testConfig.ts`
- Create: `src/tests/helpers/check.ts`
- Test: `src/tests/crypto_test.ts` (new), `src/tests/verifyRequest_test.ts` (new)

**Interfaces:**
- Produces (`crypto.ts`): `deriveAesKey(secretKey: string): Promise<CryptoKey>`, `encryptGcm(plaintext: string, config: Config): Promise<Uint8Array>` (returns `IV[12] || ciphertext || tag[16]`), `decryptGcm(bytes: Uint8Array, config: Config): Promise<string>` (throws on tamper/short input).
- Produces (`testConfig.ts`): `TEST_SECRET_KEY = "aaaaaaaaaaaaaaaa"`, `makeTestConfig(overrides?: { server?: Record<string, unknown>; [section: string]: unknown }): Config`.
- Produces (`check.ts`): `makeCheck(videoId: string, config: Config, timestampSeconds?: number): Promise<string>` — base64url `check` exactly as `invidious_companion_encrypt` in `../invidious/src/invidious/helpers/utils.cr` produces it.
- `encryptQuery`, `decryptQuery`, `verifyRequest` keep their signatures. Wire format unchanged: `base64(IV[12] || ciphertext || tag[16])`, key = SHA-256(secret_key).

- [ ] **Step 1: Create the test config helper**

Create `src/tests/helpers/testConfig.ts`:

```ts
import { type Config, ConfigSchema } from "../../lib/helpers/config.ts";

export const TEST_SECRET_KEY = "aaaaaaaaaaaaaaaa";

/**
 * Build a fully-defaulted Config for unit tests without touching env vars
 * or the filesystem. `overrides` is merged one level deep for `server`
 * (so the secret key is always present) and spread as-is for every other
 * top-level section.
 */
export function makeTestConfig(
    overrides: { server?: Record<string, unknown>; [section: string]: unknown } =
        {},
): Config {
    const { server, ...rest } = overrides;
    return ConfigSchema.parse({
        ...rest,
        server: { secret_key: TEST_SECRET_KEY, ...(server ?? {}) },
    });
}
```

- [ ] **Step 2: Write the failing crypto and verify tests**

Create `src/tests/crypto_test.ts`:

```ts
import { assert, assertEquals, assertRejects } from "./deps.ts";
import { decryptGcm, encryptGcm } from "../lib/helpers/crypto.ts";
import { decryptQuery, encryptQuery } from "../lib/helpers/encryptQuery.ts";
import { makeTestConfig } from "./helpers/testConfig.ts";

const config = makeTestConfig();

Deno.test("encryptGcm output is IV(12) + ciphertext + tag(16)", async () => {
    const plaintext = "hello";
    const bytes = await encryptGcm(plaintext, config);
    assertEquals(bytes.length, 12 + plaintext.length + 16);
});

Deno.test("decryptGcm round-trips encryptGcm output", async () => {
    const bytes = await encryptGcm('[["pot","abc"],["ip","1.2.3.4"]]', config);
    assertEquals(
        await decryptGcm(bytes, config),
        '[["pot","abc"],["ip","1.2.3.4"]]',
    );
});

Deno.test("two encryptions of the same plaintext differ (random IV)", async () => {
    const a = await encryptGcm("same", config);
    const b = await encryptGcm("same", config);
    assert(a.join(",") !== b.join(","));
});

Deno.test("decryptGcm rejects a tampered byte", async () => {
    const bytes = await encryptGcm("payload", config);
    const tampered = Uint8Array.from(bytes);
    tampered[tampered.length - 1] ^= 0x01;
    await assertRejects(() => decryptGcm(tampered, config));
});

Deno.test("decryptGcm rejects input shorter than an IV", async () => {
    await assertRejects(
        () => decryptGcm(new Uint8Array(5), config),
        Error,
        "Ciphertext too short",
    );
});

Deno.test("decryptGcm rejects a different secret key", async () => {
    const bytes = await encryptGcm("payload", config);
    const other = makeTestConfig({ server: { secret_key: "bbbbbbbbbbbbbbbb" } });
    await assertRejects(() => decryptGcm(bytes, other));
});

Deno.test("encryptQuery/decryptQuery round-trip via base64", async () => {
    const encrypted = await encryptQuery("pot=abc&ip=1.2.3.4", config);
    assert(encrypted.length > 0);
    assertEquals(await decryptQuery(encrypted, config), "pot=abc&ip=1.2.3.4");
});

Deno.test("decryptQuery returns an empty string on garbage input", async () => {
    assertEquals(await decryptQuery("not-base64!!", config), "");
});
```

Create `src/tests/helpers/check.ts`:

```ts
import { encodeBase64 } from "@std/encoding/base64";
import type { Config } from "../../lib/helpers/config.ts";
import { encryptGcm } from "../../lib/helpers/crypto.ts";

/**
 * Build a `check` token the way Invidious does
 * (`invidious_companion_encrypt` in ../invidious/src/invidious/helpers/utils.cr):
 * plaintext "<unix seconds>|<videoId>", AES-256-GCM with the SHA-256-stretched
 * secret, layout IV[12] || ciphertext || tag[16], base64url with padding.
 */
export async function makeCheck(
    videoId: string,
    config: Config,
    timestampSeconds: number = Math.round(Date.now() / 1000),
): Promise<string> {
    const bytes = await encryptGcm(`${timestampSeconds}|${videoId}`, config);
    return encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_");
}
```

Create `src/tests/verifyRequest_test.ts`:

```ts
import { assert, assertEquals } from "./deps.ts";
import { verifyRequest } from "../lib/helpers/verifyRequest.ts";
import { encryptGcm } from "../lib/helpers/crypto.ts";
import { encodeBase64 } from "@std/encoding/base64";
import { makeTestConfig } from "./helpers/testConfig.ts";
import { makeCheck } from "./helpers/check.ts";

const config = makeTestConfig();
const VIDEO_ID = "jNQXAC9IVRw";
const nowSeconds = () => Math.round(Date.now() / 1000);

Deno.test("verifyRequest accepts a fresh check for the right video", async () => {
    const check = await makeCheck(VIDEO_ID, config);
    assertEquals(await verifyRequest(check, VIDEO_ID, config), true);
});

Deno.test("verifyRequest rejects a check for a different video", async () => {
    const check = await makeCheck(VIDEO_ID, config);
    assertEquals(await verifyRequest(check, "dQw4w9WgXcQ", config), false);
});

Deno.test("verifyRequest rejects a check older than six hours", async () => {
    const check = await makeCheck(
        VIDEO_ID,
        config,
        nowSeconds() - 6 * 60 * 60 - 60,
    );
    assertEquals(await verifyRequest(check, VIDEO_ID, config), false);
});

Deno.test("verifyRequest accepts a check five hours old", async () => {
    const check = await makeCheck(VIDEO_ID, config, nowSeconds() - 5 * 60 * 60);
    assertEquals(await verifyRequest(check, VIDEO_ID, config), true);
});

Deno.test("verifyRequest rejects a check more than five minutes in the future", async () => {
    const check = await makeCheck(VIDEO_ID, config, nowSeconds() + 10 * 60);
    assertEquals(await verifyRequest(check, VIDEO_ID, config), false);
});

Deno.test("verifyRequest tolerates two minutes of clock skew", async () => {
    const check = await makeCheck(VIDEO_ID, config, nowSeconds() + 2 * 60);
    assertEquals(await verifyRequest(check, VIDEO_ID, config), true);
});

Deno.test("verifyRequest rejects a tampered token", async () => {
    const check = await makeCheck(VIDEO_ID, config);
    const flipped = check.slice(0, -2) + (check.at(-2) === "A" ? "B" : "A") +
        check.slice(-1);
    assertEquals(await verifyRequest(flipped, VIDEO_ID, config), false);
});

Deno.test("verifyRequest rejects a non-integer timestamp", async () => {
    const bytes = await encryptGcm(`123abc|${VIDEO_ID}`, config);
    const check = encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_");
    assertEquals(await verifyRequest(check, VIDEO_ID, config), false);
});

Deno.test("verifyRequest rejects a token with no separator", async () => {
    const bytes = await encryptGcm(`${nowSeconds()}${VIDEO_ID}`, config);
    const check = encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_");
    assertEquals(await verifyRequest(check, VIDEO_ID, config), false);
});

Deno.test("verifyRequest rejects garbage input", async () => {
    assertEquals(await verifyRequest("", VIDEO_ID, config), false);
    assertEquals(await verifyRequest("%%%", VIDEO_ID, config), false);
});

Deno.test("verifyRequest accepts base64url tokens containing - and _", async () => {
    // Random IVs mean a token with URL-safe substitutions shows up within
    // a handful of attempts; loop until one does.
    let check = "";
    for (let i = 0; i < 200; i++) {
        check = await makeCheck(VIDEO_ID, config);
        if (check.includes("-") || check.includes("_")) break;
    }
    assert(check.includes("-") || check.includes("_"));
    assertEquals(await verifyRequest(check, VIDEO_ID, config), true);
});
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `DENO_JOBS=1 deno test src/tests/crypto_test.ts src/tests/verifyRequest_test.ts $TEST_FLAGS`
Expected: FAIL at type-check: `Module not found "file:///.../src/lib/helpers/crypto.ts"`.

- [ ] **Step 4: Create `crypto.ts`**

Create `src/lib/helpers/crypto.ts`:

```ts
import type { Config } from "./config.ts";

/**
 * AES-256-GCM primitives shared by encryptQuery.ts and verifyRequest.ts.
 *
 * Wire layout (must stay byte-for-byte compatible with
 * `invidious_companion_encrypt` in ../invidious/src/invidious/helpers/utils.cr):
 *   IV[12] || ciphertext || authTag[16]
 * Key: SHA-256(secret_key) — stretches the 16-char secret to 256 bits.
 */

const AES_GCM_IV_LENGTH = 12;

let cachedKey: CryptoKey | null = null;
let cachedKeySource = "";

/** Derive (and memoise) the AES-GCM key for a secret. */
export async function deriveAesKey(secretKey: string): Promise<CryptoKey> {
    if (cachedKey && cachedKeySource === secretKey) {
        return cachedKey;
    }
    const keyMaterial = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(secretKey),
    );
    const key = await crypto.subtle.importKey(
        "raw",
        keyMaterial,
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"],
    );
    cachedKey = key;
    cachedKeySource = secretKey;
    return key;
}

/** Encrypt `plaintext`; returns IV || ciphertext || tag as raw bytes. */
export async function encryptGcm(
    plaintext: string,
    config: Config,
): Promise<Uint8Array> {
    const key = await deriveAesKey(config.server.secret_key);
    const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH));
    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(plaintext),
    );
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return combined;
}

/** Decrypt IV || ciphertext || tag. Throws on tampering or a wrong key. */
export async function decryptGcm(
    bytes: Uint8Array,
    config: Config,
): Promise<string> {
    if (bytes.length <= AES_GCM_IV_LENGTH) {
        throw new Error("Ciphertext too short");
    }
    const key = await deriveAesKey(config.server.secret_key);
    const iv = bytes.slice(0, AES_GCM_IV_LENGTH);
    const ciphertext = bytes.slice(AES_GCM_IV_LENGTH);
    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        ciphertext,
    );
    return new TextDecoder().decode(decrypted);
}
```

- [ ] **Step 5: Rewrite `encryptQuery.ts` on top of it**

Replace the whole of `src/lib/helpers/encryptQuery.ts` with:

```ts
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import type { Config } from "./config.ts";
import { CTX, logError } from "./log.ts";
import { decryptGcm, encryptGcm } from "./crypto.ts";

/**
 * Encrypt query parameters using AES-256-GCM.
 *
 * Ciphertext format: base64( IV[12] || ciphertext || authTag[16] ), see
 * crypto.ts. Returns "" on failure (Task 5 of the security plan changes
 * this to throw).
 */
export const encryptQuery = async (
    queryParams: string,
    config: Config,
): Promise<string> => {
    try {
        return encodeBase64(await encryptGcm(queryParams, config));
    } catch (err) {
        logError(CTX.ENCRYPT, "Failed to encrypt query parameters", err);
        return "";
    }
};

/**
 * Decrypt a value produced by encryptQuery. Returns "" on any failure
 * (malformed base64, tampered data, wrong key); callers treat "" as 400.
 */
export const decryptQuery = async (
    queryParams: string,
    config: Config,
): Promise<string> => {
    try {
        return await decryptGcm(decodeBase64(queryParams), config);
    } catch (err) {
        logError(CTX.ENCRYPT, "Failed to decrypt query parameters", err);
        return "";
    }
};
```

- [ ] **Step 6: Rewrite `verifyRequest.ts` on top of it**

Replace the whole of `src/lib/helpers/verifyRequest.ts` with:

```ts
import { decodeBase64 } from "@std/encoding/base64";
import type { Config } from "./config.ts";
import { decryptGcm } from "./crypto.ts";

/**
 * Verify the `check` query parameter Invidious attaches to companion
 * requests. The token is base64url( IV[12] || ciphertext || authTag[16] )
 * of "<unix seconds>|<videoId>" (see crypto.ts for the key derivation).
 *
 * Replay protection: tokens older than MAX_CHECK_AGE_SECONDS or more than
 * MAX_CLOCK_SKEW_SECONDS in the future are rejected. Invidious signs once
 * per page render, so the 6 h window must not shrink without changing
 * Invidious in lockstep.
 */
const MAX_CHECK_AGE_SECONDS = 6 * 60 * 60;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

function base64UrlToStandard(value: string): string {
    const standard = value.replace(/-/g, "+").replace(/_/g, "/");
    const padding = (4 - (standard.length % 4)) % 4;
    return standard + "=".repeat(padding);
}

export const verifyRequest = async (
    stringToCheck: string,
    videoId: string,
    config: Config,
): Promise<boolean> => {
    let decryptedData: string;
    try {
        decryptedData = await decryptGcm(
            decodeBase64(base64UrlToStandard(stringToCheck)),
            config,
        );
    } catch {
        return false;
    }

    const separator = decryptedData.indexOf("|");
    if (separator === -1) {
        return false;
    }
    const parsedTimestamp = Number(decryptedData.slice(0, separator));
    const parsedVideoId = decryptedData.slice(separator + 1);

    if (parsedVideoId !== videoId) {
        return false;
    }
    // Number("123abc") is NaN; parseInt would have accepted it as 123.
    if (!Number.isInteger(parsedTimestamp)) {
        return false;
    }

    const timestampNow = Math.round(Date.now() / 1000);
    if (timestampNow - parsedTimestamp > MAX_CHECK_AGE_SECONDS) {
        return false;
    }
    if (parsedTimestamp - timestampNow > MAX_CLOCK_SKEW_SECONDS) {
        return false;
    }
    return true;
};
```

- [ ] **Step 7: Run both test files to verify they pass**

Run: `DENO_JOBS=1 deno test src/tests/crypto_test.ts src/tests/verifyRequest_test.ts $TEST_FLAGS`
Expected: `ok | 19 passed | 0 failed`

- [ ] **Step 8: Run project checks, the full suite, and commit**

```bash
deno task format && deno task check && deno task lint
SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test
git add src/lib/helpers/crypto.ts src/lib/helpers/encryptQuery.ts src/lib/helpers/verifyRequest.ts src/tests/helpers/testConfig.ts src/tests/helpers/check.ts src/tests/crypto_test.ts src/tests/verifyRequest_test.ts
git commit -m "refactor: share AES-GCM key derivation and add contract tests for encrypt/verify"
```

---

### Task 5: `encryptQuery` fails loudly; routes answer 500 instead of redirecting with an empty payload (C6)

**Files:**
- Modify: `src/lib/helpers/encryptQuery.ts:12-24`
- Modify: `src/routes/invidious_routes/latestVersion.ts:109-124`
- Modify: `src/routes/invidious_routes/dashManifest.ts:107-112`
- Test: `src/tests/crypto_test.ts` (extend)

**Interfaces:**
- `encryptQuery(queryParams: string, config: Config): Promise<string>` now **throws** `Error("Query encryption failed")` after logging; never returns `""`.
- Routes: new failure response `500` with body `"Failed to encrypt query."` (only reachable when Web Crypto fails; the success path is unchanged).

- [ ] **Step 1: Write the failing test**

Append to `src/tests/crypto_test.ts`:

```ts
Deno.test("encryptQuery throws when the crypto primitive fails", async () => {
    const original = crypto.subtle.encrypt;
    Object.defineProperty(crypto.subtle, "encrypt", {
        value: () => Promise.reject(new Error("simulated crypto failure")),
        configurable: true,
        writable: true,
    });
    try {
        await assertRejects(
            () => encryptQuery("pot=abc", config),
            Error,
            "Query encryption failed",
        );
    } finally {
        Object.defineProperty(crypto.subtle, "encrypt", {
            value: original,
            configurable: true,
            writable: true,
        });
    }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `DENO_JOBS=1 deno test src/tests/crypto_test.ts $TEST_FLAGS`
Expected: 1 failed: `AssertionError: Expected function to reject.` (current `encryptQuery` swallows the error and returns `""`).

- [ ] **Step 3: Make `encryptQuery` throw**

In `src/lib/helpers/encryptQuery.ts`, replace the `encryptQuery` definition (the doc comment and function, lines 6–24 of the file written in Task 4) with:

```ts
/**
 * Encrypt query parameters using AES-256-GCM.
 *
 * Ciphertext format: base64( IV[12] || ciphertext || authTag[16] ), see
 * crypto.ts. Throws on failure: a silent "" would let callers redirect the
 * client to a URL with no PO token and surface as a confusing 400 later.
 */
export const encryptQuery = async (
    queryParams: string,
    config: Config,
): Promise<string> => {
    try {
        return encodeBase64(await encryptGcm(queryParams, config));
    } catch (err) {
        logError(CTX.ENCRYPT, "Failed to encrypt query parameters", err);
        throw new Error("Query encryption failed");
    }
};
```

- [ ] **Step 4: Handle the failure in `latestVersion.ts`**

In `src/routes/invidious_routes/latestVersion.ts`, replace lines 113–116:

```ts
                const encryptedParams = await encryptQuery(
                    JSON.stringify(privateParams),
                    config,
                );
```

with:

```ts
                let encryptedParams: string;
                try {
                    encryptedParams = await encryptQuery(
                        JSON.stringify(privateParams),
                        config,
                    );
                } catch {
                    throw new HTTPException(500, {
                        res: new Response("Failed to encrypt query."),
                    });
                }
```

- [ ] **Step 5: Handle the failure in `dashManifest.ts`**

In `src/routes/invidious_routes/dashManifest.ts`, replace lines 107–112:

```ts
                if (privateParams.length > 0) {
                    preEncryptedParams = await encryptQuery(
                        JSON.stringify(privateParams),
                        config,
                    );
                }
```

with:

```ts
                if (privateParams.length > 0) {
                    try {
                        preEncryptedParams = await encryptQuery(
                            JSON.stringify(privateParams),
                            config,
                        );
                    } catch {
                        throw new HTTPException(500, {
                            res: new Response("Failed to encrypt query."),
                        });
                    }
                }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `DENO_JOBS=1 deno test src/tests/crypto_test.ts $TEST_FLAGS`
Expected: `ok | 9 passed | 0 failed`

- [ ] **Step 7: Run project checks and commit**

```bash
deno task format && deno task check && deno task lint
git add src/lib/helpers/encryptQuery.ts src/routes/invidious_routes/latestVersion.ts src/routes/invidious_routes/dashManifest.ts src/tests/crypto_test.ts
git commit -m "fix: fail with 500 instead of redirecting to an unencrypted URL when encryption fails"
```

---

### Task 6: Extract the request guard chain into `routes/guards.ts` and use it in all four routes (C5)

**Files:**
- Create: `src/routes/guards.ts`
- Modify: `src/lib/helpers/metrics.ts:139` (add `verifyRequestFailures`)
- Modify: `src/routes/invidious_routes/captions.ts:1-12, 29-59`
- Modify: `src/routes/invidious_routes/latestVersion.ts:1-10, 26-54`
- Modify: `src/routes/invidious_routes/dashManifest.ts:1-11, 27-50`
- Modify: `src/routes/invidious_routes/download.ts:1-5, 25-45`
- Test: `src/tests/guards_test.ts` (new)

**Interfaces:**
- Produces (`guards.ts`):
  - `requireValidVideoId(videoId: string | undefined): string` → throws `HTTPException(400, "Invalid video ID format.")`.
  - `requireTokenMinter(c: GuardContext): void` → throws `HTTPException(503, TOKEN_MINTER_NOT_READY_MESSAGE)` when `config.jobs.youtube_session.po_token_enabled && !tokenMinter`.
  - `requireVerifiedCheck(c: GuardContext, videoId: string): Promise<void>` → no-op when `verify_requests` is false; throws `HTTPException(400, "No check ID.")` when the `check` query is absent; throws `HTTPException(400, "ID incorrect.")` when `verifyRequest` returns false (this now also covers an empty `check=` value, which the old inline code silently skipped).
  - `type GuardContext = Context<{ Variables: HonoVariables }>`.
- Produces (`metrics.ts`): `verifyRequestFailures: Counter`.
- Consumes: `verifyRequest`, `validateVideoId`, `TOKEN_MINTER_NOT_READY_MESSAGE`, `makeTestConfig`, `makeCheck` (Task 4).

- [ ] **Step 1: Write the failing test**

Create `src/tests/guards_test.ts`:

```ts
import { Hono } from "hono";
import { assertEquals } from "./deps.ts";
import {
    requireTokenMinter,
    requireValidVideoId,
    requireVerifiedCheck,
} from "../routes/guards.ts";
import type { HonoVariables } from "../lib/types/HonoVariables.ts";
import type { TokenMinter } from "../lib/jobs/potoken.ts";
import { TOKEN_MINTER_NOT_READY_MESSAGE } from "../constants.ts";
import { makeTestConfig } from "./helpers/testConfig.ts";
import { makeCheck } from "./helpers/check.ts";

const VIDEO_ID = "jNQXAC9IVRw";
const stubMinter = ((_videoId: string) =>
    Promise.resolve("pot")) as unknown as TokenMinter;

function buildApp(
    options: { verifyRequests: boolean; minter: TokenMinter | undefined },
) {
    const config = makeTestConfig({
        server: { verify_requests: options.verifyRequests },
    });
    const app = new Hono<{ Variables: HonoVariables }>();
    app.use("*", async (c, next) => {
        c.set("config", config);
        c.set("tokenMinter", options.minter);
        c.set("metrics", undefined);
        await next();
    });
    app.get("/g/:videoId", async (c) => {
        const videoId = requireValidVideoId(c.req.param("videoId"));
        requireTokenMinter(c);
        await requireVerifiedCheck(c, videoId);
        return c.text("ok");
    });
    return { app, config };
}

async function expect(
    res: Response,
    status: number,
    body: string,
) {
    assertEquals(res.status, status);
    assertEquals(await res.text(), body);
}

Deno.test("guards reject a malformed video id with 400", async () => {
    const { app } = buildApp({ verifyRequests: false, minter: stubMinter });
    await expect(
        await app.request("/g/not-a-valid-id!"),
        400,
        "Invalid video ID format.",
    );
});

Deno.test("guards answer 503 while the token minter is not ready", async () => {
    const { app } = buildApp({ verifyRequests: false, minter: undefined });
    await expect(
        await app.request(`/g/${VIDEO_ID}`),
        503,
        TOKEN_MINTER_NOT_READY_MESSAGE,
    );
});

Deno.test("guards skip verification when verify_requests is off", async () => {
    const { app } = buildApp({ verifyRequests: false, minter: stubMinter });
    await expect(await app.request(`/g/${VIDEO_ID}`), 200, "ok");
});

Deno.test("guards require a check parameter when verify_requests is on", async () => {
    const { app } = buildApp({ verifyRequests: true, minter: stubMinter });
    await expect(await app.request(`/g/${VIDEO_ID}`), 400, "No check ID.");
});

Deno.test("guards reject an empty check parameter", async () => {
    const { app } = buildApp({ verifyRequests: true, minter: stubMinter });
    await expect(
        await app.request(`/g/${VIDEO_ID}?check=`),
        400,
        "ID incorrect.",
    );
});

Deno.test("guards reject a check signed for another video", async () => {
    const { app, config } = buildApp({
        verifyRequests: true,
        minter: stubMinter,
    });
    const check = await makeCheck("dQw4w9WgXcQ", config);
    await expect(
        await app.request(`/g/${VIDEO_ID}?check=${check}`),
        400,
        "ID incorrect.",
    );
});

Deno.test("guards accept a valid check", async () => {
    const { app, config } = buildApp({
        verifyRequests: true,
        minter: stubMinter,
    });
    const check = await makeCheck(VIDEO_ID, config);
    await expect(await app.request(`/g/${VIDEO_ID}?check=${check}`), 200, "ok");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `DENO_JOBS=1 deno test src/tests/guards_test.ts $TEST_FLAGS`
Expected: FAIL at type-check: `Module not found "file:///.../src/routes/guards.ts"`.

- [ ] **Step 3: Add the metrics counter**

In `src/lib/helpers/metrics.ts`, add after the `blockTriggeredRegens` counter (after line 137):

```ts
    public verifyRequestFailures = this.createCounter(
        "verify_request_failures_total",
        "Number of requests rejected because the check parameter was missing or invalid",
    );
```

- [ ] **Step 4: Create `guards.ts`**

Create `src/routes/guards.ts`:

```ts
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { validateVideoId } from "../lib/helpers/validateVideoId.ts";
import { verifyRequest } from "../lib/helpers/verifyRequest.ts";
import { TOKEN_MINTER_NOT_READY_MESSAGE } from "../constants.ts";
import type { HonoVariables } from "../lib/types/HonoVariables.ts";

/**
 * Request guards shared by every Invidious-facing route. Each guard throws
 * the exact HTTPException the routes used to build inline, so status codes
 * and bodies stay byte-identical for Invidious. Call them in this order:
 *
 *   const videoId = requireValidVideoId(...);
 *   requireTokenMinter(c);
 *   await requireVerifiedCheck(c, videoId);
 */
export type GuardContext = Context<{ Variables: HonoVariables }>;

export function requireValidVideoId(videoId: string | undefined): string {
    if (!videoId || !validateVideoId(videoId)) {
        throw new HTTPException(400, {
            res: new Response("Invalid video ID format."),
        });
    }
    return videoId;
}

/** 503 while the PO-token minter is still bootstrapping (if PO tokens are on). */
export function requireTokenMinter(c: GuardContext): void {
    const config = c.get("config");
    if (config.jobs.youtube_session.po_token_enabled && !c.get("tokenMinter")) {
        throw new HTTPException(503, {
            res: new Response(TOKEN_MINTER_NOT_READY_MESSAGE),
        });
    }
}

/**
 * Enforce the signed `check` parameter when server.verify_requests is on.
 * An empty `check=` is treated as an invalid token (the old inline code
 * skipped verification for it).
 */
export async function requireVerifiedCheck(
    c: GuardContext,
    videoId: string,
): Promise<void> {
    const config = c.get("config");
    if (!config.server.verify_requests) {
        return;
    }
    const check = c.req.query("check");
    if (check == undefined) {
        c.get("metrics")?.verifyRequestFailures.inc();
        throw new HTTPException(400, {
            res: new Response("No check ID."),
        });
    }
    if (await verifyRequest(check, videoId, config) === false) {
        c.get("metrics")?.verifyRequestFailures.inc();
        throw new HTTPException(400, {
            res: new Response("ID incorrect."),
        });
    }
}
```

- [ ] **Step 5: Run the guards test to verify it passes**

Run: `DENO_JOBS=1 deno test src/tests/guards_test.ts $TEST_FLAGS`
Expected: `ok | 7 passed | 0 failed`

- [ ] **Step 6: Use the guards in `captions.ts`**

In `src/routes/invidious_routes/captions.ts`, replace the imports on lines 3, 11 and 12:

```ts
import { verifyRequest } from "../../lib/helpers/verifyRequest.ts";
```
```ts
import { validateVideoId } from "../../lib/helpers/validateVideoId.ts";
import { TOKEN_MINTER_NOT_READY_MESSAGE } from "../../constants.ts";
```

with a single import (keep the other imports):

```ts
import {
    requireTokenMinter,
    requireValidVideoId,
    requireVerifiedCheck,
} from "../guards.ts";
```

Replace lines 22–59 (from `const { videoId } = c.req.param();` through the closing `}` of the `verify_requests` `else if` block) with:

```ts
    const videoId = requireValidVideoId(c.req.param("videoId"));
    const config = c.get("config");
    const metrics = c.get("metrics");
    const tokenMinter = c.get("tokenMinter");

    // Fail early if captions are disabled by the administrator.
    if (!config.captions.enabled) {
        throw new HTTPException(503, {
            res: new Response("Captions are disabled by administrator."),
        });
    }

    requireTokenMinter(c);
    await requireVerifiedCheck(c, videoId);
```

- [ ] **Step 7: Use the guards in `latestVersion.ts`**

In `src/routes/invidious_routes/latestVersion.ts`, replace imports on lines 7, 9, 10:

```ts
import { verifyRequest } from "../../lib/helpers/verifyRequest.ts";
```
```ts
import { validateVideoId } from "../../lib/helpers/validateVideoId.ts";
import { TOKEN_MINTER_NOT_READY_MESSAGE } from "../../constants.ts";
```

with:

```ts
import {
    requireTokenMinter,
    requireValidVideoId,
    requireVerifiedCheck,
} from "../guards.ts";
```

Change line 14 from `const latestVersion = new Hono();` to:

```ts
const latestVersion = new Hono<{ Variables: HonoVariables }>();
```

and add `import type { HonoVariables } from "../../lib/types/HonoVariables.ts";` to the imports.

Replace lines 17–54 (from `const { check, itag, id, local, title } = c.req.query();` through the closing `}` of the `verify_requests` block) with:

```ts
    const { itag, id, local, title } = c.req.query();
    c.header("access-control-allow-origin", "*");

    if (!id || !itag) {
        throw new HTTPException(400, {
            res: new Response("Please specify the itag and video ID."),
        });
    }

    const videoId = requireValidVideoId(id);

    const innertubeClient = c.get("innertubeClient");
    const config = c.get("config");
    const metrics = c.get("metrics");
    const tokenMinter = c.get("tokenMinter");

    requireTokenMinter(c);
    await requireVerifiedCheck(c, videoId);
```

Then replace every later use of `id` in that handler with `videoId` (`videoId: id,` → `videoId,` in the `youtubePlayerParsing` call; the two `"…: " + id` message concatenations → `+ videoId`).

- [ ] **Step 8: Use the guards in `dashManifest.ts`**

In `src/routes/invidious_routes/dashManifest.ts`, replace imports on lines 7, 10, 11:

```ts
import { verifyRequest } from "../../lib/helpers/verifyRequest.ts";
```
```ts
import { validateVideoId } from "../../lib/helpers/validateVideoId.ts";
import { TOKEN_MINTER_NOT_READY_MESSAGE } from "../../constants.ts";
```

with:

```ts
import {
    requireTokenMinter,
    requireValidVideoId,
    requireVerifiedCheck,
} from "../guards.ts";
import type { HonoVariables } from "../../lib/types/HonoVariables.ts";
```

Change line 15 to `const dashManifest = new Hono<{ Variables: HonoVariables }>();`.

Replace lines 18–50 (from `const { videoId } = c.req.param();` through the closing `}` of the `verify_requests` block) with:

```ts
    const videoId = requireValidVideoId(c.req.param("videoId"));
    const { local } = c.req.query();
    c.header("access-control-allow-origin", "*");

    const innertubeClient = c.get("innertubeClient");
    const config = c.get("config");
    const metrics = c.get("metrics");
    const tokenMinter = c.get("tokenMinter");

    requireTokenMinter(c);
    await requireVerifiedCheck(c, videoId);
```

- [ ] **Step 9: Use the guards in `download.ts` (adds the previously missing minter check)**

In `src/routes/invidious_routes/download.ts`, replace lines 4–5:

```ts
import { verifyRequest } from "../../lib/helpers/verifyRequest.ts";
import { validateVideoId } from "../../lib/helpers/validateVideoId.ts";
```

with:

```ts
import {
    requireTokenMinter,
    requireValidVideoId,
    requireVerifiedCheck,
} from "../guards.ts";
import type { HonoVariables } from "../../lib/types/HonoVariables.ts";
```

Change line 15 from `async function handler(c: Context) {` to:

```ts
    async function handler(c: Context<{ Variables: HonoVariables }>) {
```

Replace lines 18–45 (from `const videoId = body.get("id")?.toString();` through the closing `}` of the `verify_requests` block) with:

```ts
        const rawVideoId = body.get("id")?.toString();
        if (rawVideoId == undefined) {
            throw new HTTPException(400, {
                res: new Response("Please specify the video ID"),
            });
        }
        const videoId = requireValidVideoId(rawVideoId);

        const config = c.get("config");
        const check = c.req.query("check");

        requireTokenMinter(c);
        await requireVerifiedCheck(c, videoId);
```

- [ ] **Step 10: Run project checks, the full suite, and commit**

```bash
deno task format && deno task check && deno task lint
SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test
git add src/routes/guards.ts src/lib/helpers/metrics.ts src/routes/invidious_routes/captions.ts src/routes/invidious_routes/latestVersion.ts src/routes/invidious_routes/dashManifest.ts src/routes/invidious_routes/download.ts src/tests/guards_test.ts
git commit -m "refactor: share request guards across captions, latest_version, dash and download routes"
```

Expected: `deno task check` reports no errors (if `latestVersion.ts` still references `id` after Step 7, it will fail with `Cannot find name 'id'` — fix the remaining occurrences). Integration test `main_test.ts` still passes (`/latest_version` → 302).

---

### Task 7: Harden `/download` input handling (C7)

**Files:**
- Modify: `src/routes/invidious_routes/download.ts:7-16, 47-68`
- Test: `src/tests/download_test.ts` (new)

**Interfaces:**
- Consumes: `getDownloadHandler(app: Hono)` (unchanged signature), guards from Task 6, `makeTestConfig`.
- New failure responses: `400 "Invalid form data."` for a non-multipart body; `400 "Invalid form data required for download"` (existing message) now also for `title` longer than 256 chars or an `ext` not matching `/^[a-z0-9]{1,5}$/`. Invidious' download widget only sends fixed lowercase extensions (`mp4`, `webm`, `m4a`, `vtt`), so no valid Invidious request is rejected.

- [ ] **Step 1: Write the failing test**

Create `src/tests/download_test.ts`:

```ts
import { Hono } from "hono";
import { assert, assertEquals } from "./deps.ts";
import getDownloadHandler from "../routes/invidious_routes/download.ts";
import type { HonoVariables } from "../lib/types/HonoVariables.ts";
import type { TokenMinter } from "../lib/jobs/potoken.ts";
import { makeTestConfig } from "./helpers/testConfig.ts";

const VIDEO_ID = "jNQXAC9IVRw";
const stubMinter = ((_videoId: string) =>
    Promise.resolve("pot")) as unknown as TokenMinter;

function buildApp() {
    const config = makeTestConfig();
    const app = new Hono<{ Variables: HonoVariables }>();
    app.use("*", async (c, next) => {
        c.set("config", config);
        c.set("tokenMinter", stubMinter);
        c.set("metrics", undefined);
        await next();
    });
    // Stub the sibling routes the dispatcher forwards to; echo what they got.
    app.get("/companion/api/v1/captions/:videoId", (c) =>
        c.text(`captions ${c.req.param("videoId")} ${c.req.query("label")}`));
    app.get("/companion/latest_version", (c) =>
        c.text(`latest ${new URL(c.req.url).search}`));
    app.post("/companion/download", getDownloadHandler(app as unknown as Hono));
    return app;
}

function formRequest(fields: Record<string, string>): Request {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
        form.set(key, value);
    }
    return new Request("http://localhost/companion/download", {
        method: "POST",
        body: form,
    });
}

Deno.test("download rejects a non-multipart body with 400", async () => {
    const app = buildApp();
    const res = await app.request("http://localhost/companion/download", {
        method: "POST",
        body: "x",
        headers: { "content-type": "text/plain" },
    });
    assertEquals(res.status, 400);
    assertEquals(await res.text(), "Invalid form data.");
});

Deno.test("download requires the video id", async () => {
    const app = buildApp();
    const res = await app.request(formRequest({ title: "t" }));
    assertEquals(res.status, 400);
    assertEquals(await res.text(), "Please specify the video ID");
});

Deno.test("download dispatches a caption label to the captions route", async () => {
    const app = buildApp();
    const res = await app.request(formRequest({
        id: VIDEO_ID,
        title: "My Video",
        download_widget: JSON.stringify({ label: "English", ext: "vtt" }),
    }));
    assertEquals(res.status, 200);
    assertEquals(await res.text(), `captions ${VIDEO_ID} English`);
});

Deno.test("download dispatches an itag to latest_version with local=true", async () => {
    const app = buildApp();
    const res = await app.request(formRequest({
        id: VIDEO_ID,
        title: "My Video",
        download_widget: JSON.stringify({ itag: 18, ext: "mp4" }),
    }));
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.startsWith("latest ?"));
    const params = new URLSearchParams(body.slice("latest ".length));
    assertEquals(params.get("id"), VIDEO_ID);
    assertEquals(params.get("itag"), "18");
    assertEquals(params.get("local"), "true");
    assertEquals(params.get("title"), `My Video-${VIDEO_ID}.mp4`);
});

Deno.test("download rejects an extension with unexpected characters", async () => {
    const app = buildApp();
    const res = await app.request(formRequest({
        id: VIDEO_ID,
        title: "My Video",
        download_widget: JSON.stringify({ itag: 18, ext: 'mp4"; x=' }),
    }));
    assertEquals(res.status, 400);
    assertEquals(await res.text(), "Invalid form data required for download");
});

Deno.test("download rejects an over-long title", async () => {
    const app = buildApp();
    const res = await app.request(formRequest({
        id: VIDEO_ID,
        title: "x".repeat(300),
        download_widget: JSON.stringify({ itag: 18, ext: "mp4" }),
    }));
    assertEquals(res.status, 400);
    assertEquals(await res.text(), "Invalid form data required for download");
});

Deno.test("download rejects unparsable download_widget json", async () => {
    const app = buildApp();
    const res = await app.request(formRequest({
        id: VIDEO_ID,
        title: "t",
        download_widget: "{not json",
    }));
    assertEquals(res.status, 400);
    assertEquals(await res.text(), "Invalid download_widget json");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `DENO_JOBS=1 deno test src/tests/download_test.ts $TEST_FLAGS`
Expected: FAILED — "rejects a non-multipart body" gets a 500 (unhandled `formData()` error), "rejects an extension…" and "rejects an over-long title" get 200 instead of 400. The dispatch tests pass already.

- [ ] **Step 3: Tighten the schema and guard `formData()`**

In `src/routes/invidious_routes/download.ts`, replace lines 7–12 (schema and type) with:

```ts
// Invidious' download widget sends fixed lowercase extensions (mp4, webm,
// m4a, vtt); anything else would be spliced into a filename / query param.
const ExtensionSchema = z.string().regex(/^[a-z0-9]{1,5}$/);
const MAX_TITLE_LENGTH = 256;

const DownloadWidgetSchema = z.union([
    z.object({ label: z.string().min(1).max(256), ext: ExtensionSchema })
        .strict(),
    z.object({ itag: z.number().int().positive(), ext: ExtensionSchema })
        .strict(),
]);

type DownloadWidget = z.infer<typeof DownloadWidgetSchema>;
```

Replace the first line of the handler body (`const body = await c.req.formData();`) with:

```ts
        let body: FormData;
        try {
            body = await c.req.formData();
        } catch {
            throw new HTTPException(400, {
                res: new Response("Invalid form data."),
            });
        }
```

Replace the block from `const title = body.get("title");` through the `if (!(title && videoId && …)) { … }` guard with:

```ts
        const title = body.get("title")?.toString();

        let downloadWidgetData: DownloadWidget;

        try {
            downloadWidgetData = JSON.parse(
                body.get("download_widget")?.toString() || "",
            );
        } catch {
            throw new HTTPException(400, {
                res: new Response("Invalid download_widget json"),
            });
        }

        const isValidTitle = !!title && title.length <= MAX_TITLE_LENGTH;
        if (
            !isValidTitle ||
            !DownloadWidgetSchema.safeParse(downloadWidgetData).success
        ) {
            throw new HTTPException(400, {
                res: new Response("Invalid form data required for download"),
            });
        }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `DENO_JOBS=1 deno test src/tests/download_test.ts $TEST_FLAGS`
Expected: `ok | 7 passed | 0 failed`

- [ ] **Step 5: Run project checks and commit**

```bash
deno task format && deno task check && deno task lint
git add src/routes/invidious_routes/download.ts src/tests/download_test.ts
git commit -m "fix: validate download form body, title length and extension"
```

---

### Task 8: Inbound per-client-IP rate limiting (C4)

**Files:**
- Modify: `src/lib/helpers/config.ts:79-82` (inside `server`)
- Modify: `src/lib/helpers/metrics.ts` (add `rateLimitRejections`)
- Create: `src/routes/rateLimit.ts`
- Modify: `src/main.ts:413` (register middleware)
- Modify: `config/config.example.toml:24`, `README.md:112`
- Test: `src/tests/rateLimit_test.ts` (new), `src/tests/config_additions_test.ts` (extend)

**Interfaces:**
- Config: `server.trust_proxy: boolean` (env `SERVER_TRUST_PROXY`, default `false`); `server.rate_limit.enabled: boolean` (env `SERVER_RATE_LIMIT_ENABLED`, default `true`); `server.rate_limit.requests_per_minute: number` (env `SERVER_RATE_LIMIT_RPM`, default `120`, 1–100000); `server.rate_limit.burst: number` (env `SERVER_RATE_LIMIT_BURST`, default `60`, 1–100000).
- Produces (`rateLimit.ts`): `rateLimit(options: RateLimitOptions): MiddlewareHandler` with `RateLimitOptions = { requestsPerMinute: number; burst: number; trustProxy: boolean; metrics?: Metrics; now?: () => number }`; `clientIpFrom(c: Context, trustProxy: boolean): string`. Rejections: `429`, body `"Too many requests."`, header `retry-after: <seconds>`.
- Produces (`metrics.ts`): `rateLimitRejections: Counter`.

- [ ] **Step 1: Write the failing config test**

Append inside `Deno.test("Config validation additions", …)` in `src/tests/config_additions_test.ts`, before the final `});`:

```ts
    await t.step("inbound rate limit defaults are enabled, 120 rpm, burst 60", async () => {
        await withTempConfig(
            `[server]\nsecret_key = "1234567890abcdef"\n`,
            async () => {
                const config = await parseConfig();
                assertEquals(config.server.rate_limit.enabled, true);
                assertEquals(config.server.rate_limit.requests_per_minute, 120);
                assertEquals(config.server.rate_limit.burst, 60);
                assertEquals(config.server.trust_proxy, false);
            },
        );
    });

    await t.step("inbound rate limit can be tuned via TOML", async () => {
        await withTempConfig(
            `[server]\nsecret_key = "1234567890abcdef"\ntrust_proxy = true\n\n[server.rate_limit]\nenabled = false\nrequests_per_minute = 30\nburst = 5\n`,
            async () => {
                const config = await parseConfig();
                assertEquals(config.server.rate_limit.enabled, false);
                assertEquals(config.server.rate_limit.requests_per_minute, 30);
                assertEquals(config.server.rate_limit.burst, 5);
                assertEquals(config.server.trust_proxy, true);
            },
        );
    });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `DENO_JOBS=1 deno test src/tests/config_additions_test.ts $TEST_FLAGS`
Expected: 2 failed steps with `Property 'rate_limit' does not exist` (type-check) or a Zod `Unrecognized key(s) in object: 'trust_proxy'` error.

- [ ] **Step 3: Add the config keys**

In `src/lib/helpers/config.ts`, insert after the `enable_metrics` field (after line 82, before `}).strict().default({}),` that closes `server`):

```ts
        // Trust the first hop of X-Forwarded-For for client identification
        // (rate limiting). Only enable behind a reverse proxy you control.
        trust_proxy: z.boolean().default(
            Deno.env.get("SERVER_TRUST_PROXY") === "true",
        ),
        // Inbound per-client-IP token bucket. Companion routes are reachable
        // by end-user browsers (Invidious redirects to them), so an
        // unauthenticated client could otherwise burn the egress IP's
        // anti-bot budget by enumerating video IDs.
        rate_limit: z.object({
            enabled: z.boolean().default(
                Deno.env.get("SERVER_RATE_LIMIT_ENABLED") !== "false",
            ),
            requests_per_minute: z.number().int().min(1).max(100_000).default(
                envNumber("SERVER_RATE_LIMIT_RPM") ?? 120,
            ),
            burst: z.number().int().min(1).max(100_000).default(
                envNumber("SERVER_RATE_LIMIT_BURST") ?? 60,
            ),
        }).strict().default({}),
```

- [ ] **Step 4: Run the config test to verify it passes**

Run: `DENO_JOBS=1 deno test src/tests/config_additions_test.ts $TEST_FLAGS`
Expected: `ok | 1 passed (N steps) | 0 failed`

- [ ] **Step 5: Write the failing middleware test**

Create `src/tests/rateLimit_test.ts`:

```ts
import { Hono } from "hono";
import { assertEquals } from "./deps.ts";
import { rateLimit } from "../routes/rateLimit.ts";
import { Metrics } from "../lib/helpers/metrics.ts";

function buildApp(
    options: {
        requestsPerMinute: number;
        burst: number;
        trustProxy: boolean;
        metrics?: Metrics;
    },
    clock: { now: number },
) {
    const app = new Hono();
    app.use("*", rateLimit({ ...options, now: () => clock.now }));
    app.get("/x", (c) => c.text("ok"));
    return app;
}

const remoteEnv = (hostname: string) => ({
    remoteAddr: { hostname, port: 12345, transport: "tcp" },
});

Deno.test("rateLimit allows up to burst requests then answers 429", async () => {
    const clock = { now: 1_000_000 };
    const app = buildApp(
        { requestsPerMinute: 60, burst: 3, trustProxy: false },
        clock,
    );
    for (let i = 0; i < 3; i++) {
        const res = await app.request("/x", {}, remoteEnv("10.0.0.1"));
        assertEquals(res.status, 200);
    }
    const blocked = await app.request("/x", {}, remoteEnv("10.0.0.1"));
    assertEquals(blocked.status, 429);
    assertEquals(await blocked.text(), "Too many requests.");
    assertEquals(blocked.headers.get("retry-after"), "1");
});

Deno.test("rateLimit refills over time", async () => {
    const clock = { now: 1_000_000 };
    const app = buildApp(
        { requestsPerMinute: 60, burst: 1, trustProxy: false },
        clock,
    );
    assertEquals((await app.request("/x", {}, remoteEnv("10.0.0.1"))).status, 200);
    assertEquals((await app.request("/x", {}, remoteEnv("10.0.0.1"))).status, 429);
    clock.now += 1000; // 60 rpm → one token per second
    assertEquals((await app.request("/x", {}, remoteEnv("10.0.0.1"))).status, 200);
});

Deno.test("rateLimit keeps separate buckets per client address", async () => {
    const clock = { now: 1_000_000 };
    const app = buildApp(
        { requestsPerMinute: 60, burst: 1, trustProxy: false },
        clock,
    );
    assertEquals((await app.request("/x", {}, remoteEnv("10.0.0.1"))).status, 200);
    assertEquals((await app.request("/x", {}, remoteEnv("10.0.0.2"))).status, 200);
    assertEquals((await app.request("/x", {}, remoteEnv("10.0.0.1"))).status, 429);
});

Deno.test("rateLimit uses X-Forwarded-For only when trust_proxy is on", async () => {
    const clock = { now: 1_000_000 };
    const trusting = buildApp(
        { requestsPerMinute: 60, burst: 1, trustProxy: true },
        clock,
    );
    const viaA = { headers: { "x-forwarded-for": "203.0.113.1, 10.0.0.9" } };
    const viaB = { headers: { "x-forwarded-for": "203.0.113.2, 10.0.0.9" } };
    assertEquals((await trusting.request("/x", viaA, remoteEnv("10.0.0.9"))).status, 200);
    assertEquals((await trusting.request("/x", viaB, remoteEnv("10.0.0.9"))).status, 200);
    assertEquals((await trusting.request("/x", viaA, remoteEnv("10.0.0.9"))).status, 429);

    const untrusting = buildApp(
        { requestsPerMinute: 60, burst: 1, trustProxy: false },
        clock,
    );
    assertEquals((await untrusting.request("/x", viaA, remoteEnv("10.0.0.9"))).status, 200);
    // Same socket address → same bucket, header ignored.
    assertEquals((await untrusting.request("/x", viaB, remoteEnv("10.0.0.9"))).status, 429);
});

Deno.test("rateLimit counts rejections in metrics", async () => {
    const clock = { now: 1_000_000 };
    const metrics = new Metrics();
    const app = buildApp(
        { requestsPerMinute: 60, burst: 1, trustProxy: false, metrics },
        clock,
    );
    await app.request("/x", {}, remoteEnv("10.0.0.1"));
    await app.request("/x", {}, remoteEnv("10.0.0.1"));
    const value = (await metrics.rateLimitRejections.get()).values[0]?.value;
    assertEquals(value, 1);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `DENO_JOBS=1 deno test src/tests/rateLimit_test.ts $TEST_FLAGS`
Expected: FAIL at type-check: `Module not found "file:///.../src/routes/rateLimit.ts"`.

- [ ] **Step 7: Add the metrics counter**

In `src/lib/helpers/metrics.ts`, add after `verifyRequestFailures` (added in Task 6):

```ts
    public rateLimitRejections = this.createCounter(
        "rate_limit_rejections_total",
        "Number of inbound requests rejected with 429 by the per-client rate limiter",
    );
```

- [ ] **Step 8: Create the middleware**

Create `src/routes/rateLimit.ts`:

```ts
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { getConnInfo } from "hono/deno";
import type { Metrics } from "../lib/helpers/metrics.ts";

/**
 * Per-client-IP token bucket for the companion routes.
 *
 * Each client starts with `burst` tokens; one token is spent per request and
 * tokens refill at `requestsPerMinute / 60` per second up to `burst`. A
 * request with less than one token available is answered 429. Buckets that
 * have been idle for PRUNE_INTERVAL_MS are dropped on the next request so
 * the map cannot grow without bound.
 */
export interface RateLimitOptions {
    requestsPerMinute: number;
    burst: number;
    trustProxy: boolean;
    metrics?: Metrics;
    /** Injectable clock (ms); defaults to Date.now. Tests use it. */
    now?: () => number;
}

interface Bucket {
    readonly tokens: number;
    readonly updatedAt: number;
}

const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const RATE_LIMIT_BODY = "Too many requests.";
const UNKNOWN_CLIENT = "unknown";

/**
 * Identify the client. With trustProxy the first X-Forwarded-For hop wins
 * (only correct behind a reverse proxy that overwrites the header);
 * otherwise the socket address. `app.request()` in tests has no connection
 * info unless an env with `remoteAddr` is passed, hence the fallback.
 */
export function clientIpFrom(c: Context, trustProxy: boolean): string {
    if (trustProxy) {
        const forwarded = c.req.header("x-forwarded-for");
        const firstHop = forwarded?.split(",")[0]?.trim();
        if (firstHop) {
            return firstHop;
        }
    }
    try {
        return getConnInfo(c).remote.address ?? UNKNOWN_CLIENT;
    } catch {
        return UNKNOWN_CLIENT;
    }
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
    const buckets = new Map<string, Bucket>();
    const now = options.now ?? Date.now;
    const refillPerMs = options.requestsPerMinute / 60_000;
    let lastPrune = now();

    const pruneIdle = (t: number): void => {
        if (t - lastPrune < PRUNE_INTERVAL_MS) return;
        lastPrune = t;
        for (const [ip, bucket] of buckets) {
            if (t - bucket.updatedAt > PRUNE_INTERVAL_MS) {
                buckets.delete(ip);
            }
        }
    };

    return async (c, next) => {
        const t = now();
        pruneIdle(t);

        const ip = clientIpFrom(c, options.trustProxy);
        const previous = buckets.get(ip) ??
            { tokens: options.burst, updatedAt: t };
        const refilled = Math.min(
            options.burst,
            previous.tokens + (t - previous.updatedAt) * refillPerMs,
        );

        if (refilled < 1) {
            buckets.set(ip, { tokens: refilled, updatedAt: t });
            options.metrics?.rateLimitRejections.inc();
            const retryAfterSeconds = Math.max(
                1,
                Math.ceil((1 - refilled) / refillPerMs / 1000),
            );
            throw new HTTPException(429, {
                res: new Response(RATE_LIMIT_BODY, {
                    status: 429,
                    headers: { "retry-after": String(retryAfterSeconds) },
                }),
            });
        }

        buckets.set(ip, { tokens: refilled - 1, updatedAt: t });
        await next();
    };
}
```

- [ ] **Step 9: Run the middleware test to verify it passes**

Run: `DENO_JOBS=1 deno test src/tests/rateLimit_test.ts $TEST_FLAGS`
Expected: `ok | 5 passed | 0 failed`

- [ ] **Step 10: Register the middleware on the companion app only**

In `src/main.ts`, add to the imports (after the `errorHandler` import from Task 2):

```ts
import { rateLimit } from "./routes/rateLimit.ts";
```

Insert directly before line 413 (`companionApp.use("*", async (c, next) => {`):

```ts
// Inbound per-client throttle. Registered on companionApp only, so
// /healthz, /readyz and /metrics on the root app stay exempt.
if (config.server.rate_limit.enabled) {
    companionApp.use(
        "*",
        rateLimit({
            requestsPerMinute: config.server.rate_limit.requests_per_minute,
            burst: config.server.rate_limit.burst,
            trustProxy: config.server.trust_proxy,
            metrics,
        }),
    );
}
```

- [ ] **Step 11: Document the keys**

In `config/config.example.toml`, insert after line 24 (`# enable_metrics = false # env variable: SERVER_ENABLE_METRICS`):

```toml
# # Trust the first X-Forwarded-For hop as the client address (rate limiting).
# # Only enable behind a reverse proxy you control.
# trust_proxy = false # env variable: SERVER_TRUST_PROXY

# [server.rate_limit]
# # Inbound per-client-IP token bucket. Companion routes are reachable from
# # end-user browsers, so this stops a single client from burning the egress
# # IP's anti-bot budget. Exempt: /healthz, /readyz, /metrics.
# enabled = true # env variable: SERVER_RATE_LIMIT_ENABLED
# requests_per_minute = 120 # env variable: SERVER_RATE_LIMIT_RPM
# burst = 60 # env variable: SERVER_RATE_LIMIT_BURST
```

In `README.md`, insert after line 112 (`| \`SERVER_ENABLE_METRICS\` | \`false\` | Expose \`/metrics\`. |`):

```markdown
| `SERVER_TRUST_PROXY`          | `false`                         | Use first `X-Forwarded-For` hop as client IP. |
| `SERVER_RATE_LIMIT_ENABLED`   | `true`                          | Per-client inbound rate limit (429).        |
| `SERVER_RATE_LIMIT_RPM`       | `120`                           | Sustained requests per minute per client.   |
| `SERVER_RATE_LIMIT_BURST`     | `60`                            | Burst allowance per client.                 |
```

- [ ] **Step 12: Run project checks, the full suite, and commit**

```bash
deno task format && deno task check && deno task lint
SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test
git add src/lib/helpers/config.ts src/lib/helpers/metrics.ts src/routes/rateLimit.ts src/main.ts config/config.example.toml README.md src/tests/rateLimit_test.ts src/tests/config_additions_test.ts
git commit -m "feat: add per-client inbound rate limiting for companion routes"
```

Expected: `main_test.ts` still passes (its handful of requests stay far below the burst).

---

### Task 9: Access log through the leveled logger; widen the redaction list (C8)

**Files:**
- Modify: `src/lib/helpers/log.ts:87-100` (add `CTX.HTTP`)
- Modify: `src/lib/helpers/redactSensitive.ts:8-16`
- Modify: `src/routes/compactLogger.ts:25-26, 102-119`
- Test: `src/tests/redactSensitive_test.ts` (extend), `src/tests/compactLogger_test.ts` (new)

**Interfaces:**
- `CTX.HTTP = "HTTP"`.
- `SENSITIVE_PARAM_NAMES` gains `"ip"`, `"data"`, `"cookies"`.
- `compactLogger` output lines become `[INFO]  [HTTP] <-- GET   /path …` and `[INFO]  [HTTP] --> GET   /path … 200 12ms`, emitted via `logInfo` (so `LOG_LEVEL=warn` silences them).

- [ ] **Step 1: Write the failing tests**

Append to `src/tests/redactSensitive_test.ts` inside `Deno.test("Redaction - redactUrl", …)` before its closing `});`:

```ts
    await t.step("redacts ip, data and cookies params", () => {
        const url =
            "https://example.com/videoplayback?ip=203.0.113.7&data=Zm9v&cookies=a%3Db&itag=18";
        const result = redactUrl(url);
        assertEquals(result.includes("203.0.113.7"), false);
        assertEquals(result.includes("Zm9v"), false);
        assertEquals(result.includes("a%3Db"), false);
        assertEquals(result.includes("itag=18"), true);
    });
```

Create `src/tests/compactLogger_test.ts`:

```ts
import { Hono } from "hono";
import { assert, assertEquals } from "./deps.ts";
import { compactLogger } from "../routes/compactLogger.ts";

async function captureConsoleLog(fn: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
        lines.push(args.map((a) => String(a)).join(" "));
    };
    try {
        await fn();
    } finally {
        console.log = original;
    }
    return lines;
}

Deno.test("compactLogger writes request and response lines through the HTTP context", async () => {
    const app = new Hono();
    app.use("*", compactLogger);
    app.get("/companion/latest_version", (c) => c.text("ok"));

    const lines = await captureConsoleLog(async () => {
        const res = await app.request(
            "/companion/latest_version?id=jNQXAC9IVRw&itag=18&pot=SECRET",
        );
        assertEquals(res.status, 200);
    });

    assertEquals(lines.length, 2);
    assert(lines[0].startsWith("[INFO]  [HTTP] <-- GET"));
    assert(lines[0].includes("/latest_version id=jNQXAC9IVRw itag=18"));
    assert(lines[1].startsWith("[INFO]  [HTTP] --> GET"));
    assert(lines[1].includes(" 200 "));
    assert(!lines.join("\n").includes("SECRET"));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `DENO_JOBS=1 deno test src/tests/redactSensitive_test.ts src/tests/compactLogger_test.ts $TEST_FLAGS`
Expected: redaction step fails on `includes("203.0.113.7")`; compactLogger test fails on `startsWith("[INFO]  [HTTP] <-- GET")`.

- [ ] **Step 3: Add `CTX.HTTP`**

In `src/lib/helpers/log.ts`, inside `export const CTX = { … }`, add after `SERVER: "SERVER",`:

```ts
    HTTP: "HTTP",
```

- [ ] **Step 4: Extend the redaction list**

In `src/lib/helpers/redactSensitive.ts`, replace lines 8–16 with:

```ts
const SENSITIVE_PARAM_NAMES = [
    "key",
    "token",
    "secret",
    "authorization",
    "pot",
    "sig",
    "signature",
    // Egress IP bound into googlevideo URLs (latestVersion.ts PRIVATE_PARAM_NAMES).
    "ip",
    // Encrypted pot/ip blob on /videoplayback?enc=true.
    "data",
    "cookies",
];
```

- [ ] **Step 5: Route the access log through `logInfo`**

In `src/routes/compactLogger.ts`, replace lines 25–26 (imports) with:

```ts
import type { MiddlewareHandler } from "hono";
import { redactUrl } from "../lib/helpers/redactSensitive.ts";
import { CTX, logInfo } from "../lib/helpers/log.ts";
```

Replace lines 102–119 (the middleware) with:

```ts
export const compactLogger: MiddlewareHandler = async (c, next) => {
    const method = c.req.method;
    const summary = summarizeUrl(c.req.url);

    // Incoming request
    logInfo(CTX.HTTP, `<-- ${method.padEnd(5)} ${summary}`);

    const start = performance.now();
    await next();
    const elapsed = performance.now() - start;

    const status = c.res.status;
    const duration = fmtDuration(Math.round(elapsed));

    c.get("metrics")?.requestLatency.observe(elapsed / 1000);

    logInfo(CTX.HTTP, `--> ${method.padEnd(5)} ${summary} ${status} ${duration}`);
};
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `DENO_JOBS=1 deno test src/tests/redactSensitive_test.ts src/tests/compactLogger_test.ts $TEST_FLAGS`
Expected: `ok | 3 passed (10 steps) | 0 failed`

- [ ] **Step 7: Run project checks and commit**

```bash
deno task format && deno task check && deno task lint
git add src/lib/helpers/log.ts src/lib/helpers/redactSensitive.ts src/routes/compactLogger.ts src/tests/redactSensitive_test.ts src/tests/compactLogger_test.ts
git commit -m "fix: emit access log via leveled logger and redact ip/data/cookies params"
```

---

### Task 10: Labelled request latency and abuse-signal counters (C10)

**Files:**
- Modify: `src/lib/helpers/metrics.ts:16-27, 139-142` (+ new counters)
- Modify: `src/routes/compactLogger.ts` (labelled observe, 401 counter)
- Modify: `src/routes/invidious_routes/captions.ts` (count requests)
- Test: `src/tests/metrics_test.ts` (extend), `src/tests/compactLogger_test.ts` (extend)

**Interfaces:**
- `Metrics.createHistogram(name, help, buckets?, labelNames?: string[])`.
- `Metrics.requestLatency` is now labelled `route`, `method`, `status`; observe with `requestLatency.labels(route, method, status).observe(seconds)`. `route` is Hono's matched pattern (`c.req.routePath`, e.g. `/companion/api/v1/captions/:videoId`), which keeps cardinality bounded.
- New counters: `authFailures` (any response with status 401), `captionsRequests`.

- [ ] **Step 1: Write the failing tests**

Append to `src/tests/metrics_test.ts`:

```ts
Deno.test("Metrics - requestLatency is labelled by route, method and status", async () => {
    const metrics = new Metrics();
    metrics.requestLatency.labels("/companion/latest_version", "GET", "302")
        .observe(0.05);
    const data = await metrics.requestLatency.get();
    const labelled = data.values.find((v) =>
        v.labels.route === "/companion/latest_version" &&
        v.labels.method === "GET" && v.labels.status === "302"
    );
    assertExists(labelled, "expected a sample carrying the three labels");
});

Deno.test("Metrics - abuse-signal counters exist", () => {
    const metrics = new Metrics();
    assertExists(metrics.authFailures);
    assertExists(metrics.verifyRequestFailures);
    assertExists(metrics.captionsRequests);
    assertExists(metrics.rateLimitRejections);
    metrics.authFailures.inc();
    metrics.captionsRequests.inc();
});
```

Append to `src/tests/compactLogger_test.ts`:

```ts
import { Metrics } from "../lib/helpers/metrics.ts";

Deno.test("compactLogger records labelled latency and counts 401 responses", async () => {
    const metrics = new Metrics();
    // Typed app so c.set("metrics") type-checks without main.ts's global
    // ContextVariableMap augmentation being in this test's module graph.
    const app = new Hono<{ Variables: HonoVariables }>();
    app.use("*", async (c, next) => {
        c.set("metrics", metrics);
        await next();
    });
    app.use("*", compactLogger);
    app.get("/companion/youtubei/v1/player", (c) => c.text("nope", 401));

    await captureConsoleLog(async () => {
        await app.request("/companion/youtubei/v1/player");
    });

    const latency = await metrics.requestLatency.get();
    const sample = latency.values.find((v) =>
        v.labels.route === "/companion/youtubei/v1/player" &&
        v.labels.method === "GET" && v.labels.status === "401"
    );
    assertExists(sample);
    assertEquals((await metrics.authFailures.get()).values[0]?.value, 1);
});
```

(Move the `import { Metrics } …` line up to the other imports at the top of the file, add `import type { HonoVariables } from "../lib/types/HonoVariables.ts";` there too, and add `assertExists` to the `./deps.ts` import.)

- [ ] **Step 2: Run them to verify they fail**

Run: `DENO_JOBS=1 deno test src/tests/metrics_test.ts src/tests/compactLogger_test.ts $TEST_FLAGS`
Expected: type-check failures: `Property 'authFailures' does not exist on type 'Metrics'` and `Property 'labels' … Expected 0 arguments` (unlabelled histogram).

- [ ] **Step 3: Add label support and the counters**

In `src/lib/helpers/metrics.ts`, replace `createHistogram` (lines 16–27) with:

```ts
    public createHistogram(
        name: string,
        help: string,
        buckets?: number[],
        labelNames: string[] = [],
    ): Histogram {
        return new Histogram({
            name: `${this.METRICS_PREFIX}${name}`,
            help,
            buckets: buckets || [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
            labelNames,
            registers: [this.register],
        });
    }
```

Replace the `requestLatency` definition (lines 139–142) with:

```ts
    public requestLatency = this.createHistogram(
        "request_latency_seconds",
        "Request latency in seconds, labelled by matched route pattern, method and status",
        undefined,
        ["route", "method", "status"],
    );

    public authFailures = this.createCounter(
        "auth_failures_total",
        "Number of responses with status 401 (bearer auth on /youtubei/v1/* and /metrics)",
    );

    public captionsRequests = this.createCounter(
        "captions_requests_total",
        "Number of /api/v1/captions requests that reached the player flow (each mints a PO token)",
    );
```

- [ ] **Step 4: Observe with labels and count 401s in `compactLogger.ts`**

In `src/routes/compactLogger.ts`, replace the line `c.get("metrics")?.requestLatency.observe(elapsed / 1000);` with:

```ts
    const metrics = c.get("metrics");
    if (metrics) {
        // routePath is the matched pattern (":videoId" stays a placeholder),
        // so label cardinality is bounded by the number of routes.
        metrics.requestLatency
            .labels(c.req.routePath, method, String(status))
            .observe(elapsed / 1000);
        if (status === 401) {
            metrics.authFailures.inc();
        }
    }
```

- [ ] **Step 5: Count caption requests**

In `src/routes/invidious_routes/captions.ts`, directly after `await requireVerifiedCheck(c, videoId);` (added in Task 6), insert:

```ts
    metrics?.captionsRequests.inc();
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `DENO_JOBS=1 deno test src/tests/metrics_test.ts src/tests/compactLogger_test.ts $TEST_FLAGS`
Expected: `ok | 5 passed | 0 failed`

- [ ] **Step 7: Run project checks, the full suite, and commit**

```bash
deno task format && deno task check && deno task lint
SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test
git add src/lib/helpers/metrics.ts src/routes/compactLogger.ts src/routes/invidious_routes/captions.ts src/tests/metrics_test.ts src/tests/compactLogger_test.ts
git commit -m "feat: label request latency by route/method/status and count auth, verify, caption and rate-limit events"
```

---

### Task 11: Config drift — valid placeholder, `player_id` example, non-negative retry fields (C9)

**Files:**
- Modify: `config/config.example.toml:21, 136`
- Modify: `src/lib/helpers/config.ts:127-133`
- Test: `src/tests/config_bounds_test.ts` (new)

**Interfaces:**
- `networking.fetch.retry.initial_debounce` and `debounce_multiplier` reject negative numbers (`.min(0)`).

- [ ] **Step 1: Write the failing test**

Create `src/tests/config_bounds_test.ts`:

```ts
import { assertEquals, assertThrows } from "./deps.ts";
import { makeTestConfig } from "./helpers/testConfig.ts";

Deno.test("config rejects a negative retry initial_debounce", () => {
    assertThrows(
        () =>
            makeTestConfig({
                networking: { fetch: { retry: { initial_debounce: -1 } } },
            }),
        Error,
        "initial_debounce",
    );
});

Deno.test("config rejects a negative retry debounce_multiplier", () => {
    assertThrows(
        () =>
            makeTestConfig({
                networking: { fetch: { retry: { debounce_multiplier: -0.5 } } },
            }),
        Error,
        "debounce_multiplier",
    );
});

Deno.test("config accepts zero for both retry fields", () => {
    const config = makeTestConfig({
        networking: {
            fetch: { retry: { initial_debounce: 0, debounce_multiplier: 0 } },
        },
    });
    assertEquals(config.networking.fetch.retry.initial_debounce, 0);
    assertEquals(config.networking.fetch.retry.debounce_multiplier, 0);
});

Deno.test("the example secret_key placeholder satisfies the schema", () => {
    const config = makeTestConfig({ server: { secret_key: "CHANGEME12345678" } });
    assertEquals(config.server.secret_key, "CHANGEME12345678");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `DENO_JOBS=1 deno test src/tests/config_bounds_test.ts $TEST_FLAGS`
Expected: 2 failed (`Expected function to throw.` for the two negative-value tests); the other two pass.

- [ ] **Step 3: Add the bounds**

In `src/lib/helpers/config.ts`, replace lines 127–133:

```ts
                initial_debounce: z.number().optional().default(
                    envNumber("NETWORKING_FETCH_RETRY_INITIAL_DEBOUNCE") ?? 0,
                ),
                debounce_multiplier: z.number().optional().default(
                    envNumber("NETWORKING_FETCH_RETRY_DEBOUNCE_MULTIPLIER") ??
                        0,
                ),
```

with:

```ts
                initial_debounce: z.number().min(0).optional().default(
                    envNumber("NETWORKING_FETCH_RETRY_INITIAL_DEBOUNCE") ?? 0,
                ),
                debounce_multiplier: z.number().min(0).optional().default(
                    envNumber("NETWORKING_FETCH_RETRY_DEBOUNCE_MULTIPLIER") ??
                        0,
                ),
```

- [ ] **Step 4: Fix the example config**

In `config/config.example.toml`, replace line 21:

```toml
# secret_key = "CHANGE_ME" # env variable: SERVER_SECRET_KEY
```

with:

```toml
# secret_key = "CHANGEME12345678" # env variable: SERVER_SECRET_KEY
```

Append after the last line of the `[youtube_session]` block (`# hl = "" # env variable: YOUTUBE_SESSION_HL`):

```toml
# # Pin a specific YouTube player build. Useful for a few days after YouTube
# # ships a player that youtubei.js cannot decipher yet. Empty = latest.
# player_id = "" # env variable: YOUTUBE_SESSION_PLAYER_ID
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `DENO_JOBS=1 deno test src/tests/config_bounds_test.ts $TEST_FLAGS`
Expected: `ok | 4 passed | 0 failed`

- [ ] **Step 6: Run project checks, the full suite, and commit**

```bash
deno task format && deno task check && deno task lint
SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test
git add src/lib/helpers/config.ts config/config.example.toml src/tests/config_bounds_test.ts
git commit -m "fix: valid example secret_key, document player_id, reject negative retry debounce"
```

---

### Task 12: Captions route tests — guards without a player, list/track via the integration step (E1 part)

**Files:**
- Test: `src/tests/captions_route_test.ts` (new, network-free)
- Create: `src/tests/captions_test.ts` (integration step, real YouTube)
- Modify: `src/tests/main_test.ts` (register the step)

**Interfaces:**
- Consumes: `captionsHandler` (default export of `src/routes/invidious_routes/captions.ts`), `makeTestConfig` (Task 4), `TOKEN_MINTER_NOT_READY_MESSAGE` from `src/constants.ts`, `HonoVariables`, `TokenMinter`.
- Produces: `captionsList(baseUrl: string): Promise<void>` exported from `src/tests/captions_test.ts`.
- Why two files: every guard in `captions.ts` (captions disabled → 503, malformed id → 400, minter missing → 503) runs *before* `youtubePlayerParsing`, so those cases need no player stub. The list and selected-track paths need a real player response, which only `main_test.ts` has; they are covered there against YouTube like the DASH and `latest_version` steps.

- [ ] **Step 1: Write the failing unit test**

Create `src/tests/captions_route_test.ts`:

```ts
import { Hono } from "hono";
import { assertEquals } from "./deps.ts";
import captionsHandler from "../routes/invidious_routes/captions.ts";
import type { HonoVariables } from "../lib/types/HonoVariables.ts";
import type { TokenMinter } from "../lib/jobs/potoken.ts";
import { TOKEN_MINTER_NOT_READY_MESSAGE } from "../constants.ts";
import { makeTestConfig } from "./helpers/testConfig.ts";

const VIDEO_ID = "jNQXAC9IVRw";
const stubMinter = ((_videoId: string) =>
    Promise.resolve("pot")) as unknown as TokenMinter;

function buildApp(options: {
    captionsEnabled: boolean;
    minter: TokenMinter | undefined;
}) {
    const config = makeTestConfig({
        captions: { enabled: options.captionsEnabled },
        server: { verify_requests: false },
    });
    const app = new Hono<{ Variables: HonoVariables }>();
    app.use("*", async (c, next) => {
        c.set("config", config);
        c.set("tokenMinter", options.minter);
        c.set("metrics", undefined);
        await next();
    });
    app.route("/api/v1/captions", captionsHandler);
    return app;
}

Deno.test("captions route answers 503 when captions are disabled", async () => {
    const app = buildApp({ captionsEnabled: false, minter: stubMinter });
    const res = await app.request(`/api/v1/captions/${VIDEO_ID}`);
    assertEquals(res.status, 503);
    assertEquals(await res.text(), "Captions are disabled by administrator.");
});

Deno.test("captions route rejects a malformed video id with 400", async () => {
    const app = buildApp({ captionsEnabled: true, minter: stubMinter });
    const res = await app.request("/api/v1/captions/not-a-valid-id!");
    assertEquals(res.status, 400);
    assertEquals(await res.text(), "Invalid video ID format.");
});

Deno.test("captions route answers 503 while the token minter is not ready", async () => {
    const app = buildApp({ captionsEnabled: true, minter: undefined });
    const res = await app.request(`/api/v1/captions/${VIDEO_ID}`);
    assertEquals(res.status, 503);
    assertEquals(await res.text(), TOKEN_MINTER_NOT_READY_MESSAGE);
});
```

- [ ] **Step 2: Run it to verify the current guard order**

Run: `DENO_JOBS=1 deno test src/tests/captions_route_test.ts $TEST_FLAGS`

Expected: all three PASS if Task 6 (guards) has already been applied. If Task 6 is not yet applied, the first test still passes (the disabled check exists today) and the other two pass as well because `captions.ts` already validates the id and the minter; that is fine — this task locks the behaviour in before any further refactor. If any test FAILS, the failing assertion names the status/body that drifted; fix `captions.ts` (or `guards.ts`), not the test.

- [ ] **Step 3: Write the integration step**

Create `src/tests/captions_test.ts`:

```ts
import { assert, assertEquals } from "./deps.ts";

interface CaptionsListResponse {
    captions: Array<{ label: string; languageCode: string; url: string }>;
}

export async function captionsList(baseUrl: string) {
    const listRes = await fetch(`${baseUrl}/api/v1/captions/jNQXAC9IVRw`);
    assertEquals(listRes.status, 200, "captions list status is not 200");
    const body = await listRes.json() as CaptionsListResponse;
    assert(Array.isArray(body.captions), "captions list is not an array");

    // The list may legitimately be empty for a video without tracks; only
    // exercise the track path when YouTube advertises at least one.
    if (body.captions.length === 0) return;

    const first = body.captions[0];
    assert(
        first.url.includes(`/api/v1/captions/jNQXAC9IVRw?label=`),
        "caption url is not self-referential",
    );
    // `first.url` already starts with base_path; strip it because baseUrl
    // ends with base_path too.
    const basePathEnd = first.url.indexOf("/api/v1/captions");
    const trackRes = await fetch(`${baseUrl}${first.url.slice(basePathEnd)}`);
    assertEquals(trackRes.status, 200, "caption track status is not 200");
    assertEquals(
        trackRes.headers.get("content-type"),
        "text/vtt; charset=UTF-8",
    );
    const vtt = await trackRes.text();
    assert(vtt.startsWith("WEBVTT"), "caption body is not WebVTT");
}
```

- [ ] **Step 4: Register the step in `main_test.ts`**

In `src/tests/main_test.ts` add the import after the `latestVersion` import:

```ts
import { captionsList } from "./captions_test.ts";
```

and add a step after the `latest_version` step, before `controller.abort()`:

```ts
        await t.step(
            "Check if it can list and serve captions",
            captionsList.bind(null, baseUrl),
        );
```

- [ ] **Step 5: Run the integration test**

Run: `SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test src/tests/main_test.ts`

Expected: the new step prints `Check if it can list and serve captions ... ok`; the suite ends with `ok | 1 passed (4 steps)`. (Needs network like the other steps; in CI it runs inside the proxy loop.)

- [ ] **Step 6: Gate and commit**

Run: `deno task format && deno task check && deno task lint`

Expected: all three succeed with no output besides `Checked N files`.

```bash
git add src/tests/captions_route_test.ts src/tests/captions_test.ts src/tests/main_test.ts
git commit -m "test: cover captions route guards and the list/track path"
```

---

## Self-Review

**Spec coverage (C1–C11):**
- C1 → Task 1. C2 → Task 2. C3 → Task 3. C4 → Task 8. C5 → Task 6. C6 → Task 5. C7 → Task 7. C8 → Task 9. C9 → Task 11. C10 → Tasks 6, 8, 10 (counters split to the task that first needs them; labels and the remaining two counters in Task 10). C11 → Task 4. E1's "encrypt→verify round-trip" tests are delivered by Task 4; the `/download` and captions-config dispatch tests by Task 7; the captions route guards and the list/track integration step by Task 12 (plan B owns the `/videoplayback` tests, plan E the crypto helpers and shared env helpers).
- Not covered on purpose: the 6 h `check` window is unchanged (spec says changing it needs an Invidious change).

**Placeholder scan:** no "TBD"/"TODO"/"similar to Task N"; every code step contains the code; every run step has a command and an expected result.

**Type consistency:**
- `makeTestConfig`, `TEST_SECRET_KEY` (Task 4) used in Tasks 6, 7, 11 with the same signature.
- `makeCheck(videoId, config, timestampSeconds?)` (Task 4) used in Task 6.
- `verifyRequestFailures` added in Task 6, referenced by Task 10's test; `rateLimitRejections` added in Task 8, referenced by Task 10's test.
- `errorHandler` (Task 2) and `rateLimit` (Task 8) imports in `main.ts` are placed at distinct anchors.
- `GuardContext = Context<{ Variables: HonoVariables }>` matches the `Hono<{ Variables: HonoVariables }>` apps in `captions.ts` (already typed), and Tasks 6–7 switch `latestVersion.ts`, `dashManifest.ts` and `download.ts` to the same generic so the guard parameter types line up.
- `createHistogram` gains an optional fourth parameter; the two existing call sites (none besides `requestLatency`) are unaffected.
