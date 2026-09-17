import { assertEquals } from "./deps.ts";
import { parseConfig } from "../lib/helpers/config.ts";
import { withTempConfig } from "./helpers/env.ts";

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
