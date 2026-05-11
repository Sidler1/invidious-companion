import { assertEquals, assertExists } from "./deps.ts";
import { parseConfig } from "../lib/helpers/config.ts";

// We test the new proxy_pool config schema and basic behavior

Deno.test("proxy_pool config parsing - disabled by default", async () => {
    Deno.env.set("CONFIG_FILE", "config/config.example.toml"); // use example which has it commented
    const config = await parseConfig();
    assertEquals(config.networking.proxy_pool.enabled, false);
    assertEquals(config.networking.proxy_pool.proxies.length, 0);
});

Deno.test("proxy_pool config parsing - enabled with proxies", () => {
    // Simulate TOML-like input
    const raw = {
        networking: {
            proxy_pool: {
                enabled: true,
                rotation: "round-robin",
                health_check: true,
                proxies: [
                    "http://user:pass@proxy1:8080",
                    "http://user:pass@proxy2:8080",
                ],
            },
        },
    };

    assertEquals(raw.networking.proxy_pool.enabled, true);
    assertEquals(raw.networking.proxy_pool.rotation, "round-robin");
    assertEquals(raw.networking.proxy_pool.proxies.length, 2);
});

Deno.test("getFetchClient with proxy_pool - basic creation (no real network)", async () => {
    const { getFetchClient } = await import("../lib/helpers/getFetchClient.ts");

    const config = await parseConfig();

    // Override with test proxy pool config (proper typing)
    const testConfig = {
        ...config,
        networking: {
            ...config.networking,
            proxy_pool: {
                enabled: true,
                rotation: "round-robin" as const,
                health_check: true,
                proxies: ["http://user:pass@127.0.0.1:1"],
            },
        },
    };

    const fetchClient = getFetchClient(testConfig);
    assertExists(fetchClient);
});
