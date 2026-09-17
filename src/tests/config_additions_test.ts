import { assert, assertEquals } from "./deps.ts";
import { parseConfig } from "../lib/helpers/config.ts";
import { withEnv, withTempConfig } from "./helpers/env.ts";

Deno.test("Config validation additions", async (t) => {
    await t.step("rejects invalid cron expressions for frequency", async () => {
        const invalidCrons = [
            "*/5 * * *", // 4 parts
            "every 5 minutes", // not a cron
        ];

        for (const cron of invalidCrons) {
            await withTempConfig(
                `[server]\nsecret_key = "1234567890abcdef"\n\n[jobs.youtube_session]\nfrequency = "${cron}"\n`,
                async () => {
                    try {
                        await parseConfig();
                        assert(
                            false,
                            `Cron "${cron}" should be invalid but was accepted.`,
                        );
                    } catch (error) {
                        assert(
                            error instanceof Error &&
                                error.message.includes("frequency"),
                            `Should get validation error for frequency, got: ${
                                error instanceof Error
                                    ? error.message
                                    : String(error)
                            }`,
                        );
                    }
                },
            );
        }
    });

    await t.step("accepts valid cron expressions", async () => {
        const validCrons = [
            "*/5 * * * *",
            "0 0 * * *",
            "1,2 3 4 5 6",
        ];

        for (const cron of validCrons) {
            await withTempConfig(
                `[server]\nsecret_key = "1234567890abcdef"\n\n[jobs.youtube_session]\nfrequency = "${cron}"\n`,
                async () => {
                    const config = await parseConfig();
                    assertEquals(config.jobs.youtube_session.frequency, cron);
                },
            );
        }
    });

    await t.step("player_fallback_clients defaults sensibly", async () => {
        await withTempConfig(
            `[server]\nsecret_key = "1234567890abcdef"\n`,
            async () => {
                const config = await parseConfig();
                assertEquals(
                    config.jobs.youtube_session.player_fallback_clients,
                    ["TV_SIMPLY", "MWEB", "ANDROID_VR"],
                );
            },
        );
    });

    await t.step("player_fallback_clients accepts a TOML array", async () => {
        await withTempConfig(
            `[server]\nsecret_key = "1234567890abcdef"\n\n[jobs.youtube_session]\nplayer_fallback_clients = ["MWEB", "TV_SIMPLY"]\n`,
            async () => {
                const config = await parseConfig();
                assertEquals(
                    config.jobs.youtube_session.player_fallback_clients,
                    ["MWEB", "TV_SIMPLY"],
                );
            },
        );
    });

    await t.step(
        "player_fallback_clients parses a comma-separated env var",
        async () => {
            await withTempConfig(
                `[server]\nsecret_key = "1234567890abcdef"\n`,
                async () => {
                    const config = await parseConfig();
                    assertEquals(
                        config.jobs.youtube_session.player_fallback_clients,
                        ["TV_SIMPLY", "ANDROID_VR"],
                    );
                },
                {
                    JOBS_YOUTUBE_SESSION_PLAYER_FALLBACK_CLIENTS:
                        "TV_SIMPLY, ANDROID_VR",
                },
            );
        },
    );

    await t.step(
        "player_fallback_clients rejects non-uppercase client names",
        async () => {
            await withTempConfig(
                `[server]\nsecret_key = "1234567890abcdef"\n\n[jobs.youtube_session]\nplayer_fallback_clients = ["mweb"]\n`,
                async () => {
                    try {
                        await parseConfig();
                        assert(
                            false,
                            "lowercase client name should be rejected",
                        );
                    } catch (error) {
                        assert(
                            error instanceof Error &&
                                error.message.includes(
                                    "player_fallback_clients",
                                ),
                            `Should get validation error for player_fallback_clients, got: ${
                                error instanceof Error
                                    ? error.message
                                    : String(error)
                            }`,
                        );
                    }
                },
            );
        },
    );

    await t.step("rejects missing SERVER_SECRET_KEY", async () => {
        await withTempConfig("", async () => {
            await withEnv({ SERVER_SECRET_KEY: undefined }, async () => {
                try {
                    await parseConfig();
                    assert(
                        false,
                        "Config parsing should fail when SERVER_SECRET_KEY is missing",
                    );
                } catch (error) {
                    assert(
                        error instanceof Error &&
                            error.message.includes("SERVER_SECRET_KEY"),
                        `Should get validation error for missing secret key, got: ${
                            error instanceof Error
                                ? error.message
                                : String(error)
                        }`,
                    );
                }
            });
        });
    });

    await t.step(
        "inbound rate limit defaults to disabled, 120 rpm, burst 60",
        async () => {
            await withTempConfig(
                `[server]\nsecret_key = "1234567890abcdef"\n`,
                async () => {
                    const config = await parseConfig();
                    // Disabled by default: behind Invidious's default
                    // same-origin reverse proxy the companion only sees
                    // Invidious's own backend IP, so an enabled-by-default
                    // per-IP limit would cap the whole instance.
                    assertEquals(config.server.rate_limit.enabled, false);
                    assertEquals(
                        config.server.rate_limit.requests_per_minute,
                        120,
                    );
                    assertEquals(config.server.rate_limit.burst, 60);
                    assertEquals(config.server.trust_proxy, false);
                },
            );
        },
    );

    await t.step(
        "inbound rate limit can be enabled and tuned via TOML",
        async () => {
            await withTempConfig(
                `[server]\nsecret_key = "1234567890abcdef"\ntrust_proxy = true\n\n[server.rate_limit]\nenabled = true\nrequests_per_minute = 30\nburst = 5\n`,
                async () => {
                    const config = await parseConfig();
                    assertEquals(config.server.rate_limit.enabled, true);
                    assertEquals(
                        config.server.rate_limit.requests_per_minute,
                        30,
                    );
                    assertEquals(config.server.rate_limit.burst, 5);
                    assertEquals(config.server.trust_proxy, true);
                },
            );
        },
    );
});
