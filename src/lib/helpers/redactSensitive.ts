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
    "authorization",
    "pot",
    "sig",
    "signature",
];

const BEARER_PATTERN = /Bearer\s+\S+/gi;
const AUTH_HEADER_PATTERN = /Authorization:\s*\S+/gi;

/**
 * Redact sensitive query parameters from a URL string.
 * Replaces values of known sensitive param names with "[REDACTED]".
 */
export function redactUrl(urlStr: string): string {
    let result = urlStr;
    for (const param of SENSITIVE_PARAM_NAMES) {
        const paramPattern = new RegExp(
            `([?&])${param}=[^&]*`,
            "gi",
        );
        result = result.replace(paramPattern, `$1${param}=[REDACTED]`);
    }
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
    // Redact query param values for known sensitive names
    for (const param of SENSITIVE_PARAM_NAMES) {
        const paramPattern = new RegExp(
            `([?&])${param}=[^&\\s]*`,
            "gi",
        );
        result = result.replace(paramPattern, `$1${param}=[REDACTED]`);
    }
    return result;
}
