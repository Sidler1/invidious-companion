import { type Config, ConfigSchema } from "../../lib/helpers/config.ts";

export const TEST_SECRET_KEY = "aaaaaaaaaaaaaaaa";

/**
 * Build a fully-defaulted Config for unit tests without touching env vars
 * or the filesystem. `overrides` is merged one level deep for `server`
 * (so the secret key is always present) and spread as-is for every other
 * top-level section.
 */
export function makeTestConfig(
    overrides: {
        server?: Record<string, unknown>;
        [section: string]: unknown;
    } = {},
): Config {
    const { server, ...rest } = overrides;
    return ConfigSchema.parse({
        ...rest,
        server: { secret_key: TEST_SECRET_KEY, ...(server ?? {}) },
    });
}
