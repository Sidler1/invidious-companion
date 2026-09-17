# Invidious Companion

Companion for [Invidious](https://github.com/iv-org/invidious) that handles YouTube stream retrieval and related helper
APIs. It runs as a Deno HTTP service (Hono-based routing) and provides endpoints used by Invidious for playback,
manifests, captions, and health/metrics.

## Overview

Key responsibilities in this repository:

- Proxying YouTube video playback traffic.
- DASH manifest generation.
- Captions-related API helpers.
- Optional PO token generation/refresh job.
- Optional metrics endpoint for Prometheus/Grafana.

Useful external docs:

- Official installation docs: <https://docs.invidious.io/installation/>
- Project wiki: <https://github.com/iv-org/invidious-companion/wiki>

## Stack

- **Language/runtime:** TypeScript on [Deno](https://docs.deno.com/runtime/)
- **HTTP framework:** [Hono](https://hono.dev/)
- **Primary integrations/libraries:** `youtubei.js`, `prom-client`, Zod (`zod`) for config validation
- **Package/dependency management:** Deno modules via `deno.json` imports + `deno.lock`

## Entry Points

- Main runtime entry: `src/main.ts`
    - Started by `deno task dev`
    - Compiled by `deno task compile` (→ `scripts/compile.sh`) into `./invidious_companion`
- Route registration: `src/routes/index.ts`
    - Companion routes are served under `server.base_path` (default: `/companion`)
    - Misc routes are served at the root: `/healthz`, `/readyz` and optional `/metrics`

## Endpoints

Root (no base path):

| Method | Path       | Auth                                  | Purpose                                                                          |
|--------|------------|----------------------------------------|-----------------------------------------------------------------------------------|
| GET    | `/healthz` | none                                   | Liveness; always `200`.                                                          |
| GET    | `/readyz`  | none                                   | Readiness JSON; `503` until config, Innertube client and PO-token minter are up. |
| GET    | `/metrics` | `Authorization: Bearer <secret_key>`   | Prometheus metrics; only mounted when `SERVER_ENABLE_METRICS=true`.              |

Under `server.base_path` (default `/companion`). When `SERVER_RATE_LIMIT_ENABLED`
is on, any of these can also answer `429` (`Too many requests.`) before reaching
its handler:

| Method | Path                            | Auth                                            | Purpose                                                                                                                       |
|--------|----------------------------------|--------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------|
| POST   | `/youtubei/v1/player`           | `Authorization: Bearer <secret_key>`             | Player response for Invidious. `400` on invalid JSON body ("Invalid JSON body.") or missing `videoId` ("Missing videoId in request body."). |
| GET    | `/latest_version`               | `check` when `SERVER_VERIFY_REQUESTS`            | Redirect to a stream URL by `id` + `itag`. `400` on invalid/missing `id`/`itag`; `503` while the PO-token minter isn't ready. |
| POST   | `/download`                     | `check` when `SERVER_VERIFY_REQUESTS`            | Download widget dispatcher (captions or stream); internally re-issues to `/api/v1/captions` or `/latest_version`.            |
| GET    | `/api/manifest/dash/id/:id`     | `check` when `SERVER_VERIFY_REQUESTS`            | DASH manifest. `404` ("No streaming data available.") when the video has none.                                              |
| GET    | `/api/v1/captions/:id`          | `check` when `SERVER_VERIFY_REQUESTS`            | Caption list, or one track as `text/vtt` (`label`/`lang`). `503` when `CAPTIONS_ENABLED=false`; `404` when playability is `ERROR` or no matching track exists. |
| GET    | `/videoplayback`                | `enc`/`data` when `SERVER_ENCRYPT_QUERY_PARAMS`  | Streams bytes from `googlevideo.com` with `Range` passthrough; rejects non-`googlevideo.com` hosts and expired URLs.        |

`/latest_version`, `/download`, `/api/manifest/dash/id/:id` and `/api/v1/captions/:id`
also answer `503` (the same `TOKEN_MINTER_NOT_READY_MESSAGE`) while the PO-token
minter is still bootstrapping, when `jobs.youtube_session.po_token_enabled` is on.

## Requirements

- Deno (project tasks are defined in `deno.json`)
- Git (used by `deno task compile` to inject version metadata)
- Bash (`deno task compile` runs `scripts/compile.sh`)
- Optional: Docker / Docker Compose for containerized deployment

## Setup & Run

### 1) Configure environment

`SERVER_SECRET_KEY` is required and must be exactly **16 alphanumeric characters**.

Recommended for non-trivial setups:

1. Copy `config/config.example.toml` to `config/config.toml`.
2. Uncomment both section header and keys you use.
3. Keep `server.secret_key` aligned with `SERVER_SECRET_KEY` in your environment/scripts.

### 2) Local development (watch mode)

```bash
SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task dev
```

By default, the service listens at `http://127.0.0.1:8282/companion`.

### 3) Compile executable

```bash
deno task compile
```

Produces `./invidious_companion` in the repository root.

### 4) Docker (optional)

```bash
cp .env.example .env                                  # then edit SERVER_SECRET_KEY
cp config/config.example.toml config/config.toml      # required before first `docker compose up`
docker compose up -d
```

`config/config.toml` must exist before the first `docker compose up`: the
compose file bind-mounts it with `create_host_path: false`, so a missing file
fails the mount loudly instead of silently mounting an empty directory. A
plain copy of the example is enough to start; edit it afterwards for TOML
overrides. Compose also refuses to start when `SERVER_SECRET_KEY` is unset —
put it in `.env` (see `.env.example`) or export it in the shell. Both
`config/config.toml` and `.env` are excluded from the image (`.dockerignore`);
only `config/config.example.toml` is copied in.

> If your Docker installation only supports legacy syntax, use `docker-compose up -d`.

## Scripts (Deno tasks)

Defined in `deno.json`:

- `deno task dev` — run `src/main.ts` in watch mode with required runtime permissions.
- `deno task compile` — compile `src/main.ts` to `invidious_companion` and inject git version metadata.
- `deno task test` — run test suite with required permissions.
- `deno task format` — check formatting (`deno fmt --check src/**`).
- `deno task lint` — lint source (`deno lint src/**`).
- `deno task check` — type-check source (`deno check src/**`).

## Environment Variables

Every setting can be provided through `config/config.toml` (see
`config/config.example.toml`) or through the environment variable listed here.
TOML values take precedence over environment variables. The table is derived
from the Zod schema in `src/lib/helpers/config.ts`.

### Required

| Variable            | Description                                           |
|---------------------|-------------------------------------------------------|
| `SERVER_SECRET_KEY` | Required. Must be exactly 16 alphanumeric characters. |

### Server

| Variable                      | Default                         | Description                                                                      |
|--------------------------------|----------------------------------|-------------------------------------------------------------------------------------|
| `PORT`                        | `8282`                          | HTTP port (when not using Unix socket).                                          |
| `HOST`                        | `127.0.0.1`                     | HTTP bind host.                                                                   |
| `SERVER_USE_UNIX_SOCKET`      | `false`                         | Listen on Unix socket instead of TCP.                                            |
| `SERVER_UNIX_SOCKET_PATH`     | `/tmp/invidious-companion.sock` | Unix socket path.                                                                 |
| `SERVER_BASE_PATH`            | `/companion`                    | Base route prefix for companion endpoints.                                       |
| `SERVER_VERIFY_REQUESTS`      | `false`                         | Require a signed `check` param on Invidious-facing routes.                       |
| `SERVER_ENCRYPT_QUERY_PARAMS` | `false`                         | Encrypt `pot`/`ip` in `/videoplayback` URLs (`enc=true&data=`).                   |
| `SERVER_ENABLE_METRICS`       | `false`                         | Expose `/metrics` (bearer-protected with `SERVER_SECRET_KEY`).                    |
| `SERVER_TRUST_PROXY`          | `false`                         | Trust the first `X-Forwarded-For` hop for client identification (rate limiting). Only enable behind a reverse proxy you control. |
| `SERVER_RATE_LIMIT_ENABLED`   | `false`                         | Per-client-IP inbound token-bucket limiter on companion routes (`429 Too many requests.`). |
| `SERVER_RATE_LIMIT_RPM`       | `120`                           | Sustained requests per minute per client (bucket refill rate).                   |
| `SERVER_RATE_LIMIT_BURST`     | `60`                            | Burst allowance (bucket size) per client.                                        |
| `CONFIG_FILE`                 | `config/config.toml`            | Override config file location.                                                    |
| `LOG_LEVEL`                   | `info`                          | `debug`, `info`, `warn` or `error`.                                               |

`SERVER_RATE_LIMIT_ENABLED` defaults to `false` because the limiter buckets
by client IP: enable it only when the companion actually sees real per-user
client IPs — either it's exposed directly to browsers, or it sits behind a
reverse proxy that forwards `X-Forwarded-For` together with
`SERVER_TRUST_PROXY=true`. Behind Invidious's default same-origin
`/companion/*` reverse proxy, the companion only sees Invidious's own
backend IP (that proxy does not forward `X-Forwarded-For`), so enabling the
limiter there would cap the whole instance's traffic instead of each user.

### Captions

| Variable           | Default | Description                                                                                       |
|--------------------|---------|-----------------------------------------------------------------------------------------------------|
| `CAPTIONS_ENABLED` | `true`  | Set to `false` to answer `/api/v1/captions` with `503` (each caption fetch consumes a PO token). |

### Cache

| Variable                     | Default    | Description                                                                                                            |
|-------------------------------|------------|----------------------------------------------------------------------------------------------------------------------------|
| `CACHE_ENABLED`              | `true`     | Cache deciphered player responses in Deno KV.                                                                          |
| `CACHE_DIRECTORY`            | `/var/tmp` | KV store lives at `<dir>/youtubei.js/kv_cache.sqlite3`.                                                                |
| `CACHE_TTL_SECONDS`          | `3600`     | Positive cache TTL in seconds (max `21600` / 6h — matches the ~6h `expire` window on deciphered googlevideo URLs).     |
| `CACHE_NEGATIVE_TTL_SECONDS` | `30`       | TTL for non-OK (`ERROR`/unplayable) player responses; `0` disables.                                                    |

### Networking

| Variable                                     | Default | Description                                                                                                              |
|-------------------------------------------------|---------|------------------------------------------------------------------------------------------------------------------------------|
| `PROXY`                                      | `null`  | Single egress proxy URL (http/https/socks4/socks5).                                                                     |
| `NETWORKING_IPV6_BLOCK`                      | `null`  | IPv6 block for per-request source-address rotation.                                                                     |
| `NETWORKING_FETCH_TIMEOUT_MS`                | `30000` | Upstream fetch timeout in ms (1000–300000).                                                                             |
| `NETWORKING_FETCH_RETRY_ENABLED`             | `false` | Retry upstream fetches with exponential backoff.                                                                        |
| `NETWORKING_FETCH_RETRY_TIMES`               | `1`     | Max retries (1–10).                                                                                                      |
| `NETWORKING_FETCH_RETRY_INITIAL_DEBOUNCE`    | `0`     | First retry delay (ms).                                                                                                  |
| `NETWORKING_FETCH_RETRY_DEBOUNCE_MULTIPLIER` | `0`     | Backoff multiplier.                                                                                                      |
| `NETWORKING_VIDEOPLAYBACK_UMP`               | `false` | Enable YouTube's UMP video format.                                                                                       |
| `NETWORKING_RATE_LIMIT_ENABLED`              | `true`  | Cap outbound concurrency to YouTube per egress IP (per proxy when pooled).                                              |
| `NETWORKING_RATE_LIMIT_MAX_CONCURRENT`       | `8`     | Max simultaneous in-flight upstream requests (per egress IP when pooled).                                               |
| `NETWORKING_RATE_LIMIT_MIN_INTERVAL_MS`      | `0`     | Minimum spacing between request starts (`0` = no spacing).                                                              |
| `NETWORKING_PROXY_POOL_SWITCH_ON_LIMIT`      | `false` | Hop to another pool proxy when the active one's rate-limit gate is saturated; requires `NETWORKING_RATE_LIMIT_ENABLED`. |

`[networking.proxy_pool]` (`enabled`, `rotation`, `health_check`, `proxies`) is
**TOML-only**; there is no environment variable for the proxy list.

### Jobs / YouTube session

| Variable                                       | Default                     | Description                                                             |
|-----------------------------------------------------|----------------------------------|-------------------------------------------------------------------------------|
| `JOBS_YOUTUBE_SESSION_PO_TOKEN_ENABLED`        | `true`                       | Generate PO tokens with BotGuard.                                       |
| `JOBS_YOUTUBE_SESSION_FREQUENCY`               | `*/5 * * * *`                | Cron that checks whether the session needs regenerating.                |
| `JOBS_YOUTUBE_SESSION_LIFETIME_HOURS`          | `6`                          | Keep a session this long before re-attesting; `0` = every tick.         |
| `JOBS_YOUTUBE_SESSION_PLAYER_FALLBACK_CLIENTS` | `TV_SIMPLY,MWEB,ANDROID_VR`  | Comma-separated Innertube clients tried when WEB has no stream URLs.    |
| `YOUTUBE_SESSION_OAUTH_ENABLED`                | `false`                      | Use OAuth instead of PO tokens.                                         |
| `YOUTUBE_SESSION_COOKIES`                      | `""`                         | Cookie header for the Innertube session.                                |
| `YOUTUBE_SESSION_PLAYER_ID`                    | `""`                         | Pin a specific player JS id.                                            |
| `YOUTUBE_SESSION_GL`                           | `""`                         | Region (e.g. `US`); match the egress country.                          |
| `YOUTUBE_SESSION_HL`                           | `""`                         | Language (e.g. `en`).                                                   |

### Advanced / debugging

| Variable                    | Description                                                                              |
|-------------------------------|------------------------------------------------------------------------------------------------|
| `GET_FETCH_CLIENT_LOCATION` | Overrides the module location of `getFetchClient` (allow-listed internal paths only).    |
| `YT_PLAYER_REQ_LOCATION`    | Overrides the module location of `youtubePlayerReq` (allow-listed internal paths only).  |

### Anti-blocking notes

- **GVS PO token on stream URLs.** The session PO token (minted from
  `visitor_data`) is appended as `&pot=` to deciphered WEB/MWEB/TV
  `videoplayback` URLs. Web-family clients are throttled/403'd by the CDN
  without it, which is a major driver of stream failures and IP rotation. Goes
  hand-in-hand with running on a **residential IP**: with a valid GVS pot a
  residential instance can often serve playback with no proxy at all.
- **Proxy pool is failover-only by default, not load-balancing.** When
  `[networking.proxy_pool]` is enabled, one proxy is pinned as the active egress
  and *all* traffic goes through it; `rotation` (`round-robin` | `random`) only
  decides which proxy becomes active next after the current one is blacklisted
  (3 failures, a detected block, or a failed health probe). This keeps a logical
  session egressing from a single IP so PO tokens, `visitor_data`, and stream
  requests stay IP-consistent.
- **`NETWORKING_PROXY_POOL_SWITCH_ON_LIMIT`** (default off) turns the pool into
  rate-limit-aware load spreading: when the active proxy's rate-limit gate is
  saturated, traffic hops to the next healthy proxy with spare capacity. Each
  proxy keeps its **own session** (`visitor_data` + PO token minted from that
  proxy's IP), swapped in lockstep with the active proxy, so every egress IP
  presents its own consistent tokens. Requires rate limiting enabled.
- **Session/IP consistency.** In proxy-pool mode the PO-token worker is pinned
  to the same active proxy the request path uses, so BotGuard attestation and
  playback share one IP. Use **residential/mobile** proxies where possible —
  datacenter IPs are blocked aggressively.
- **`NETWORKING_RATE_LIMIT_*`** caps concurrent requests / spaces out request
  starts to a single egress IP. **Enabled by default** (`max_concurrent = 8`)
  as a baseline anti-block measure; raise `min_interval_ms` for stricter,
  more human-like pacing. With the proxy pool active each proxy is throttled
  independently.
- **`CACHE_NEGATIVE_TTL_SECONDS`** briefly caches non-OK player responses
  (unavailable/unplayable videos) so repeated requests for a bad video don't
  re-hit YouTube on every call. `0` disables.
- **`JOBS_YOUTUBE_SESSION_LIFETIME_HOURS`** keeps a generated `visitor_data`
  alive for the given window instead of churning it on every `frequency` tick;
  the cron then only re-attests once the session ages out. A detected block
  triggers an immediate regeneration regardless.
- **`YOUTUBE_SESSION_GL` / `YOUTUBE_SESSION_HL`** pin the request locale/region.
  Match them to your proxy's country so the locale doesn't contradict the
  egress IP's geolocation.

## Tests

Run the full suite (`DENO_JOBS=1` and every permission flag are part of the task):

```bash
SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test
```

`src/tests/main_test.ts` boots the real server and talks to YouTube; everything
else is network-free. To run only the unit tests, or a single file, pass the
paths to the task (extra arguments are appended to `deno test`):

```bash
deno task test --ignore=src/tests/main_test.ts   # unit tests only
deno task test src/tests/verifyRequest_test.ts   # one file
```

Tests that need environment variables or a config file use
`src/tests/helpers/env.ts` (`withEnv`, `withTempConfig`) so nothing leaks
between files, and `src/tests/helpers/testConfig.ts` (`makeTestConfig`) to
build a fully-defaulted `Config` without touching the filesystem or env vars.

## Project Structure

```text
.
├── config/
│   └── config.example.toml
├── scripts/
│   └── compile.sh
├── src/
│   ├── main.ts
│   ├── constants.ts
│   ├── routes/
│   │   ├── index.ts
│   │   ├── guards.ts
│   │   ├── errorHandler.ts
│   │   ├── rateLimit.ts
│   │   ├── compactLogger.ts
│   │   ├── metricsAuthFailureCounter.ts
│   │   ├── health.ts
│   │   ├── readiness.ts
│   │   ├── metrics.ts
│   │   ├── videoPlaybackProxy.ts
│   │   ├── invidious_routes/
│   │   └── youtube_api_routes/
│   ├── lib/
│   │   ├── helpers/
│   │   ├── jobs/
│   │   ├── session/
│   │   └── types/
│   └── tests/
│       └── helpers/
├── deno.json
├── deno.lock
├── Dockerfile
├── docker-compose.yaml
├── .dockerignore
└── .env.example
```

## License

This project is licensed under the **GNU Affero General Public License v3.0** (`LICENSE`).

