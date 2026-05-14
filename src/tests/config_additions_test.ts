import { assert, assertEquals } from "./deps.ts";
import { parseConfig } from "../lib/helpers/config.ts";

async function withTempConfig<T>(
    content: string,
    fn: () => Promise<T>,
): Promise<T> {
    const tempConfigPath = await Deno.makeTempFile({ suffix: ".toml" });
    await Deno.writeTextFile(tempConfigPath, content);

    const prevConfigFile = Deno.env.get("CONFIG_FILE");
    Deno.env.set("CONFIG_FILE", tempConfigPath);

    try {
        return await fn();
    } finally {
        if (prevConfigFile === undefined) {
            Deno.env.delete("CONFIG_FILE");
        } else {
            Deno.env.set("CONFIG_FILE", prevConfigFile);
        }
        await Deno.remove(tempConfigPath).catch(() => {});
    }
}

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

    await t.step("rejects missing SERVER_SECRET_KEY", async () => {
        await withTempConfig("", async () => {
            Deno.env.delete("SERVER_SECRET_KEY");
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
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        });
    });
});
