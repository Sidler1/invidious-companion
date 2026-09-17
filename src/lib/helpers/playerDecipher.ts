import type { Innertube } from "youtubei.js";

type PlayerLike = Innertube["session"]["player"];

/** Which Innertube client supplied each streaming-data array. */
export interface StreamingDataClients {
    formats: string;
    adaptiveFormats: string;
}

export const DEFAULT_STREAMING_DATA_CLIENTS: StreamingDataClients = {
    formats: "WEB",
    adaptiveFormats: "WEB",
};

/** Structural view of a youtubei.js `Format` — only what we call. */
export interface Decipherable {
    decipher(player?: PlayerLike): Promise<string>;
}

export interface RawFormat {
    url?: string;
    signatureCipher?: string;
    [key: string]: unknown;
}

export interface RawStreamingData {
    formats?: RawFormat[];
    adaptiveFormats?: RawFormat[];
    [key: string]: unknown;
}

/**
 * IOS/ANDROID-family clients return plain URLs that need neither signature
 * nor n-parameter deciphering and must not carry the web session's GVS pot.
 */
export function needsDecipher(clientName: string): boolean {
    return !clientName.includes("IOS") && !clientName.includes("ANDROID");
}

/**
 * Force `alr=no` and append the session PO token (the GVS `pot` web-family
 * clients must carry on `videoplayback`). youtubei.js's `Format.decipher()`
 * only descrambles signature/nsig; without `pot` the CDN throttles/403s.
 */
export function finalizeStreamUrl(
    url: string,
    sessionPoToken: string | undefined,
): string {
    const withAlr = url.includes("alr=yes")
        ? url.replace("alr=yes", "alr=no")
        : `${url}&alr=no`;
    if (sessionPoToken && !withAlr.includes("pot=")) {
        return `${withAlr}&pot=${encodeURIComponent(sessionPoToken)}`;
    }
    return withAlr;
}

async function decipherFormats(
    parsed: Decipherable[],
    raw: RawFormat[],
    player: PlayerLike,
    sessionPoToken: string | undefined,
): Promise<RawFormat[]> {
    const count = Math.min(parsed.length, raw.length);
    const out: RawFormat[] = [];
    for (let index = 0; index < count; index++) {
        const { signatureCipher: _dropped, ...rest } = raw[index];
        const url = finalizeStreamUrl(
            await parsed[index].decipher(player),
            sessionPoToken,
        );
        out.push({ ...rest, url });
    }
    return out;
}

/**
 * Return a copy of `raw` with deciphered, finalised URLs. `parsed` is the
 * youtubei.js `streaming_data` built from the same response (its format
 * arrays are index-aligned with `raw`, since v18 `parseFormats` is a plain
 * `map`). Arrays supplied by an IOS/ANDROID client are returned as-is.
 */
export async function decipherStreamingData(
    parsed: { formats: Decipherable[]; adaptive_formats: Decipherable[] },
    raw: RawStreamingData,
    opts: {
        player: PlayerLike;
        sessionPoToken: string | undefined;
        clients: StreamingDataClients;
    },
): Promise<RawStreamingData> {
    const formats = raw.formats && needsDecipher(opts.clients.formats)
        ? await decipherFormats(
            parsed.formats,
            raw.formats,
            opts.player,
            opts.sessionPoToken,
        )
        : raw.formats;
    const adaptiveFormats = raw.adaptiveFormats &&
            needsDecipher(opts.clients.adaptiveFormats)
        ? await decipherFormats(
            parsed.adaptive_formats,
            raw.adaptiveFormats,
            opts.player,
            opts.sessionPoToken,
        )
        : raw.adaptiveFormats;
    return { ...raw, formats, adaptiveFormats };
}
