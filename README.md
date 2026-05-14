# Invidious Companion

Companion for [Invidious](https://github.com/iv-org/invidious) which handles video stream retrieval from YouTube servers. It acts as a proxy and helper service to ensure reliable playback and metadata fetching.

## Documentation
- **Official Installation Guide:** [https://docs.invidious.io/installation/](https://docs.invidious.io/installation/)
- **Wiki & Extra Documentation:** [https://github.com/iv-org/invidious-companion/wiki](https://github.com/iv-org/invidious-companion/wiki)

---

## Features
- YouTube video stream proxying and DASH manifest generation.
- Support for YouTube's UMP (Universal Media Player) format.
- IPv6 rotation to mitigate IP-based rate limiting.
- Metrics endpoint for Prometheus/Grafana monitoring.
- Health check endpoint.
- Support for PO tokens (Proof of Origin).

---

## Requirements
- [Deno](https://docs.deno.com/runtime/) (for local development/running)
- Docker & Docker Compose (optional, for containerized deployment)

---

## Setup & Run

### Environment Configuration
The application requires a `SERVER_SECRET_KEY` for authentication. It must be exactly 16 alphanumeric characters.

You can set configuration via:
1. **Environment Variables** (see [Environment Variables](#environment-variables) section).
2. **Configuration File**: Copy `config/config.example.toml` to `config/config.toml` and edit as needed.

### Local Development (Deno)
To run the companion in development mode with hot-reload:
```bash
SERVER_SECRET_KEY=YOUR_16_CHAR_KEY deno task dev
```

### Build & Compile
To compile the project into a single executable:
```bash
deno task compile
```
This generates an `invidious_companion` binary in the project root.

### Docker
To build and run using Docker Compose:
```bash
docker-compose up -d
```
*Note: Ensure you have configured your environment variables or `config/config.toml` before running.*

---

## Available Scripts (Deno Tasks)
- `deno task dev`: Launch Invidious companion in debug mode with watch enabled.
- `deno task compile`: Compile the project into a single executable binary.
- `deno task test`: Run all tests.
- `deno task format`: Format all TypeScript files.
- `deno task lint`: Lint the codebase.
- `deno task check`: Type-check the codebase.

---

## Environment Variables
The following environment variables can be used to configure the application. Most of these can also be set in `config/config.toml`.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8282` | Port to listen on. |
| `HOST` | `127.0.0.1` | Host to bind to. |
| `SERVER_SECRET_KEY` | (Required) | 16-character alphanumeric secret key for Bearer Auth. |
| `SERVER_USE_UNIX_SOCKET` | `false` | Enable listening on a Unix socket. |
| `SERVER_UNIX_SOCKET_PATH` | `/tmp/invidious-companion.sock` | Path to the Unix socket. |
| `SERVER_BASE_PATH` | `/companion` | Base path for all routes. |
| `SERVER_VERIFY_REQUESTS` | `false` | Enable request verification. |
| `SERVER_ENCRYPT_QUERY_PARAMS` | `false` | Enable encryption of query parameters. |
| `SERVER_ENABLE_METRICS` | `false` | Enable Prometheus metrics at `/metrics`. |
| `CACHE_ENABLED` | `true` | Enable caching for YouTube.js. |
| `CACHE_DIRECTORY` | `/var/tmp` | Directory for cache storage. |
| `PROXY` | `null` | Outgoing proxy URL (supports HTTP/HTTPS). |
| `NETWORKING_IPV6_BLOCK` | `null` | IPv6 block for IP rotation (e.g., `2001:db8::/64`). |
| `NETWORKING_VIDEOPLAYBACK_UMP` | `false` | Enable YouTube's UMP format. |
| `JOBS_YOUTUBE_SESSION_PO_TOKEN_ENABLED` | `true` | Enable periodic PO token generation. |
| `YOUTUBE_SESSION_COOKIES` | `""` | YouTube cookies for authenticated requests. |

---

## Project Structure
- `src/main.ts`: Application entry point.
- `src/routes/`: Route handlers (Hono).
- `src/lib/helpers/`: Utility functions (config, metrics, IP rotation, etc.).
- `src/lib/jobs/`: Background tasks (PO token refresh).
- `src/tests/`: Test suite.
- `config/`: Configuration examples and default settings.
- `Dockerfile` & `docker-compose.yaml`: Containerization setup.

---

## Tests
To run the test suite:
```bash
deno task test
```

---

## License
This project is licensed under the terms of the LICENSE file included in the repository.
