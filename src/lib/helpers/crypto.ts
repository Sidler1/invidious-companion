import type { Config } from "./config.ts";

/**
 * AES-256-GCM primitives shared by encryptQuery.ts and verifyRequest.ts.
 *
 * Wire layout (must stay byte-for-byte compatible with
 * `invidious_companion_encrypt` in ../invidious/src/invidious/helpers/utils.cr):
 *   IV[12] || ciphertext || authTag[16]
 * Key: SHA-256(secret_key) — stretches the 16-char secret to 256 bits.
 */

const AES_GCM_IV_LENGTH = 12;

let cachedKey: CryptoKey | null = null;
let cachedKeySource = "";

/** Derive (and memoise) the AES-GCM key for a secret. */
export async function deriveAesKey(secretKey: string): Promise<CryptoKey> {
    if (cachedKey && cachedKeySource === secretKey) {
        return cachedKey;
    }
    const keyMaterial = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(secretKey),
    );
    const key = await crypto.subtle.importKey(
        "raw",
        keyMaterial,
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"],
    );
    cachedKey = key;
    cachedKeySource = secretKey;
    return key;
}

/** Encrypt `plaintext`; returns IV || ciphertext || tag as raw bytes. */
export async function encryptGcm(
    plaintext: string,
    config: Config,
): Promise<Uint8Array> {
    const key = await deriveAesKey(config.server.secret_key);
    const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH));
    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(plaintext),
    );
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return combined;
}

/** Decrypt IV || ciphertext || tag. Throws on tampering or a wrong key. */
export async function decryptGcm(
    bytes: Uint8Array,
    config: Config,
): Promise<string> {
    if (bytes.length <= AES_GCM_IV_LENGTH) {
        throw new Error("Ciphertext too short");
    }
    const key = await deriveAesKey(config.server.secret_key);
    const iv = bytes.slice(0, AES_GCM_IV_LENGTH);
    const ciphertext = bytes.slice(AES_GCM_IV_LENGTH);
    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        ciphertext,
    );
    return new TextDecoder().decode(decrypted);
}
