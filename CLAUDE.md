# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Deno HTTP service that sits between [Invidious](https://github.com/iv-org/invidious) and YouTube. It retrieves YouTube player responses (via `youtubei.js`/Innertube), deciphers stream URLs, generates DASH manifests and PO tokens, and proxies the actual video bytes. Routing is built on [Hono](https://hono.dev/).

## Commands

Tasks are defined in `deno.json`. Use them rather than raw `deno` invocations — they carry the exact permission flags the app needs.

- `deno task dev` — run `src/main.ts` in watch mode. Requires `SERVER_SECRET_KEY` (exactly 16 alphanumeric chars): `SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task dev`
- `deno task test` — full test suite (`DENO_JOBS=1`). **Tests hit real YouTube** and need network/PO-token init; CI runs them behind a proxy (opera-proxy, falling back to Tor).
- `deno task check` — type-check (`deno check src/**`)
- `deno task lint` — lint (`deno lint src/**`)
- `deno task format` — formatting check (`deno fmt --check src/**`); note `fmt.indentWidth` is **4**
- `deno task compile` — produce `./invidious_companion` binary

CI (`.github/workflows/deno-check.yaml`) runs format → check → lint → test on PRs to `master`. Run all four locally before pushing.

### Running a single test

Copy the permission flags from the `test` task; e.g.:

```bash
DENO_JOBS=1 deno test src/tests/validateVideoId_test.ts \
  --allow-import=github.com:443,jsr.io:443,cdn.jsdelivr.net:443,esm.sh:443,deno.land:443 \
  --allow-net --allow-env --allow-sys=hostname \
  --allow-read=.,/tmp,/var/tmp/youtubei.js,/tmp/invidious-companion.sock,$HOME/.cache/deno \
  --allow-write=/var/tmp/youtubei.js,/tmp
```

`main_test.ts` is the integration entry point: it boots the real server via `run()`, awaits the exported `tokenMinterReady` promise, then runs sub-steps from the other `*_test.ts` files. Pure-unit tests (e.g. `validateVideoId_test.ts`, `config_*`, `redactSensitive_test.ts`) don't need YouTube access.

## Architecture

### Startup and shared state (`src/main.ts`)

Two Hono apps are mounted: `app` serves misc routes at the root (`/healthz`, `/readyz`, optional `/metrics`); `companionApp` serves everything under `config.server.base_path` (default `/companion`). Per-request middleware injects `innertubeClient`, `tokenMinter`, `config`, and `metrics` into the Hono context — these are typed in `src/lib/types/HonoVariables.ts` and accessed in handlers via `c.get(...)`.

The Innertube client and PO-token minter are mutated by a `Deno.cron` job that regenerates the YouTube session (default every 5 min). To avoid races between the cron job and in-flight requests, all reads/writes go through the `sharedState` object's synchronized accessors — **never reassign the client/minter directly**; call `sharedState.set()`.

### PO token generation (`src/lib/jobs/`)

When `jobs.youtube_session.po_token_enabled` (default true), `poTokenGenerate` spawns a **Web Worker** (`worker.ts`) that runs BotGuard (via `bgutils` + `jsdom`) to mint a session PO token and an integrity-token-based `tokenMinter`. The minter produces a per-video content token, sent to YouTube's player endpoint. Workers are tracked in a module-level array and torn down on shutdown (`cleanupWorkers`). Until the minter is ready, player/DASH endpoints return `TOKEN_MINTER_NOT_READY_MESSAGE` (`src/constants.ts`).

### Player request flow

`youtube_api_routes/player.ts` and `invidious_routes/dashManifest.ts` → `youtubePlayerParsing` (`lib/helpers/youtubePlayerHandling.ts`) → `youtubePlayerReq` (`lib/helpers/youtubePlayerReq.ts`).

