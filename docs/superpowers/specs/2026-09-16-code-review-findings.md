# Code Review Findings — invidious-companion (2026-09-16)

This document is the consolidated result of a full-codebase review performed on
2026-09-16 against `master` at commit `13eb287` (after the upstream sync PR #29).
It is the **spec** that the implementation plans under `docs/superpowers/plans/`
argue from. Each finding has a stable ID that the plans reference.

Severity scale: CRITICAL (outage / data loss), HIGH (bug or security hole with a
concrete failure path), MEDIUM (quality, robustness, drift), LOW (minor).

## Global constraints (apply to every plan)

- Runtime: Deno 2.9.x (Docker), `deno.json` tasks are the single source of truth
  for permission flags. Formatter indent width is **4**.
- Every change must pass `deno task format`, `deno task check`, `deno task lint`
  and `deno task test` (`SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa`).
- The Invidious ↔ companion contract (routes, query names, status codes, response
  bodies, `check`/`enc`/`data` wire format) must not change unless the finding
  says so explicitly; then `../invidious/` must be updated in lockstep.
- Logging goes through `logInfo/logWarn/logError/logDebug(CTX.X, msg)` from
  `src/lib/helpers/log.ts`. No bare `console.*` in `src/` outside `log.ts`.
- Immutability preferred; no mutation of shared objects outside `sharedState`.
- Files ≤ 800 lines, functions ≤ 50 lines where reasonably achievable.
- Tests: pure-unit tests must not need network. Integration tests live behind
  `main_test.ts`. Test names describe behaviour.
- Commit format: `<type>: <description>` (feat, fix, refactor, docs, test,
  chore, perf, ci). Attribution trailers as configured for the session.

---

## A. Session lifecycle / PO-token workers (`src/main.ts`, `src/lib/jobs/potoken.ts`, `src/lib/jobs/worker.ts`)

### A1 — CRITICAL — Worker termination by position, concurrent generations
`potoken.ts:207-211` kills all but the newest worker with `workers.shift()`
assuming the completing worker is the last pushed. The startup bootstrap
(`main.ts:264-277`, `retry(bootstrapAttempt, …)`) never sets
`sessionRegenInFlight`, and the cron (`main.ts:364-386`) is not gated on
`initialSessionReady` (`sessionGeneratedAtMs` is 0 during bootstrap), so two
`poTokenGenerate` calls can run concurrently. Whichever finishes first kills the
other's worker. Result: `sharedState` holds a minter bound to a terminated
worker; every mint hits `MINT_TIMEOUT_MS` (10 s); all player/DASH/captions
requests fail for up to `session_lifetime_hours`.
**Required:** terminate workers by identity; route the bootstrap through the
same in-flight guard as `regenerateSession`; cron must not run while the
bootstrap is in progress.

### A2 — HIGH — Per-proxy session cache references killed workers
`main.ts:197-207` caches `{client, minter}` in `perProxySessions` per egress
proxy; the next successful generation terminates every older worker including
the ones those minters post to. A hop A→B→A within `lifetimeMs` reinstalls a
dead minter (`main.ts:345-349`).
**Required:** a cached session must own its worker; workers are terminated only
when no cached session references them (evict on lifetime expiry), or cached
reuse is dropped in favour of always regenerating on a hop. Choose the former.

### A3 — HIGH — No worker `error` listener, no overall timeout
`potoken.ts:101-115/230` registers only a `message` listener; `worker.ts:97`
calls `getFetchClient(message.config)` outside the `try`. A worker-level error
(module load failure, `Deno.createHttpClient` rejecting a malformed proxy URL)
leaves the promise pending forever, so `sessionRegenInFlight` stays `true`
permanently and every later regeneration is silently dropped.
**Required:** `worker.addEventListener("error", …)` that rejects and terminates;
`worker.ts` wraps all work in `try`; `poTokenGenerate` is raced against a
bounded timeout (120 s) that terminates the worker and rejects.

### A4 — MEDIUM — Serving Innertube client ignores gl/hl/UA/cache in PO path
`potoken.ts:189-197` creates the serving client without `location`, `lang`,
`user_agent`, `cache`, unlike `main.ts:177-187` and `:218-228`.
**Required:** pass `user_agent: USER_AGENT`, `location: config.youtube_session.gl || undefined`,
`lang: config.youtube_session.hl || undefined`, and the shared `UniversalCache`.

### A5 — MEDIUM — Dropped regeneration triggers, wrong per-proxy cache key
`main.ts:164-216`: `regenerateSession` silently returns when one is in flight
(no log, no metric) and resolves the per-proxy cache key *after* generation via
`getSessionEgressProxy` instead of from the proxy the worker was pinned to.
**Required:** `poTokenGenerate` returns the pinned proxy URL; it is used as the
cache key; dropped triggers are logged and counted; if a newer trigger arrived
during an in-flight regen, one more regeneration runs afterwards.

### A6 — LOW — Shutdown order and untracked cache writes
`main.ts:506-535` calls `cleanupWorkers()` before `await server.finished`, so
in-flight requests that reach `tokenMinter()` hang for the full 10 s. Fire-and-
forget `kv.set` IIFEs in `youtubePlayerHandling.ts` are not awaited before
`closeKv()`.
**Required:** terminate workers after the server drained; track pending cache
writes in a set and await them before `closeKv()`.

### A7 — LOW — No metrics / readiness for mint failures
`potoken.ts:62-69`, `routes/readiness.ts:35-39`: mint timeouts and errors have
no counter; `/readyz` reports ready on `!!tokenMinter` alone.
**Required:** `mintTimeouts` and `mintFailures` counters; readiness reflects a
successful mint within the last `session_lifetime_hours`. The freshness window
is `session_lifetime_hours` plus a fixed 15-minute grace margin covering the
cron period and the generation timeout, so an idle instance does not flap
between regenerations.

---

## B. Video proxy and fetch client (`src/routes/videoPlaybackProxy.ts`, `src/lib/helpers/getFetchClient.ts`)

### B1 — HIGH — Fetch timeout aborts video streams
`getFetchClient.ts:678-704` (`fetchShim`) attaches `AbortSignal.timeout(timeout_ms)`
(default 30 000) to every request. The signal applies until the body is fully
read, so any video body taking > 30 s (downloads via `/latest_version?local=true`,
progressive itag 18) is cut mid-stream. Invidious redirects end users directly
to `/latest_version` for downloads (`../invidious/src/invidious/routes/video_playback.cr:267`).
**Required:** the video proxy's fetch must not carry a whole-body timeout. A
header-phase timeout may remain. Callers can opt out via an init flag.

### B2 — HIGH — Redirect handling lost vs. upstream
Upstream follows googlevideo `302` redirects manually (max 5). Our proxy sends
`redirect: "manual"`; on the direct/single-proxy path the 302 is returned to the
client with the `Location` header stripped; on the pool path `redirect` is not
forwarded at all (see B3) so redirects are followed implicitly.
**Required:** follow up to 5 redirects manually in the video proxy (validate
every redirect target host with the same anchored `googlevideo.com` regex);
return 502 when exceeded. Redirect targets may also be `*.c.youtube.com`
hosts, matching Invidious's `valid_googlevideo_redirect?`. An invalid
redirect target (wrong host, non-https, or carrying userinfo/an explicit
port) returns 502 `"Invalid redirect target."`, not 400 — the target came
from an upstream response, not the client, so it's an upstream-error class
matching Invidious's `"Invalid redirect from upstream."`.

### B3 — MEDIUM — Pool path drops `redirect` and `signal` from `init`
`getFetchClient.ts:420-431` forwards only `headers`, `method`, `body`.
**Required:** forward `redirect` and `signal` (and the new timeout opt-out) on
the pool path; on the single-proxy path a caller-provided `signal` must not
replace the timeout signal silently (combine with `AbortSignal.any`).

### B4 — MEDIUM — Every 403/429 with text content-type counts as a bot block
`getFetchClient.ts:631-650` returns `true` for 403/429 even when no block signal
is found in the body. CDN 403s with `text/plain` therefore count as proxy
failures and trigger session regeneration.
**Required:** only body signals count as a block; a 403/429 with no signal is
not a block. Keep the "never read video bodies" invariant.

### B5 — MEDIUM — Cooldown probes inline in the request path, no single-flight
`getFetchClient.ts:261-285, 313-316`: `revalidateCooldownProxies` runs on every
fetch and may perform network probes; concurrent requests probe the same proxy
simultaneously.
**Required:** single-flight the revalidation (shared promise) and rate-limit it
to at most once per 30 s.

### B6 — LOW — Video proxy input hygiene
`videoPlaybackProxy.ts:74-78`: a non-numeric `expire` (NaN) bypasses the expiry
check; `enc` and `data` query params are forwarded to googlevideo.
**Required:** reject non-integer `expire` with 400; delete `enc` and `data`
before building the upstream URL.

### B7 — MEDIUM — `getFetchClient.ts` is 774 lines with a 330-line closure
**Required:** extract `FetchGate` to `src/lib/helpers/fetchGate.ts`,
`checkYouTubeBlock` + `maskProxyUrl` to `src/lib/helpers/youtubeBlockDetection.ts`,
and the proxy pool closure to `src/lib/helpers/proxyPool.ts` exposing the same
behaviour. `getFetchClient.ts` keeps the singleton, the mode selection and the
single-proxy/direct paths. Public exports of `getFetchClient.ts` are unchanged.

---

## C. Security and routes (`src/routes/*`, `src/lib/helpers/*`)

### C1 — HIGH — Allowlist bypass in `dynamicImportValidation.ts`
`dynamicImportValidation.ts:55-59` accepts any location whose basename is an
allowed module name *before* the remote-URL (`:62`) and traversal (`:72-80`)
checks. `https://evil.com/getFetchClient.ts` and `../../../tmp/getFetchClient.ts`
are accepted.
**Required:** reject remote schemes and traversal first, then apply the
allowlist; replace `console.warn` at `:83` with `logWarn`; tests for both
bypasses.

### C2 — HIGH — PO tokens leak into logs via raw errors; no `app.onError`
`youtubeTranscriptsHandling.ts:55-61` fetches a URL containing `pot=`; Deno
embeds the URL in fetch errors; `main.ts` registers no `onError`, Hono's default
`console.error`s the raw error; `log.ts:70` prints raw errors.
**Required:** `companionApp.onError` that logs `redactString(String(err))` via
`logError(CTX.SERVER, …)` and returns the existing generic 500 for non-HTTP
exceptions (HTTPException passes through via `getResponse()`); `logError` must
redact message text.

### C3 — HIGH — Caption `base_url` fetched without host validation
`youtubeTranscriptsHandling.ts:54-59` appends a fresh PO token to
`selectedCaption.base_url` from the (cacheable) player response with no host
check and string concatenation.
**Required:** parse the URL, require hostname `www.youtube.com`, set
`fmt`/`potc`/`pot`/`c` via `searchParams.set`; 502 otherwise.

### C4 — MEDIUM — No inbound rate limiting
Companion routes are browser-facing; `verify_requests` defaults to false; a
`check` is replayable for 6 h; every captions request mints a PO token.
**Required:** per-client-IP token bucket middleware on the companion app
(configurable `server.rate_limit.enabled`, `requests_per_minute`, `burst`;
default disabled; operators enable it when the companion sees real client
IPs (see README); 120 rpm, burst 60) returning 429 with body
`"Too many requests."`. Client IP from `X-Forwarded-For` first hop when
`server.trust_proxy` is true, else the socket address. `/healthz`, `/readyz`,
`/metrics` are exempt. Invidious's default same-origin `/companion/*`
reverse proxy does not forward `X-Forwarded-For`, so behind that proxy the
companion sees only Invidious's own backend IP for every user — this is why
the limiter defaults off rather than on.

### C5 — MEDIUM — Route guard chain duplicated four times
`captions.ts:29-59`, `latestVersion.ts:26-54`, `download.ts:25-45`,
`dashManifest.ts:29-48` repeat `validateVideoId` → minter-ready → `verifyRequest`
with different orders; `download.ts` omits the minter check.
**Required:** `src/routes/guards.ts` exporting `requireValidVideoId(videoId)`,
`requireTokenMinter(c)`, `requireVerifiedCheck(c, videoId)`; all four routes use
them in that order. Status codes and body strings stay byte-identical
(`"Invalid video ID format."` 400, `TOKEN_MINTER_NOT_READY_MESSAGE` 503,
`"No check ID."` 400, `"ID incorrect."` 400).

### C6 — MEDIUM — `encryptQuery` swallows failures
`encryptQuery.ts:38-41` returns `""` on error; `latestVersion.ts:113-123` still
redirects with `enc=true&data=`.
**Required:** `encryptQuery` throws; `latestVersion` catches, logs, returns 500
`"Failed to encrypt query."`.

### C7 — MEDIUM — `download.ts` input handling
`download.ts:16, 47-68`: `c.req.formData()` unguarded (500 on non-multipart);
`title` unbounded; `ext` unconstrained; dead `videoId &&` at `:62`.
**Required:** `formData()` in try/catch → 400 `"Invalid form data."`; Zod:
`title` max 256 chars; itag branch `ext` matches `/^[a-z0-9]{1,5}$/`; label
branch `ext` is bounded to 64 characters (Invidious sends `<languageCode>.vtt`
and the value is unused downstream); remove dead code. Request bodies on
`POST /download` are capped at 64 KiB, answering 413 on overflow.

### C8 — LOW — Access logger bypasses `LOG_LEVEL`; redaction list gaps
`compactLogger.ts:107,118` uses `console.log`; `redactSensitive.ts:8-16` omits
`ip`, `data`, `cookies`.
**Required:** add `CTX.HTTP`; access lines go through `logInfo(CTX.HTTP, …)`;
add `ip`, `data`, `cookies` to `SENSITIVE_PARAM_NAMES`.

### C9 — LOW — Config drift
`config.example.toml:21` `secret_key = "CHANGE_ME"` (9 chars, invalid);
`youtube_session.player_id` has no example entry; `fetch.retry.initial_debounce`
and `debounce_multiplier` accept negatives.
**Required:** placeholder `"CHANGEME12345678"`; add `player_id` entry; `.min(0)`.

### C10 — LOW — Metrics gaps
`metrics.ts:139-142`: `requestLatency` unlabelled; no counters for auth
failures, verify failures, captions requests, rate-limit rejections.
**Required:** `requestLatency` labelled `route`, `method`, `status`; counters
`authFailures`, `verifyRequestFailures`, `captionsRequests`, `rateLimitRejections`.

### C11 — LOW — Crypto helper duplication
`encryptQuery.ts:74-98` and `verifyRequest.ts:65-85` duplicate key derivation;
`verifyRequest.ts:37` uses `parseInt`.
**Required:** `src/lib/helpers/crypto.ts` with `deriveAesKey(secret)` and
`decryptGcm(bytes, config)`; both callers use it; timestamp parsed with
`Number.isInteger`. Wire format unchanged.

---

## D. Player handling (`src/lib/helpers/youtubePlayerHandling.ts`, `youtubePlayerReq.ts`, routes)

### D1 — MEDIUM — `playabilityStatus ERROR` throws in YouTube.js v18
`youtubePlayerHandling.ts:88-90, 261-275`: for `status === "ERROR"` the raw
response is returned and `youtubeVideoInfo` constructs `YT.VideoInfo`, whose v18
constructor throws `InnertubeError` before the route's own status check.
DASH/captions/latest_version yield a 500; `/youtubei/v1/player` leaks the raw
payload; metrics and negative caching are skipped.
**Required:** inspect `playabilityStatus.status` on the JSON before building
`VideoInfo`; return the trimmed shape for ERROR; record
`metrics.checkInnertubeResponse`; routes respond 403 with the existing message
format.

### D2 — MEDIUM — Cache key ignores egress/session generation
`youtubePlayerHandling.ts:37-38, 191-214`: deciphered URLs embed `ip=`/`pot=`
of the producing session; cache is keyed by `videoId` only; nothing invalidates
on proxy hop or regeneration.
**Required:** a monotonically increasing `sessionGeneration` in `sharedState`,
bumped on every `sharedState.set`; cache key `["video_cache", generation, videoId]`.

### D3 — LOW — KV opened even when cache disabled; unvalidated player body; DASH `undefined`
`youtubePlayerHandling.ts:35-38`; `routes/youtube_api_routes/player.ts:10-36`;
`dashManifest.ts:75-155`.
**Required:** short-circuit before touching KV when `!cacheEnabled`; Zod-validate
the player body (`videoId` string, optional `context`); DASH returns 404
`"No streaming data available."` when `streaming_data` is absent.

### D4 — LOW — Decipher decision reads the primary client, not the fallback
`youtubePlayerHandling.ts:102-113` vs `youtubePlayerReq.ts:124-139`.
**Required:** `youtubePlayerReq` sets `streamingDataClient` on the returned
response object (`"WEB" | fallback client type`); the decipher/pot decision uses it.

### D5 — MEDIUM — `youtubePlayerParsing` is ~240 lines
**Required:** split into `readCachedPlayerResponse`, `decipherStreamingData`,
`writePlayerCache(kv, key, value, ttlSeconds)` (one shared write function for
positive and negative caching) in `src/lib/helpers/playerCache.ts` and
`src/lib/helpers/playerDecipher.ts`.

---

## E. Tests, CI, container, docs

### E1 — HIGH — Zero tests at the Invidious contract boundary
No tests for `encryptQuery`, `verifyRequest`, `videoPlaybackProxy`, `download`,
`captions` route, `youtubeTranscriptsHandling`, KV cache logic.
**Required:** pure-unit tests: encrypt→decrypt round trip, sign→verify
(valid, expired > 6 h, future > 5 min, wrong videoId, tampered tag, padded
base64url); `app.request` tests for `/videoplayback` (host regex, expire, enc
decrypt failure → 400), `/download` (label → captions dispatch, itag →
latest_version dispatch, missing check, invalid form → 400), `/api/v1/captions`
(disabled → 503, list vs. selected track) with a stub `innertubeClient`/
`tokenMinter` in context.

### E2 — HIGH — Releases built from untested commits
`release-binaries.yaml` runs on every push to master; `deno-check.yaml` only on
`pull_request`.
**Required:** `deno-check.yaml` also on `push: branches: [master]`; the release
workflow runs format/check/lint before compiling.

### E3 — HIGH — Tautological tests
`proxy_pool_health_test.ts:5-38`, `proxy_pool_test.ts:5-33`, `shutdown_test.ts:7`.
**Required:** delete the tautological cases; cover the 3-failure/1-hour
blacklist via the mocked `fetch`/`Deno.createHttpClient` pattern already used
in `proxy_pool_test.ts:66-380`; `shutdown_test` asserts `cleanupWorkers`
terminates a registered worker.

### E4 — MEDIUM — Unit tests entangled with the network retry loop
`deno-check.yaml:51-87` runs all tests inside 4 opera-proxy + 12 Tor attempts;
`main_test.ts` boots the server at import time.
**Required:** CI step `unit` runs `deno task test --ignore=src/tests/main_test.ts`
without proxy, fail fast; `main_test.ts` alone runs inside the proxy loop.

### E5 — MEDIUM — Tests mutate global env without restoring; helper duplicated
`secret_key_validation_test.ts:11,235`, `config_additions_test.ts:161`,
`proxy_pool_test.ts:38,115,223,340,408`, `dynamicImportValidation_test.ts`
(cleanup not in `finally`); `withTempConfig` copied three times.
**Required:** `src/tests/helpers/env.ts` exporting `withEnv(vars, fn)` (snapshot
/ restore in `finally`) and `withTempConfig(content, fn)`; all tests use them.

### E6 — MEDIUM — `docker-compose.yaml` cannot start as documented
No `SERVER_SECRET_KEY`, no config mount, obsolete `version`.
**Required:** `environment: SERVER_SECRET_KEY: ${SERVER_SECRET_KEY:?set SERVER_SECRET_KEY}`,
`./config/config.toml:/app/config/config.toml:ro` mount, drop `version`.

### E7 — MEDIUM — Secrets can be baked into images
`.dockerignore` excludes `config/local.toml` only; `Dockerfile:157` copies
`./config/`.
**Required:** `.dockerignore` adds `config/config.toml`, `.env`; Dockerfile
copies only `config/config.example.toml`.

### E8 — MEDIUM — README drift
Missing: `CAPTIONS_ENABLED`, `JOBS_YOUTUBE_SESSION_PLAYER_FALLBACK_CLIENTS`,
`LOG_LEVEL`, `YT_PLAYER_REQ_LOCATION`, `/readyz`, `/metrics` bearer auth; the
single-test command lacks `/tmp` write and `DENO_JOBS=1`.
**Required:** update the env table, add an "Endpoints" section, replace the
test command with `DENO_JOBS=1 deno task test src/tests/<file>`.

### E9 — MEDIUM — `update.sh` unsafe
No checksum, service stopped before validation, no rollback, `journalctl -f`.
**Required:** download to temp dir, `tar -tzf` validation, backup previous
binary to `invidious_companion.bak`, atomic `mv`, `systemctl restart`, assert
`systemctl is-active`, restore backup on failure, no `-f` unless `--follow`.

### E10 — LOW — Permission-flag drift and unpinned build inputs
`deno.json:4` vs `release-binaries.yaml:62-63`; `Dockerfile:127` untagged
`gcr.io/distroless/cc`; `tor-actions/setup-tor@main`; dead
`docker-build-push.yaml.bak`.
**Required:** release workflow calls `deno task compile` with `--target`; pin
`gcr.io/distroless/cc-debian12` by tag; pin the tor action to a SHA; delete the
`.bak`; add a `docker build` (no push) job to the PR workflow.
