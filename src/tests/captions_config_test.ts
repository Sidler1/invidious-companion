import { assertEquals } from "./deps.ts";
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

const BASE_CONFIG = `[server]\nsecret_key = "1234567890abcdef"\n`;

Deno.test("captions config", async (t) => {
    await t.step("captions are enabled by default", async () => {
        await withTempConfig(BASE_CONFIG, async () => {
            const config = await parseConfig();
            assertEquals(config.captions.enabled, true);
        });
    });

    await t.step("captions can be disabled via TOML", async () => {
        await withTempConfig(
            `${BASE_CONFIG}\n[captions]\nenabled = false\n`,
            async () => {
                const config = await parseConfig();
                assertEquals(config.captions.enabled, false);
            },
        );
    });
});