- `youtubePlayerReq` calls the watch endpoint with the content PO token. If adaptive formats come back with no URL, it falls back through other client types (`TV_SIMPLY`, `ANDROID_VR`, `MWEB`).
- `youtubePlayerParsing` is the **caching + deciphering layer**: it caches trimmed player responses in **Deno KV** (key `["video_cache", videoId]`), brotli-compressed, with a TTL. It deciphers `formats`/`adaptive_formats` URLs (skipped for IOS/ANDROID clients, which don't need it) and rewrites `alr=yes`→`alr=no`.

### Captions and download routes (`src/routes/invidious_routes/`)

- `captions.ts` (`/api/v1/captions/:videoId`): runs the same player flow to get `videoInfo`, then reads `captions.caption_tracks`. With no `label`/`lang` query it returns the **list** of available captions (each with a self-referential URL); with `label` or `lang` it returns the selected track as `text/vtt` via `handleTranscripts` (`lib/helpers/youtubeTranscriptsHandling.ts`).
- `download.ts` (`POST /download`): a **dispatcher**, not a content producer. It parses `multipart/form-data` (`id`, `title`, `download_widget` JSON validated by a Zod union), then internally re-issues a request to another companion route via `app.request(...)` — to `/api/v1/captions/...` for a caption `label`, or to `/latest_version?...&local=true` for an `itag`. This is why `getDownloadHandler(app)` takes the Hono `app` instance (see `routes/index.ts`); it needs `app.request` to call sibling routes.

Both honor the same guards as the player/DASH routes: `validateVideoId`, the `tokenMinter`-ready check (captions only, since it fetches the player), and the `verify_requests`/`check` parameter validation via `verifyRequest`.

### Networking and proxies (`src/lib/helpers/getFetchClient.ts`)

`getFetchClient(config)` returns the `fetch` implementation used everywhere YouTube is contacted. It is a **singleton keyed by config-object identity** — all callers (main, potoken worker, video proxy) share one fetch fn so proxy-pool state (round-robin index, health/blacklist tracking) is shared. Three modes:

1. **Proxy pool** (`networking.proxy_pool`): round-robin or random selection over pre-created `Deno.HttpClient`s, with health probes, failure counting, 1-hour blacklisting, and cooldown re-validation.
2. **Single proxy / IPv6 rotation** (`PROXY` or `networking.ipv6_block`).
3. **Direct fetch**.

`checkYouTubeBlock` inspects responses for anti-bot signals (`"unusual traffic"`, captcha, etc.). **Critical invariant:** it only ever reads text/JSON/HTML bodies — video CDN responses (`video/mp4`, octet-stream) are never read, because buffering a video would OOM and a CDN 403 is not a bot block. Preserve this when editing.

### Video proxy (`src/routes/videoPlaybackProxy.ts`)

Streams `googlevideo.com` bytes to the client. **No chunked/parallel range fetching** — YouTube's CDN 403s on parallel byte-range requests to the same URL, so a single streaming request with `ReadableStream` passthrough is used deliberately. Client `Range` headers are forwarded and 206 responses passed through for seeking. Validates `host` against a `googlevideo.com` pattern and rejects expired URLs.

### Dynamic imports (intentional, don't "simplify")

`getFetchClient` and `youtubePlayerReq` are loaded via dynamic `import()` rather than static imports. Reasons: (a) they must be bundled into the worker and the compiled binary via `deno compile --include`, and (b) the location is overridable via env vars (`GET_FETCH_CLIENT_LOCATION`, `YT_PLAYER_REQ_LOCATION`) for testing/debugging. `lib/helpers/dynamicImportValidation.ts` allowlists these paths to block loading arbitrary/remote modules. If you change these filenames, update the `--include` flags in `deno.json` and the release workflow, and the allowlist.

### Config (`src/lib/helpers/config.ts`)

A single Zod schema (`ConfigSchema`, `.strict()`) is the source of truth. Each field defaults from an env var, and an optional TOML file (`CONFIG_FILE`, default `config/config.toml`) overlays on top. `parseConfig()` returns the validated `Config` type used throughout. When adding a setting, add it here with both an env-var default and a `config.example.toml` entry. `server.secret_key` must be 16 alphanumeric chars but is stretched to a 256-bit AES key via SHA-256 in `encryptQuery.ts`/`verifyRequest.ts`.

### Security helpers

- `encryptQuery.ts` / `verifyRequest.ts`: AES-256-GCM (format `base64(IV[12] || ciphertext+authTag)`), key derived from `secret_key` via SHA-256. Gated by `server.encrypt_query_params` and `server.verify_requests`. `verifyRequest` enforces a 6-hour max age and 5-minute future tolerance (replay protection).
- `/youtubei/v1/*` is protected by Hono `bearerAuth` using `secret_key`.

### Logging (`src/lib/helpers/log.ts`)

Use `logInfo/logWarn/logError/logDebug(CTX.X, msg)` with the predefined `CTX` tags, controlled by `LOG_LEVEL` — do not use bare `console.log`. `routes/compactLogger.ts` replaces Hono's default request logger (which would dump full URLs incl. query params). When logging proxy URLs, mask credentials (see `maskProxyUrl`).

## Notable constraints

- Relies on Deno **unstable** features: `cron`, `kv`, `http`, `temporal` (declared in `deno.json`).
- `youtubei.js`/`bgutils` are pinned to specific versions/CDN URLs in `deno.json` imports; YouTube changes frequently break playback and usually require bumping these.
- The Unix socket path is restricted by `--allow-write` and cannot be made arbitrary at runtime.
