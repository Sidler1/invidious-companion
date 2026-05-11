import { decodeBase64 } from "@std/encoding/base64";
import type { Config } from "./config.ts";

/**
 * Verify a request check parameter using AES-256-GCM decryption.
 *
 * Migrated from AES-128-ECB which provided no semantic security.
 * The check parameter contains: base64( IV[12] || authTag[16] || encrypted("timestamp|videoId") )
 *
 * Also fixed: the old code only checked if the timestamp was NOT too far in the future,
 * but never checked if it was too old (no replay attack protection). Now enforces
 * a 6-hour maximum age and a 5-minute future tolerance.
 */
export const verifyRequest = async (
    stringToCheck: string,
    videoId: string,
    config: Config,
): Promise<boolean> => {
    try {
        const key = await importKeyForVerify(config.server.secret_key);
        const combined = decodeBase64(
            stringToCheck.replace(/-/g, "+").replace(/_/g, "/"),
        );

        // Extract IV (first 12 bytes) and ciphertext (rest, includes auth tag)
        const iv = combined.slice(0, 12);
        const ciphertext = combined.slice(12);

        const decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv },
            key,
            ciphertext,
        );

        const decryptedData = new TextDecoder().decode(decrypted);
        const [parsedTimestamp, parsedVideoId] = decryptedData.split("|");
        const parsedTimestampInt = parseInt(parsedTimestamp);
        const timestampNow = Math.round(Date.now() / 1000);

        if (parsedVideoId !== videoId) {
            return false;
        }

        // Reject timestamps older than 6 hours (replay attack protection)
        if (timestampNow - parsedTimestampInt > 6 * 60 * 60) {
            return false;
        }

        // Reject timestamps more than 5 minutes in the future (clock skew tolerance)
        if (parsedTimestampInt - timestampNow > 5 * 60) {
            return false;
        }
    } catch (_) {
        return false;
    }
    return true;
};

let cachedKey: CryptoKey | null = null;
let cachedKeySource = "";

async function importKeyForVerify(secretKey: string): Promise<CryptoKey> {
    if (cachedKey && cachedKeySource === secretKey) {
        return cachedKey;
    }
    const keyMaterial = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(secretKey),
    );
    cachedKey = await crypto.subtle.importKey(
        "raw",
        keyMaterial,
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"],
    );
    cachedKeySource = secretKey;
    return cachedKey;
}
