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
    - Compiled by `deno task compile` into `./invidious_companion`
- Route registration: `src/routes/index.ts`
    - Companion routes are served under `server.base_path` (default: `/companion`)
    - Misc routes include `/healthz` and optional `/metrics`

## Requirements

- Deno (project tasks are defined in `deno.json`)
- Git (used by `deno task compile` to inject version metadata)
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
docker compose up -d
```

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

Most settings can be provided either through environment variables or `config/config.toml`.

### Required

| Variable            | Description                                           |
|---------------------|-------------------------------------------------------|
| `SERVER_SECRET_KEY` | Required. Must be exactly 16 alphanumeric characters. |

### Common server/runtime

| Variable                      | Default                         | Description                                 |
|-------------------------------|---------------------------------|---------------------------------------------|
| `PORT`                        | `8282`                          | HTTP port (when not using Unix socket).     |
| `HOST`                        | `127.0.0.1`                     | HTTP bind host.                             |
| `SERVER_USE_UNIX_SOCKET`      | `false`                         | Listen on Unix socket instead of TCP.       |
| `SERVER_UNIX_SOCKET_PATH`     | `/tmp/invidious-companion.sock` | Unix socket path.                           |
| `SERVER_BASE_PATH`            | `/companion`                    | Base route prefix for companion endpoints.  |
| `SERVER_VERIFY_REQUESTS`      | `false`                         | Enable request verification behavior.       |
| `SERVER_ENCRYPT_QUERY_PARAMS` | `false`                         | Enable query parameter encryption handling. |
| `SERVER_ENABLE_METRICS`       | `false`                         | Expose `/metrics`.                          |
| `CONFIG_FILE`                 | `config/config.toml`            | Override config file location.              |

### Cache/networking/jobs/session

| Variable                                             | Default       |
|------------------------------------------------------|---------------|
| `CACHE_ENABLED`                                      | `true`        |
| `CACHE_DIRECTORY`                                    | `/var/tmp`    |
| `CACHE_TTL_SECONDS`                                  | `3600`        |
| `PROXY`                                              | `null`        |
| `NETWORKING_IPV6_BLOCK`                              | `null`        |
| `NETWORKING_FETCH_TIMEOUT_MS`                        | `30000`       |
| `NETWORKING_FETCH_RETRY_ENABLED`                     | `false`       |
| `NETWORKING_FETCH_RETRY_TIMES`                       | `1`           |
| `NETWORKING_FETCH_RETRY_INITIAL_DEBOUNCE`            | `0`           |
| `NETWORKING_FETCH_RETRY_DEBOUNCE_MULTIPLIER`         | `0`           |
| `NETWORKING_RATE_LIMIT_ENABLED`                      | `false`       |
| `NETWORKING_RATE_LIMIT_MAX_CONCURRENT`               | `8`           |
| `NETWORKING_RATE_LIMIT_MIN_INTERVAL_MS`              | `0`           |
| `NETWORKING_VIDEOPLAYBACK_UMP`                       | `false`       |
| `JOBS_YOUTUBE_SESSION_PO_TOKEN_ENABLED`              | `true`        |
| `JOBS_YOUTUBE_SESSION_FREQUENCY`                     | `*/5 * * * *` |
| `JOBS_YOUTUBE_SESSION_LIFETIME_HOURS`                | `6`           |
| `YOUTUBE_SESSION_OAUTH_ENABLED`                      | `false`       |
| `YOUTUBE_SESSION_COOKIES`                            | `""`          |
| `YOUTUBE_SESSION_PLAYER_ID`                          | `""`          |
| `YOUTUBE_SESSION_GL`                                 | `""`          |
| `YOUTUBE_SESSION_HL`                                 | `""`          |

Additional runtime variable used by startup/import logic:

| Variable                    | Description                                                                                    |
|-----------------------------|------------------------------------------------------------------------------------------------|
| `GET_FETCH_CLIENT_LOCATION` | Overrides module location for `getFetchClient` import in `src/main.ts` (advanced/debug usage). |

### Anti-blocking notes

- **Proxy pool is failover-only, not load-balancing.** When `[networking.proxy_pool]`
  is enabled, one proxy is pinned as the active egress and *all* traffic goes
  through it; `rotation` (`round-robin` | `random`) only decides which proxy
  becomes active next after the current one is blacklisted (3 failures, a
  detected block, or a failed health probe). This keeps a logical session
  egressing from a single IP so PO tokens, `visitor_data`, and stream requests
  stay IP-consistent. To spread load, run multiple instances.
- **Session/IP consistency.** In proxy-pool mode the PO-token worker is pinned
  to the same active proxy the request path uses, so BotGuard attestation and
  playback share one IP. Use **residential/mobile** proxies where possible —
  datacenter IPs are blocked aggressively.
- **`NETWORKING_RATE_LIMIT_*`** caps concurrent requests / spaces out request
  starts to a single egress IP. Off by default; enable it if you see blocks
  under load.
- **`JOBS_YOUTUBE_SESSION_LIFETIME_HOURS`** keeps a generated `visitor_data`
  alive for the given window instead of churning it on every `frequency` tick;
  the cron then only re-attests once the session ages out. A detected block
  triggers an immediate regeneration regardless.
- **`YOUTUBE_SESSION_GL` / `YOUTUBE_SESSION_HL`** pin the request locale/region.
  Match them to your proxy's country so the locale doesn't contradict the
  egress IP's geolocation.

## Tests

Run the full suite:

```bash
deno task test
```

Typical targeted test run while iterating:

```bash
deno test src/tests/<file> --allow-import=github.com:443,jsr.io:443,cdn.jsdelivr.net:443,esm.sh:443,deno.land:443 --allow-net --allow-env --allow-sys=hostname --allow-read=.,/var/tmp/youtubei.js,/tmp/invidious-companion.sock --allow-write=/var/tmp/youtubei.js
```

## Project Structure

```text
.
├── config/
│   └── config.example.toml
├── src/
│   ├── main.ts
│   ├── constants.ts
│   ├── routes/
│   │   ├── index.ts
│   │   ├── health.ts
│   │   ├── metrics.ts
│   │   ├── videoPlaybackProxy.ts
│   │   ├── invidious_routes/
│   │   └── youtube_api_routes/
│   ├── lib/
│   │   ├── helpers/
│   │   ├── jobs/
│   │   └── types/
│   └── tests/
├── deno.json
├── deno.lock
├── Dockerfile
└── docker-compose.yaml
```

## License

This project is licensed under the **GNU Affero General Public License v3.0** (`LICENSE`).

