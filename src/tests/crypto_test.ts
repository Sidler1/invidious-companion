import { assert, assertEquals, assertRejects } from "./deps.ts";
import { decryptGcm, encryptGcm } from "../lib/helpers/crypto.ts";
import { decryptQuery, encryptQuery } from "../lib/helpers/encryptQuery.ts";
import { makeTestConfig } from "./helpers/testConfig.ts";

const config = makeTestConfig();

Deno.test("encryptGcm output is IV(12) + ciphertext + tag(16)", async () => {
    const plaintext = "hello";
    const bytes = await encryptGcm(plaintext, config);
    assertEquals(bytes.length, 12 + plaintext.length + 16);
});

Deno.test("decryptGcm round-trips encryptGcm output", async () => {
    const bytes = await encryptGcm('[["pot","abc"],["ip","1.2.3.4"]]', config);
    assertEquals(
        await decryptGcm(bytes, config),
        '[["pot","abc"],["ip","1.2.3.4"]]',
    );
});

Deno.test("two encryptions of the same plaintext differ (random IV)", async () => {
    const a = await encryptGcm("same", config);
    const b = await encryptGcm("same", config);
    assert(a.join(",") !== b.join(","));
});

Deno.test("decryptGcm rejects a tampered byte", async () => {
    const bytes = await encryptGcm("payload", config);
    const tampered = Uint8Array.from(bytes);
    tampered[tampered.length - 1] ^= 0x01;
    await assertRejects(() => decryptGcm(tampered, config));
});

Deno.test("decryptGcm rejects input shorter than an IV", async () => {
    await assertRejects(
        () => decryptGcm(new Uint8Array(5), config),
        Error,
        "Ciphertext too short",
    );
});

Deno.test("decryptGcm rejects a different secret key", async () => {
    const bytes = await encryptGcm("payload", config);
    const other = makeTestConfig({
        server: { secret_key: "bbbbbbbbbbbbbbbb" },
    });
    await assertRejects(() => decryptGcm(bytes, other));
});

Deno.test("encryptQuery/decryptQuery round-trip via base64", async () => {
    const encrypted = await encryptQuery("pot=abc&ip=1.2.3.4", config);
    assert(encrypted.length > 0);
    assertEquals(await decryptQuery(encrypted, config), "pot=abc&ip=1.2.3.4");
});

Deno.test("decryptQuery returns an empty string on garbage input", async () => {
    assertEquals(await decryptQuery("not-base64!!", config), "");
});

Deno.test("encryptQuery throws when the crypto primitive fails", async () => {
    const original = crypto.subtle.encrypt;
    Object.defineProperty(crypto.subtle, "encrypt", {
        value: () => Promise.reject(new Error("simulated crypto failure")),
        configurable: true,
        writable: true,
    });
    try {
        await assertRejects(
            () => encryptQuery("pot=abc", config),
            Error,
            "Query encryption failed",
        );
    } finally {
        Object.defineProperty(crypto.subtle, "encrypt", {
            value: original,
            configurable: true,
            writable: true,
        });
    }
});
