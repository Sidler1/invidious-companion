/**
 * Consistent logging utility for invidious-companion.
 *
 * Provides structured, leveled logging with clear prefixes:
 *   [INFO]  — Normal operational messages
 *   [WARN]  — Recoverable issues that may need attention
 *   [ERROR] — Failures requiring investigation
 *   [DEBUG] — Verbose detail (only when LOG_LEVEL=debug)
 *
 * All log functions use consistent formatting:
 *   [LEVEL] [context] message
 *
 * Example output:
 *   [INFO]  [SERVER] Started at http://127.0.0.1:8282/companion
 *   [WARN]  [PROXY] Proxy blacklisted for 1h: http://... (after 3 failures)
 *   [ERROR] [CACHE] Decompression failed, deleting corrupted entry
 */

import { redactString } from "./redactSensitive.ts";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

const currentLevel: LogLevel = (() => {
    const env = (Deno.env.get("LOG_LEVEL") || "info").toLowerCase();
    if (env in LEVEL_PRIORITY) return env as LogLevel;
    return "info";
})();

function shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}
/**
 * Info-level log. For normal operational messages.
 * @param context - Short module/context tag (e.g., "SERVER", "PROXY", "CACHE")
 * @param message - Human-readable message
 */
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

// Standardized context tags used across the codebase
export const CTX = {
    SERVER: "SERVER",
    HTTP: "HTTP",
    PROXY: "PROXY",
    CACHE: "CACHE",
    PO_TOKEN: "PO-TOKEN",
    OAUTH: "OAUTH",
    PLAYER: "PLAYER",
    CAPTIONS: "CAPTIONS",
    CONFIG: "CONFIG",
    ENCRYPT: "ENCRYPT",
    SHUTDOWN: "SHUTDOWN",
} as const;
