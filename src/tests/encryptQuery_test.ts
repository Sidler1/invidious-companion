import { assert, assertEquals, assertNotEquals } from "./deps.ts";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { decryptQuery, encryptQuery } from "../lib/helpers/encryptQuery.ts";
import type { Config } from "../lib/helpers/config.ts";

const config = {
    server: { secret_key: "aaaaaaaaaaaaaaaa" },
} as unknown as Config;
const otherKeyConfig = {
    server: { secret_key: "bbbbbbbbbbbbbbbb" },
} as unknown as Config;

const IV_BYTES = 12;
const TAG_BYTES = 16;

Deno.test("encryptQuery/decryptQuery", async (t) => {
    await t.step("emits base64(IV[12] || ciphertext || tag[16])", async () => {
        const plaintext = "hello";
        const token = await encryptQuery(plaintext, config);
        const bytes = decodeBase64(token);
        assertEquals(bytes.length, IV_BYTES + plaintext.length + TAG_BYTES);
    });

    await t.step(
        "uses a fresh IV so equal plaintexts encrypt differently",
        async () => {
            const first = await encryptQuery("same", config);
            const second = await encryptQuery("same", config);
            assertNotEquals(first, second);
            assertNotEquals(
                encodeBase64(decodeBase64(first).slice(0, IV_BYTES)),
                encodeBase64(decodeBase64(second).slice(0, IV_BYTES)),
            );
        },
    );

    await t.step(
        "fails closed when the ciphertext is tampered with",
        async () => {
            const token = await encryptQuery("payload", config);
            const bytes = decodeBase64(token);
            bytes[IV_BYTES] ^= 0xff; // first ciphertext byte
            assertEquals(await decryptQuery(encodeBase64(bytes), config), "");
        },
    );

    await t.step(
        "fails closed when the auth tag is tampered with",
        async () => {
            const token = await encryptQuery("payload", config);
            const bytes = decodeBase64(token);
            bytes[bytes.length - 1] ^= 0x01; // last tag byte
            assertEquals(await decryptQuery(encodeBase64(bytes), config), "");
        },
    );

    await t.step("fails closed with a different secret key", async () => {
        const token = await encryptQuery("payload", config);
        assertEquals(await decryptQuery(token, otherKeyConfig), "");
    });

    await t.step("fails closed on input shorter than an IV", async () => {
        assertEquals(
            await decryptQuery(encodeBase64(new Uint8Array(5)), config),
            "",
        );
    });

    await t.step("round-trips an empty string", async () => {
        const token = await encryptQuery("", config);
        assert(token.length > 0);
        assertEquals(await decryptQuery(token, config), "");
    });
});
