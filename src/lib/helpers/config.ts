import { z, ZodError } from "zod";
import { parse } from "@std/toml";
import { CTX, logError, logInfo } from "./log.ts";

/**
 * Read a numeric env var, returning undefined when it is unset, blank, or not
 * a finite number. Lets callers use `?? default` so an explicit `0` is
 * honoured (unlike `Number(env) || default`, where `0`/`NaN` silently fall
 * back to the default).
 */
function envNumber(name: string): number | undefined {
    const raw = Deno.env.get(name);
    if (raw === undefined || raw.trim() === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
}

export const ConfigSchema = z.object({
    server: z.object({
        port: z.number().int().min(1).max(65535).default(
            envNumber("PORT") ?? 8282,
        ),
        host: z.string().default(Deno.env.get("HOST") || "127.0.0.1"),
        use_unix_socket: z.boolean().default(
            Deno.env.get("SERVER_USE_UNIX_SOCKET") === "true" || false,
        ),
        unix_socket_path: z.string().default(
            Deno.env.get("SERVER_UNIX_SOCKET_PATH") ||
                "/tmp/invidious-companion.sock",
        ),
        base_path: z.string()
            .default(Deno.env.get("SERVER_BASE_PATH") || "/companion")
            .refine(
                (path) => path.startsWith("/"),
                {
                    message:
                        "SERVER_BASE_PATH must start with a forward slash (/). Example: '/companion'",
                },
            )
            .refine(
                (path) => !path.endsWith("/") || path === "/",
                {
                    message:
                        "SERVER_BASE_PATH must not end with a forward slash (/) unless it's the root path. Example: '/companion' not '/companion/'",
                },
            )
            .refine(
                (path) => !path.includes("//"),
                {
                    message:
                        "SERVER_BASE_PATH must not contain double slashes (//). Example: '/companion' not '//companion' or '/comp//anion'",
                },
            ),
        secret_key: z.preprocess(
            (val) => {
                const envVal = Deno.env.get("SERVER_SECRET_KEY");
                if (val === undefined || val === null || val === "") {
                    return envVal ?? "";
                }
                return val;
            },
            z.string({
                required_error:
                    "SERVER_SECRET_KEY is required and must be exactly 16 alphanumeric characters.",
            }).length(
                16,
                "SERVER_SECRET_KEY must be exactly 16 characters long.",
            ).regex(
                /^[a-zA-Z0-9]+$/,
                "SERVER_SECRET_KEY contains invalid characters. Only alphanumeric characters (a-z, A-Z, 0-9) are allowed. Please generate a valid key using 'pwgen 16 1' or ensure your key contains only letters and numbers.",
            ),
        ),
        verify_requests: z.boolean().default(
            Deno.env.get("SERVER_VERIFY_REQUESTS") === "true" || false,
        ),
        encrypt_query_params: z.boolean().default(
            Deno.env.get("SERVER_ENCRYPT_QUERY_PARAMS") === "true" || false,
        ),
        enable_metrics: z.boolean().default(
            Deno.env.get("SERVER_ENABLE_METRICS") === "true" || false,
        ),
    }).strict().default({}),
    cache: z.object({
        enabled: z.boolean().default(
            Deno.env.get("CACHE_ENABLED") !== "false",
        ),
        directory: z.string().default(
            Deno.env.get("CACHE_DIRECTORY") || "/var/tmp",
        ),
        // Capped at 6h (21600s): deciphered googlevideo URLs carry an `expire`
        // timestamp ~6h out, after which videoPlaybackProxy rejects them. A
        // longer TTL would serve cached-but-expired URLs (400 "Expired URL").
        ttl_seconds: z.number().int().min(0).max(21600).default(
            envNumber("CACHE_TTL_SECONDS") ?? 3600,
        ),
    }).strict().default({}),
    networking: z.object({
        proxy: z.string().nullable().default(Deno.env.get("PROXY") || null),
        ipv6_block: z.string().nullable().default(
            Deno.env.get("NETWORKING_IPV6_BLOCK") || null,
        ),
        fetch: z.object({
            timeout_ms: z.number().int().min(1000).max(300_000).default(
                envNumber("NETWORKING_FETCH_TIMEOUT_MS") ?? 30_000,
            ),
            retry: z.object({
                enabled: z.boolean().default(
                    Deno.env.get("NETWORKING_FETCH_RETRY_ENABLED") === "true" ||
                        false,
                ),
                times: z.number().int().min(1).max(10).optional().default(
                    envNumber("NETWORKING_FETCH_RETRY_TIMES") ?? 1,
                ),
                initial_debounce: z.number().optional().default(
                    envNumber("NETWORKING_FETCH_RETRY_INITIAL_DEBOUNCE") ?? 0,
                ),
                debounce_multiplier: z.number().optional().default(
                    envNumber("NETWORKING_FETCH_RETRY_DEBOUNCE_MULTIPLIER") ??
                        0,
                ),
            }).strict().default({}),
        }).strict().default({}),
        videoplayback: z.object({
            ump: z.boolean().default(
                Deno.env.get("NETWORKING_VIDEOPLAYBACK_UMP") === "true" ||
                    false,
            ),
        }).strict().default({}),
        // Best-effort rate limiting of outbound YouTube requests. Because the
        // proxy pool is failover-only (one active egress IP at a time), this
        // effectively caps how hard a single IP is hit — a strong anti-block
        // signal. Disabled by default to preserve existing throughput.
        rate_limit: z.object({
            enabled: z.boolean().default(
                Deno.env.get("NETWORKING_RATE_LIMIT_ENABLED") === "true" ||
                    false,
            ),
            // Max simultaneous in-flight requests to YouTube.
            max_concurrent: z.number().int().min(1).max(1000).default(
                envNumber("NETWORKING_RATE_LIMIT_MAX_CONCURRENT") ?? 8,
            ),
            // Minimum spacing between request starts (0 = no spacing).
            min_interval_ms: z.number().int().min(0).max(60_000).default(
                envNumber("NETWORKING_RATE_LIMIT_MIN_INTERVAL_MS") ?? 0,
            ),
        }).strict().default({}),
        // NEW: Multiple proxies support for automatic failover when YouTube blocks one.
        // Use the provided get_good_proxies_for_companion.py script to generate healthy proxies.
        // Performance optimized: pre-created HttpClients, fast round-robin/random selection with cooldown on failures.
        proxy_pool: z.object({
            enabled: z.boolean().default(false),
            rotation: z.enum(["round-robin", "random"]).default("round-robin"),
            health_check: z.boolean().default(true),
            proxies: z.array(
                z.string().refine(
                    (url) => {
                        try {
                            const parsed = new URL(url);
                            return ["http:", "https:", "socks5:", "socks4:"]
                                .includes(parsed.protocol);
                        } catch {
                            return false;
                        }
                    },
                    {
                        message:
                            "Each proxy must be a valid URL with http, https, socks4, or socks5 protocol",
                    },
                ),
            ).default([]),
        }).strict().default({}),
    }).strict().default({}),
    jobs: z.object({
        youtube_session: z.object({
            po_token_enabled: z.boolean().default(
                Deno.env.get("JOBS_YOUTUBE_SESSION_PO_TOKEN_ENABLED") !==
                    "false",
            ),
            frequency: z.preprocess(
                (val) => {
                    const envVal = Deno.env.get(
                        "JOBS_YOUTUBE_SESSION_FREQUENCY",
                    );
                    if (val === undefined || val === null || val === "") {
                        return envVal ?? "*/5 * * * *";
                    }
                    return val;
                },
                z.string()
                    .refine(
                        (val) => {
                            const parts = val.trim().split(/\s+/);
                            if (parts.length !== 5) return false;
                            // Validate each field against allowed cron patterns
                            const cronFieldPattern =
                                /^(\*|\d{1,2})([-/,]\d{1,2})*$/;
                            return parts.every((part) =>
                                cronFieldPattern.test(part)
                            );
                        },
                        {
                            message:
                                "JOBS_YOUTUBE_SESSION_FREQUENCY must be a valid 5-part cron expression (e.g., '*/5 * * * *')",
                        },
                    )
                    .refine(
                        (val) => {
                            const parts = val.trim().split(/\s+/);
                            // Bounds check: minute 0-59, hour 0-23, day 1-31, month 1-12, dow 0-7
                            const bounds = [
                                [0, 59],
                                [0, 23],
                                [1, 31],
                                [1, 12],
                                [0, 7],
                            ];
                            return parts.every((part, i) => {
                                if (part === "*") return true;
                                const nums = part.replace(/^\*\//, "").split(
                                    /[,\-/]/,
                                ).map(Number);
                                return nums.every((n) =>
                                    !isNaN(n) && n >= bounds[i][0] &&
                                    n <= bounds[i][1]
                                );
                            });
                        },
                        {
                            message:
                                "JOBS_YOUTUBE_SESSION_FREQUENCY contains out-of-bounds values in cron fields",
                        },
                    ),
            ).default("*/5 * * * *"),
            // How long a generated session (visitor_data + BotGuard/integrity
            // token) is kept before a full regeneration. The `frequency` cron
            // now only *checks* the session; it skips the expensive re-
            // attestation (and visitor_data churn) while the session is
            // younger than this. 0 = regenerate on every cron tick (legacy
            // behaviour). Early token expiry or a detected block still forces
            // an immediate regeneration regardless of this value.
            session_lifetime_hours: z.number().min(0).max(168).default(
                envNumber("JOBS_YOUTUBE_SESSION_LIFETIME_HOURS") ?? 6,
            ),
        }).strict().default({}),
    }).strict().default({}),
    youtube_session: z.object({
        oauth_enabled: z.boolean().default(
            Deno.env.get("YOUTUBE_SESSION_OAUTH_ENABLED") === "true" || false,
        ),
        cookies: z.string().default(
            Deno.env.get("YOUTUBE_SESSION_COOKIES") || "",
        ),
        player_id: z.string().optional().default(
            () => Deno.env.get("YOUTUBE_SESSION_PLAYER_ID") || "",
        ),
        // Locale/geo pinning for the Innertube context. Leave empty to let
        // youtubei.js pick defaults. When using geographically diverse
        // proxies, pin these to match the egress country so the request
        // locale doesn't contradict the egress IP's geolocation.
        gl: z.string().default(Deno.env.get("YOUTUBE_SESSION_GL") || ""),
        hl: z.string().default(Deno.env.get("YOUTUBE_SESSION_HL") || ""),
    }).strict().default({}),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;

export async function parseConfig() {
    const configFileName = Deno.env.get("CONFIG_FILE") || "config/config.toml";
    const configFileContents = await Deno.readTextFile(configFileName).catch(
        () => null,
    );
    if (configFileContents) {
        logInfo(CTX.CONFIG, "Using custom settings local file");
    } else {
        logInfo(CTX.CONFIG, "No local config file found, using defaults");
    }

    try {
        const rawConfig = configFileContents ? parse(configFileContents) : {};
        const validatedConfig = ConfigSchema.parse(rawConfig);

        logInfo(CTX.CONFIG, `Configuration loaded`);

        return validatedConfig;
    } catch (err) {
        let errorMessage =
            "There is an error in your configuration, check your environment variables";
        if (configFileContents) {
            errorMessage +=
                ` or in your configuration file located at ${configFileName}`;
        }
        logError(CTX.CONFIG, errorMessage);
        if (err instanceof ZodError) {
            logError(
                CTX.CONFIG,
                err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(
                    "; ",
                ),
            );
            // Include detailed error information in the thrown error for testing
            const detailedMessage = err.issues.map((issue) =>
                `${issue.path.join(".")}: ${issue.message}`
            ).join("; ");
            throw new Error(
                `Failed to parse configuration file: ${detailedMessage}`,
            );
        }
        // rethrow error if not Zod
        throw err;
    }
}
