import { assertEquals, assertThrows } from "./deps.ts";
import { makeTestConfig } from "./helpers/testConfig.ts";

Deno.test("config rejects a negative retry initial_debounce", () => {
    assertThrows(
        () =>
            makeTestConfig({
                networking: { fetch: { retry: { initial_debounce: -1 } } },
            }),
        Error,
        "initial_debounce",
    );
});

Deno.test("config rejects a negative retry debounce_multiplier", () => {
    assertThrows(
        () =>
            makeTestConfig({
                networking: { fetch: { retry: { debounce_multiplier: -0.5 } } },
            }),
        Error,
        "debounce_multiplier",
    );
});

Deno.test("config accepts zero for both retry fields", () => {
    const config = makeTestConfig({
        networking: {
            fetch: { retry: { initial_debounce: 0, debounce_multiplier: 0 } },
        },
    });
    assertEquals(config.networking.fetch.retry.initial_debounce, 0);
    assertEquals(config.networking.fetch.retry.debounce_multiplier, 0);
});

Deno.test("the example secret_key placeholder satisfies the schema", () => {
    const config = makeTestConfig({
        server: { secret_key: "CHANGEME12345678" },
    });
    assertEquals(config.server.secret_key, "CHANGEME12345678");
});
