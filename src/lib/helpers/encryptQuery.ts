import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import type { Config } from "./config.ts";

/**
 * Encrypt query parameters using AES-256-GCM.
 *
 * Migrated from AES-128-ECB which provided no semantic security
 * (identical plaintexts produced identical ciphertexts, no integrity check).
 *
 * AES-GCM provides:
 * - Confidentiality (random IV ensures identical plaintexts produce different ciphertexts)
 * - Integrity (authentication tag detects any tampering)
 *
 * Ciphertext format: base64( IV[12] || authTag[16] || encryptedData )
 */
export const encryptQuery = async (
    queryParams: string,
    config: Config,
): Promise<string> => {
    try {
        const key = await importKey(config.server.secret_key);
        const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV per NIST recommendation
        const encodedData = new TextEncoder().encode(queryParams);

        const ciphertext = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            key,
            encodedData,
        );

        // Concatenate IV + ciphertext (which includes auth tag in Web Crypto API)
        const combined = new Uint8Array(iv.length + ciphertext.byteLength);
        combined.set(iv, 0);
        combined.set(new Uint8Array(ciphertext), iv.length);

        return encodeBase64(combined);
    } catch (err) {
        console.error("[ERROR] Failed to encrypt query parameters:", err);
        return "";
    }
};

export const decryptQuery = async (
    queryParams: string,
    config: Config,
): Promise<string> => {
    try {
        const key = await importKey(config.server.secret_key);
        const combined = decodeBase64(queryParams);

        // Extract IV (first 12 bytes) and ciphertext (rest, includes auth tag)
        const iv = combined.slice(0, 12);
        const ciphertext = combined.slice(12);

        const decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv },
            key,
            ciphertext,
        );

        return new TextDecoder().decode(decrypted);
    } catch (err) {
        console.error("[ERROR] Failed to decrypt query parameters:", err);
        return "";
    }
};

/**
 * Import the secret_key as a CryptoKey for AES-256-GCM.
 * The key is padded to 32 bytes (256 bits) using SHA-256 derivation
 * for backward compatibility with existing 16-char alphanumeric keys.
 */
let cachedKey: CryptoKey | null = null;
let cachedKeySource = "";

async function importKey(secretKey: string): Promise<CryptoKey> {
    // Cache the key to avoid re-importing on every call
    if (cachedKey && cachedKeySource === secretKey) {
        return cachedKey;
    }
    // Derive a 256-bit key from the secret using SHA-256
    // This ensures consistent key material regardless of input length
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
