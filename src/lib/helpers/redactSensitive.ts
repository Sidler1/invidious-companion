/**
 * Redact sensitive information from strings before logging.
 *
 * Ensures auth headers, bearer tokens, query params containing secrets,
 * and other sensitive data are never written to logs in plain text.
 */

const SENSITIVE_PARAM_NAMES = [
    "key",
    "token",
    "secret",
    // server.secret_key, forwarded verbatim in some error/debug contexts.
    "secret_key",
    "authorization",
    "pot",
    "sig",
    "signature",
    // Egress IP bound into googlevideo URLs (latestVersion.ts PRIVATE_PARAM_NAMES).
    "ip",
    // Encrypted pot/ip blob on /videoplayback?enc=true.
    "data",
    "cookies",
    // verifyRequest's signed request token (see routes/guards.ts).
    "check",
];

const BEARER_PATTERN = /Bearer\s+\S+/gi;
const AUTH_HEADER_PATTERN = /Authorization:\s*\S+/gi;
// `//user:pass@host` userinfo in any URL embedded in a log line/message.
const USERINFO_PATTERN = /\/\/[^/\s@]+@/g;

function paramPattern(param: string): RegExp {
    // Matches the param name at the start of the string or after whitespace,
    // not only after "?"/"&" — e.g. a log line like "params: key=secret"
    // (no query-string delimiter) must still be caught.
    return new RegExp(
        `(^|[?&\\s])${param}=[^&\\s)'"]*`,
        "gi",
    );
}

/**
 * Redact sensitive query parameters from a URL string.
 * Replaces values of known sensitive param names with "[REDACTED]".
 */
export function redactUrl(urlStr: string): string {
    let result = urlStr;
    for (const param of SENSITIVE_PARAM_NAMES) {
        result = result.replace(paramPattern(param), `$1${param}=[REDACTED]`);
    }
    result = result.replace(USERINFO_PATTERN, "//[REDACTED]@");
    return result;
}

/**
 * Redact sensitive patterns from an arbitrary string (log message, error, etc.).
 */
export function redactString(str: string): string {
    let result = str;
    result = result.replace(BEARER_PATTERN, "Bearer [REDACTED]");
    result = result.replace(
        AUTH_HEADER_PATTERN,
        "Authorization: [REDACTED]",
    );
    result = result.replace(USERINFO_PATTERN, "//[REDACTED]@");
    // Redact query param values for known sensitive names
    for (const param of SENSITIVE_PARAM_NAMES) {
        result = result.replace(paramPattern(param), `$1${param}=[REDACTED]`);
    }
    return result;
}
