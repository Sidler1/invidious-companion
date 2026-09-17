/**
 * Detection of YouTube anti-bot responses and safe logging of proxy URLs.
 */
export const YOUTUBE_BLOCK_SIGNALS = [
    "unusual traffic",
    "protect our community",
    "please sign in to confirm you're not a bot",
    "captcha",
];

/**
 * Read the first chunk from the start of a (cloned) body, truncated to
 * 8 KiB, and look for known block phrases — a signal beyond that first
 * chunk is not seen. Never called for binary content — see checkYouTubeBlock.
 */
async function bodyHasBlockSignal(response: Response): Promise<boolean> {
    try {
        const cloned = response.clone();
        const reader = cloned.body?.getReader();
        if (!reader) return false;
        const { value } = await reader.read();
        // Cancel this tee branch so no further chunks are buffered for it,
        // but do NOT await it: a tee branch's cancel() only settles once the
        // other branch (the caller's original body) has been drained, and the
        // caller reads that body only after we return. Awaiting here
        // deadlocks on any body larger than one chunk (real YouTube
        // responses), which left the process with no pending work and
        // "Top-level await promise never resolved" at startup.
        reader.cancel().catch(() => {});
        if (!value) return false;
        const text = new TextDecoder().decode(value.slice(0, 8192))
            .toLowerCase();
        return YOUTUBE_BLOCK_SIGNALS.some((s) => text.includes(s));
    } catch {
        // Can't read body — treat as not blocked.
        return false;
    }
}

/**
 * Check if a YouTube response contains bot detection signals.
 *
 * IMPORTANT: Only checks API/HTML responses (JSON, HTML, text content types).
 * Video CDN responses (video/mp4, application/octet-stream) are NEVER checked
 * because:
 * 1. YouTube's CDN legitimately returns 403 for unsupported request patterns
 *    (e.g., expired URLs, invalid ranges) — these are NOT bot blocks
 * 2. Reading video response bodies would buffer entire videos into memory (OOM)
 * 3. Treating video CDN 403s as bot blocks would falsely blacklist proxies
 *
 * A block is ONLY reported when the body carries one of YOUTUBE_BLOCK_SIGNALS.
 * A 403/429 with no such phrase (e.g. a CDN 403 served as text/plain, or a
 * generic 429) is not a bot block: treating it as one blacklisted proxies
 * and triggered session regenerations for ordinary CDN errors.
 *
 * Checked statuses: 403, 429 and 200 (YouTube returns 200 OK with the block
 * message inside playabilityStatus for Innertube calls).
 */
export async function checkYouTubeBlock(response: Response): Promise<boolean> {
    const contentType = (response.headers.get("content-type") || "")
        .toLowerCase();
    const isTextContent = contentType.includes("json") ||
        contentType.includes("html") ||
        contentType.includes("text");
    if (!isTextContent) {
        return false;
    }
    const inspectedStatus = response.status === 403 ||
        response.status === 429 || response.status === 200;
    if (!inspectedStatus) {
        return false;
    }
    return await bodyHasBlockSignal(response);
}

/**
 * Mask credentials in proxy URLs for safe logging.
 * http://user:pass@1.2.3.4:8080 → http://1.2.3.4:8080
 */
export function maskProxyUrl(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.username || parsed.password) {
            return `${parsed.protocol}//${parsed.host}`;
        }
        return url;
    } catch {
        return url;
    }
}
