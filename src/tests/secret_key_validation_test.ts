/**
 * Test for secret key validation in the actual Invidious companion configuration
 * This test verifies that SERVER_SECRET_KEY validation properly rejects special characters
 * when the actual config is parsed
 */
import { assert, assertEquals } from "./deps.ts";
import { parseConfig } from "../lib/helpers/config.ts";
import { withEnv, withTempConfig } from "./helpers/env.ts";

// An empty temp config guarantees the env var is the only source of the key,
// even on a machine that has a local config/config.toml.
function parseWithSecretKey(key: string | undefined) {
    return withTempConfig(
        "",
        () => parseConfig(),
        { SERVER_SECRET_KEY: key },
    );
}

async function expectSecretKeyError(
    key: string | undefined,
    matchers: string[],
    description: string,
): Promise<void> {
    try {
        await parseWithSecretKey(key);
        assert(false, `${description}: config parsing should have failed`);
    } catch (error) {
        const errorStr = error instanceof Error
            ? error.toString()
            : String(error);
        assert(
            errorStr.includes("Failed to parse configuration"),
            `${description}: should get config parsing error, got: ${errorStr}`,
        );
        assert(
            matchers.some((m) => errorStr.includes(m)),
            `${description}: expected one of ${
                JSON.stringify(matchers)
            } in error, got: ${errorStr}`,
        );
    }
}

const LENGTH_MATCHERS = [
    "exactly 16 character",
    "String must contain exactly 16 character",
];
const CHARACTER_MATCHERS = [
    "SERVER_SECRET_KEY contains invalid characters",
    "alphanumeric characters",
];

Deno.test("Secret key validation in Invidious companion config", async (t) => {
    await t.step("accepts valid alphanumeric keys", async () => {
        const validKeys = [
            "aaaaaaaaaaaaaaaa", // all lowercase
            "AAAAAAAAAAAAAAAA", // all uppercase
            "1234567890123456", // all numbers
            "Aa1Bb2Cc3Dd4Ee5F", // mixed case
            "ABC123DEF456789A", // mixed letters and numbers
        ];

        for (const key of validKeys) {
            const config = await parseWithSecretKey(key);
            assertEquals(
                config.server.secret_key,
                key,
                `Key "${key}" should be accepted and stored correctly`,
            );
        }
    });

    await t.step("rejects keys with special characters", async () => {
        const invalidKeys = [
            "my#key!123456789", // Contains # and !
            "test@key12345678", // Contains @ (fixed length)
            "key-with-dashes1", // Contains -
            "key_with_under_s", // Contains _
            "key with spaces1", // Contains spaces (fixed length to 16)
            "key$with$dollar$", // Contains $
            "key+with+plus+12", // Contains +
            "key=with=equals=", // Contains =
            "key(with)parens1", // Contains ()
            "key[with]bracket", // Contains []
        ];

        for (const key of invalidKeys) {
            await expectSecretKeyError(
                key,
                CHARACTER_MATCHERS,
                `Key "${key}"`,
            );
        }
    });

    await t.step("rejects keys with wrong length", async () => {
        const wrongLengthKeys = [
            "short", // Too short
            "thiskeyistoolongtobevalid", // Too long
            "", // Empty
            "a", // Single character
            "exactly15chars", // 15 chars
            "exactly17charss", // 17 chars
        ];

        for (const key of wrongLengthKeys) {
            await expectSecretKeyError(
                key,
                LENGTH_MATCHERS,
                `Key "${key}" (length ${key.length})`,
            );
        }
    });

    await t.step(
        "reports the length error first when both length and characters are invalid",
        async () => {
            await expectSecretKeyError("bad#", LENGTH_MATCHERS, 'Key "bad#"');
        },
    );

    await t.step("fails when SERVER_SECRET_KEY is missing", async () => {
        await expectSecretKeyError(
            undefined,
            LENGTH_MATCHERS,
            "missing SERVER_SECRET_KEY",
        );
    });

    await t.step(
        "does not leak SERVER_SECRET_KEY into the environment",
        async () => {
            await withEnv({ SERVER_SECRET_KEY: undefined }, async () => {
                await parseWithSecretKey("aaaaaaaaaaaaaaaa");
                assertEquals(Deno.env.get("SERVER_SECRET_KEY"), undefined);
            });
        },
    );
});
