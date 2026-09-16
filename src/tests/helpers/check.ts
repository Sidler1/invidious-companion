import { encodeBase64 } from "@std/encoding/base64";
import type { Config } from "../../lib/helpers/config.ts";
import { encryptGcm } from "../../lib/helpers/crypto.ts";

/**
 * Build a `check` token the way Invidious does
 * (`invidious_companion_encrypt` in ../invidious/src/invidious/helpers/utils.cr):
 * plaintext "<unix seconds>|<videoId>", AES-256-GCM with the SHA-256-stretched
 * secret, layout IV[12] || ciphertext || tag[16], base64url with padding.
 */
export async function makeCheck(
    videoId: string,
    config: Config,
    timestampSeconds: number = Math.round(Date.now() / 1000),
): Promise<string> {
    const bytes = await encryptGcm(`${timestampSeconds}|${videoId}`, config);
    return encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_");
}
