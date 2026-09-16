/**
 * Helpers for validating googlevideo.com URLs handled by the video proxy.
 *
 * The host check is anchored on purpose: an unanchored regex would accept
 * "rr3.googlevideo.com.evil.com" or "rr3.googlevideo.com@evil.com" and turn
 * the proxy into an open relay / SSRF primitive.
 */
export const GOOGLEVIDEO_HOST_PATTERN = /^[\w-]+\.googlevideo\.com$/;

export function isGooglevideoHost(host: string | undefined): boolean {
    return !!host && GOOGLEVIDEO_HOST_PATTERN.test(host);
}

/**
 * Resolve a redirect `Location` header against the request URL and accept it
 * only if it points at an https googlevideo host. Returns the absolute URL or
 * null when the target must not be followed.
 */
export function resolveRedirectTarget(
    locationHeader: string,
    base: string,
): string | null {
    let target: URL;
    try {
        target = new URL(locationHeader, base);
    } catch {
        return null;
    }
    if (target.protocol !== "https:") return null;
    if (!isGooglevideoHost(target.hostname)) return null;
    return target.toString();
}

const UNSIGNED_INTEGER = /^\d+$/;

/**
 * `expire` is a unix timestamp in seconds. A non-integer value (which
 * `Number()` would turn into NaN and let through a `<` comparison) is rejected.
 */
export function isValidExpire(
    expire: string | undefined,
    nowSeconds: number,
): boolean {
    if (!expire || !UNSIGNED_INTEGER.test(expire)) return false;
    return Number(expire) >= nowSeconds;
}
