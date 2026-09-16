import { decodeBase64 } from "@std/encoding/base64";
import type { Config } from "./config.ts";
import { decryptGcm } from "./crypto.ts";

/**
 * Verify the `check` query parameter Invidious attaches to companion
 * requests. The token is base64url( IV[12] || ciphertext || authTag[16] )
 * of "<unix seconds>|<videoId>" (see crypto.ts for the key derivation).
 *
 * Replay protection: tokens older than MAX_CHECK_AGE_SECONDS or more than
 * MAX_CLOCK_SKEW_SECONDS in the future are rejected. Invidious signs once
 * per page render, so the 6 h window must not shrink without changing
 * Invidious in lockstep.
 */
const MAX_CHECK_AGE_SECONDS = 6 * 60 * 60;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

function base64UrlToStandard(value: string): string {
    const standard = value.replace(/-/g, "+").replace(/_/g, "/");
    const padding = (4 - (standard.length % 4)) % 4;
    return standard + "=".repeat(padding);
}

export const verifyRequest = async (
    stringToCheck: string,
    videoId: string,
    config: Config,
): Promise<boolean> => {
    let decryptedData: string;
    try {
        decryptedData = await decryptGcm(
            decodeBase64(base64UrlToStandard(stringToCheck)),
            config,
        );
    } catch {
        return false;
    }

    const separator = decryptedData.indexOf("|");
    if (separator === -1) {
        return false;
    }
    const parsedTimestamp = Number(decryptedData.slice(0, separator));
    const parsedVideoId = decryptedData.slice(separator + 1);

    if (parsedVideoId !== videoId) {
        return false;
    }
    // Number("123abc") is NaN; parseInt would have accepted it as 123.
    if (!Number.isInteger(parsedTimestamp)) {
        return false;
    }

    const timestampNow = Math.round(Date.now() / 1000);
    if (timestampNow - parsedTimestamp > MAX_CHECK_AGE_SECONDS) {
        return false;
    }
    if (parsedTimestamp - timestampNow > MAX_CLOCK_SKEW_SECONDS) {
        return false;
    }
    return true;
};
