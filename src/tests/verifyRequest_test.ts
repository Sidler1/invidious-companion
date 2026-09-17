import { assert, assertEquals } from "./deps.ts";
import { verifyRequest } from "../lib/helpers/verifyRequest.ts";
import { encryptGcm } from "../lib/helpers/crypto.ts";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { makeTestConfig } from "./helpers/testConfig.ts";
import { makeCheck } from "./helpers/check.ts";

const config = makeTestConfig();
const VIDEO_ID = "jNQXAC9IVRw";
const nowSeconds = () => Math.round(Date.now() / 1000);

Deno.test("verifyRequest accepts a fresh check for the right video", async () => {
    const check = await makeCheck(VIDEO_ID, config);
    assertEquals(await verifyRequest(check, VIDEO_ID, config), true);
});

Deno.test("verifyRequest rejects a check for a different video", async () => {
    const check = await makeCheck(VIDEO_ID, config);
    assertEquals(await verifyRequest(check, "dQw4w9WgXcQ", config), false);
});

Deno.test("verifyRequest rejects a check older than six hours", async () => {
    const check = await makeCheck(
        VIDEO_ID,
        config,
        nowSeconds() - 6 * 60 * 60 - 60,
    );
    assertEquals(await verifyRequest(check, VIDEO_ID, config), false);
});

Deno.test("verifyRequest accepts a check five hours old", async () => {
    const check = await makeCheck(VIDEO_ID, config, nowSeconds() - 5 * 60 * 60);
    assertEquals(await verifyRequest(check, VIDEO_ID, config), true);
});

Deno.test("verifyRequest rejects a check more than five minutes in the future", async () => {
    const check = await makeCheck(VIDEO_ID, config, nowSeconds() + 10 * 60);
    assertEquals(await verifyRequest(check, VIDEO_ID, config), false);
});

Deno.test("verifyRequest tolerates two minutes of clock skew", async () => {
    const check = await makeCheck(VIDEO_ID, config, nowSeconds() + 2 * 60);
    assertEquals(await verifyRequest(check, VIDEO_ID, config), true);
});

Deno.test("verifyRequest rejects a tampered token", async () => {
    const check = await makeCheck(VIDEO_ID, config);
    // Flip a byte inside the ciphertext region (layout: IV[12] || ciphertext
    // || tag[16]; index 20 is well past the IV) rather than mutating a
    // base64 character directly — some character positions only touch
    // padding bits and decode to the same bytes, which made this
    // flaky. XOR-ing a decoded byte always changes the plaintext/tag.
    const bytes = decodeBase64(
        check.replace(/-/g, "+").replace(/_/g, "/"),
    );
    const tampered = bytes.slice();
    tampered[20] ^= 0xff;
    const flipped = encodeBase64(tampered).replace(/\+/g, "-").replace(
        /\//g,
        "_",
    );
    assertEquals(await verifyRequest(flipped, VIDEO_ID, config), false);
});

Deno.test("verifyRequest rejects a non-integer timestamp", async () => {
    const bytes = await encryptGcm(`123abc|${VIDEO_ID}`, config);
    const check = encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_");
    assertEquals(await verifyRequest(check, VIDEO_ID, config), false);
});

Deno.test("verifyRequest rejects a token with no separator", async () => {
    const bytes = await encryptGcm(`${nowSeconds()}${VIDEO_ID}`, config);
    const check = encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_");
    assertEquals(await verifyRequest(check, VIDEO_ID, config), false);
});

Deno.test("verifyRequest rejects garbage input", async () => {
    assertEquals(await verifyRequest("", VIDEO_ID, config), false);
    assertEquals(await verifyRequest("%%%", VIDEO_ID, config), false);
});

Deno.test("verifyRequest accepts base64url tokens containing - and _", async () => {
    // Random IVs mean a token with URL-safe substitutions shows up within
    // a handful of attempts; loop until one does.
    let check = "";
    for (let i = 0; i < 200; i++) {
        check = await makeCheck(VIDEO_ID, config);
        if (check.includes("-") || check.includes("_")) break;
    }
    assert(check.includes("-") || check.includes("_"));
    assertEquals(await verifyRequest(check, VIDEO_ID, config), true);
});

Deno.test("verifyRequest accepts an unpadded base64url token", async () => {
    const check = await makeCheck(VIDEO_ID, config);
    const unpadded = check.replace(/=+$/, "");
    assertEquals(await verifyRequest(unpadded, VIDEO_ID, config), true);
});

Deno.test("verifyRequest accepts a standard (non-url-safe) base64 token", async () => {
    const check = await makeCheck(VIDEO_ID, config);
    const standard = check.replace(/-/g, "+").replace(/_/g, "/");
    assertEquals(await verifyRequest(standard, VIDEO_ID, config), true);
});
