import { assert } from "./deps.ts";
import { parseConfig } from "../lib/helpers/config.ts";
import { withTempConfig as withTempConfigBase } from "./helpers/env.ts";

// Every negative case here supplies its own [server].secret_key in the TOML,
// but the env fallback must also be valid so a missing TOML key never masks
// the assertion under test.
function withTempConfig<T>(
    content: string,
    fn: () => Promise<T>,
): Promise<T> {
    return withTempConfigBase(content, fn, {
        SERVER_SECRET_KEY: "aaaaaaaaaaaaaaaa",
    });
}

async function expectConfigError(
    content: string,
    expectedSubstring: string,
    description: string,
) {
    await withTempConfig(content, async () => {
        try {
            await parseConfig();
            assert(false, `${description}: should have thrown`);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            assert(
                msg.includes(expectedSubstring),
                `${description}: expected "${expectedSubstring}" in error, got: ${msg}`,
            );
        }
    });
}

Deno.test("Config negative paths", async (t) => {
    await t.step("rejects port = 0", async () => {
        await expectConfigError(
            `[server]\nport = 0\nsecret_key = "aaaaaaaaaaaaaaaa"\n`,
            "Number must be greater than or equal to 1",
            "port = 0",
        );
    });

    await t.step("rejects port = 70000", async () => {
        await expectConfigError(
            `[server]\nport = 70000\nsecret_key = "aaaaaaaaaaaaaaaa"\n`,
            "Number must be less than or equal to 65535",
            "port = 70000",
        );
    });

    await t.step("rejects negative cache ttl", async () => {
        await expectConfigError(
            `[server]\nsecret_key = "aaaaaaaaaaaaaaaa"\n\n[cache]\nttl_seconds = -1\n`,
            "Number must be greater than or equal to 0",
            "negative ttl",
        );
    });

    await t.step("rejects cache ttl > 21600", async () => {
        await expectConfigError(
            `[server]\nsecret_key = "aaaaaaaaaaaaaaaa"\n\n[cache]\nttl_seconds = 100000\n`,
            "Number must be less than or equal to 21600",
            "ttl > 21600",
        );
    });

    await t.step("rejects unknown networking key", async () => {
        await expectConfigError(
            `[server]\nsecret_key = "aaaaaaaaaaaaaaaa"\n\n[networking]\nipv6_pool_size = 0\n`,
            "Unrecognized key",
            "unknown networking key",
        );
    });

    await t.step("rejects fetch timeout_ms < 1000", async () => {
        await expectConfigError(
            `[server]\nsecret_key = "aaaaaaaaaaaaaaaa"\n\n[networking.fetch]\ntimeout_ms = 100\n`,
            "Number must be greater than or equal to 1000",
            "timeout_ms < 1000",
        );
    });

    await t.step("rejects retry times > 10", async () => {
        await expectConfigError(
            `[server]\nsecret_key = "aaaaaaaaaaaaaaaa"\n\n[networking.fetch.retry]\ntimes = 50\n`,
            "Number must be less than or equal to 10",
            "retry times > 10",
        );
    });

    await t.step("rejects invalid proxy URL in proxy_pool", async () => {
        await expectConfigError(
            `[server]\nsecret_key = "aaaaaaaaaaaaaaaa"\n\n[networking.proxy_pool]\nenabled = true\nproxies = ["not-a-url"]\n`,
            "Each proxy must be a valid URL",
            "invalid proxy URL",
        );
    });

    await t.step("rejects proxy with ftp protocol", async () => {
        await expectConfigError(
            `[server]\nsecret_key = "aaaaaaaaaaaaaaaa"\n\n[networking.proxy_pool]\nenabled = true\nproxies = ["ftp://proxy:8080"]\n`,
            "Each proxy must be a valid URL",
            "ftp proxy",
        );
    });

    await t.step("rejects cron with out-of-bounds minute (60)", async () => {
        await expectConfigError(
            `[server]\nsecret_key = "aaaaaaaaaaaaaaaa"\n\n[jobs.youtube_session]\nfrequency = "60 * * * *"\n`,
            "out-of-bounds",
            "cron minute 60",
        );
    });

    await t.step("rejects cron with out-of-bounds hour (25)", async () => {
        await expectConfigError(
            `[server]\nsecret_key = "aaaaaaaaaaaaaaaa"\n\n[jobs.youtube_session]\nfrequency = "0 25 * * *"\n`,
            "out-of-bounds",
            "cron hour 25",
        );
    });

    await t.step("rejects malformed cron (text)", async () => {
        await expectConfigError(
            `[server]\nsecret_key = "aaaaaaaaaaaaaaaa"\n\n[jobs.youtube_session]\nfrequency = "every 5 minutes"\n`,
            "frequency",
            "text cron",
        );
    });

    await t.step("accepts valid proxy URLs", async () => {
        await withTempConfig(
            `[server]\nsecret_key = "aaaaaaaaaaaaaaaa"\n\n[networking.proxy_pool]\nenabled = true\nproxies = ["http://user:pass@proxy:8080", "socks5://proxy2:1080"]\n`,
            async () => {
                const config = await parseConfig();
                assert(config.networking.proxy_pool.proxies.length === 2);
            },
        );
    });
});
