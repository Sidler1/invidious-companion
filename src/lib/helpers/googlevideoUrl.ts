/**
 * Helpers for validating googlevideo.com URLs handled by the video proxy.
 *
 * The host check is anchored on purpose: an unanchored regex would accept
 * "rr3.googlevideo.com.evil.com" or "rr3.googlevideo.com@evil.com" and turn
 * the proxy into an open relay / SSRF primitive.
 */
export const GOOGLEVIDEO_HOST_PATTERN = /^[\w-]+\.googlevideo\.com$/;

// Invidious's valid_googlevideo_redirect? also accepts *.c.youtube.com hosts
// (see proxy_hosts.cr) — googlevideo redirects can land there. Only used for
// validating the `Location` header of a hop we're already on; the initial
// `host` query param check keeps using GOOGLEVIDEO_HOST_PATTERN unchanged.
export const GOOGLEVIDEO_REDIRECT_HOST_PATTERN =
    /^[a-z0-9-]+\.(?:googlevideo|c\.youtube)\.com$/;

export function isGooglevideoHost(host: string | undefined): boolean {
    return !!host && GOOGLEVIDEO_HOST_PATTERN.test(host);
}

/**
 * Resolve a redirect `Location` header against the request URL and accept it
 * only if it points at an https googlevideo (or c.youtube) host, with no
 * userinfo or explicit port. Returns the absolute URL or null when the
 * target must not be followed.
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
    if (target.username || target.password || target.port) return null;
    if (!GOOGLEVIDEO_REDIRECT_HOST_PATTERN.test(target.hostname)) return null;
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
