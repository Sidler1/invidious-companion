import { encodeRFC5987ValueChars } from "./encodeRFC5987ValueChars.ts";

/**
 * Build an `attachment` Content-Disposition for `filename`.
 *
 * Both forms are emitted: `filename` percent-encoded as the ASCII fallback,
 * and `filename*` in the RFC 5987 form for clients that honour it. Used by
 * the two routes that hand a file to the browser — the video proxy
 * (`title` query param) and the download dispatcher's caption branch.
 */
export function attachmentContentDisposition(filename: string): string {
    return `attachment; filename="${encodeURIComponent(filename)}"; ` +
        `filename*=UTF-8''${encodeRFC5987ValueChars(filename)}`;
}
