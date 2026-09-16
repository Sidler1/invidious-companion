import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import type { Config } from "./config.ts";
import { CTX, logError } from "./log.ts";
import { decryptGcm, encryptGcm } from "./crypto.ts";

/**
 * Encrypt query parameters using AES-256-GCM.
 *
 * Ciphertext format: base64( IV[12] || ciphertext || authTag[16] ), see
 * crypto.ts. Returns "" on failure.
 */
export const encryptQuery = async (
    queryParams: string,
    config: Config,
): Promise<string> => {
    try {
        return encodeBase64(await encryptGcm(queryParams, config));
    } catch (err) {
        logError(CTX.ENCRYPT, "Failed to encrypt query parameters", err);
        return "";
    }
};

/**
 * Decrypt a value produced by encryptQuery. Returns "" on any failure
 * (malformed base64, tampered data, wrong key); callers treat "" as 400.
 */
export const decryptQuery = async (
    queryParams: string,
    config: Config,
): Promise<string> => {
    try {
        return await decryptGcm(decodeBase64(queryParams), config);
    } catch (err) {
        logError(CTX.ENCRYPT, "Failed to decrypt query parameters", err);
        return "";
    }
};
