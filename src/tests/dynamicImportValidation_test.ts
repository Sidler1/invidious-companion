import { assert, assertEquals, assertThrows } from "./deps.ts";
import { resolveAndValidateFetchClientLocation } from "../lib/helpers/dynamicImportValidation.ts";
import { withEnv } from "./helpers/env.ts";

// Both env vars are read at call time, so every step scopes them with withEnv
// and gets a clean, restored environment even when an assertion throws.
function withLocation<T>(
    location: string | undefined,
    fn: () => T,
    compiled = false,
): Promise<T> {
    return withEnv({
        GET_FETCH_CLIENT_LOCATION: location,
        DENO_COMPILED: compiled ? "true" : undefined,
    }, fn);
}

Deno.test("Dynamic import validation", async (t) => {
    await t.step("returns default when env var is not set", async () => {
        await withLocation(undefined, () => {
            const result = resolveAndValidateFetchClientLocation();
            assertEquals(result, "getFetchClient");
        });
    });

    await t.step("accepts allowed internal module paths", async () => {
        const allowed = [
            "getFetchClient",
            "./getFetchClient",
            "../lib/helpers/getFetchClient",
        ];
        for (const path of allowed) {
            await withLocation(path, () => {
                const result = resolveAndValidateFetchClientLocation();
                assertEquals(result, path);
            });
        }
    });

    await t.step("rejects remote URLs (http)", async () => {
        await withLocation("https://evil.com/malicious.ts", () => {
            assertThrows(
                () => resolveAndValidateFetchClientLocation(),
                Error,
                "remote module URLs are not allowed",
            );
        });
    });

    await t.step("rejects remote URLs (npm)", async () => {
        await withLocation("npm:malicious-package", () => {
            assertThrows(
                () => resolveAndValidateFetchClientLocation(),
                Error,
                "remote module URLs are not allowed",
            );
        });
    });

    await t.step("rejects suspicious path traversal", async () => {
        await withLocation("../../etc/passwd", () => {
            assertThrows(
                () => resolveAndValidateFetchClientLocation(),
                Error,
                "suspicious path traversal",
            );
        });
    });

    await t.step("warns but allows non-standard local paths", async () => {
        await withLocation("./myCustomModule", () => {
            // Should not throw, just warn
            const result = resolveAndValidateFetchClientLocation();
            assertEquals(result, "./myCustomModule");
        });
    });

    await t.step("accepts compiled path with allowed basename", async () => {
        await withLocation("getFetchClient", () => {
            // In compiled mode, it prepends mainModule path — basename is still "getFetchClient"
            const result = resolveAndValidateFetchClientLocation();
            assert(result.endsWith("getFetchClient"));
        }, true);
    });

    await t.step(
        "rejects a remote URL even when its basename is an allowed module",
        async () => {
            await withLocation(
                "https://evil.example/getFetchClient.ts",
                () => {
                    assertThrows(
                        () => resolveAndValidateFetchClientLocation(),
                        Error,
                        "remote module URLs are not allowed",
                    );
                },
            );
        },
    );

    await t.step(
        "rejects path traversal even when its basename is an allowed module",
        async () => {
            await withLocation("../../../tmp/getFetchClient.ts", () => {
                assertThrows(
                    () => resolveAndValidateFetchClientLocation(),
                    Error,
                    "suspicious path traversal",
                );
            });
        },
    );

    await t.step(
        "rejects traversal hidden behind the allowed ../lib/ prefix",
        async () => {
            await withLocation("../lib/../../tmp/getFetchClient.ts", () => {
                assertThrows(
                    () => resolveAndValidateFetchClientLocation(),
                    Error,
                    "suspicious path traversal",
                );
            });
        },
    );

    await t.step(
        "rejects percent-encoded traversal (%2e%2e/%2e%2e/tmp/getFetchClient.ts)",
        async () => {
            await withLocation(
                "%2e%2e/%2e%2e/tmp/getFetchClient.ts",
                () => {
                    assertThrows(
                        () => resolveAndValidateFetchClientLocation(),
                        Error,
                        "suspicious path traversal",
                    );
                },
            );
        },
    );

    await t.step(
        "rejects uppercase percent-encoded traversal (%2E%2E/getFetchClient.ts)",
        async () => {
            await withLocation("%2E%2E/getFetchClient.ts", () => {
                assertThrows(
                    () => resolveAndValidateFetchClientLocation(),
                    Error,
                    "suspicious path traversal",
                );
            });
        },
    );

    await t.step(
        "rejects malformed percent-encoding (%zz/getFetchClient.ts)",
        async () => {
            await withLocation("%zz/getFetchClient.ts", () => {
                assertThrows(
                    () => resolveAndValidateFetchClientLocation(),
                    Error,
                    "suspicious path traversal",
                );
            });
        },
    );

    await t.step(
        "accepts compiled path with percent-encoded space (file:///tmp/my%20dir/getFetchClient.ts)",
        async () => {
            await withLocation(
                "file:///tmp/my%20dir/getFetchClient.ts",
                () => {
                    const result = resolveAndValidateFetchClientLocation();
                    assertEquals(
                        result,
                        "file:///tmp/my%20dir/getFetchClient.ts",
                    );
                },
            );
        },
    );

    await t.step(
        "rejects a data: URL even when it defines an allowed module name",
        async () => {
            await withLocation(
                "data:text/javascript,export function getFetchClient(){}",
                () => {
                    assertThrows(
                        () => resolveAndValidateFetchClientLocation(),
                        Error,
                        "remote module URLs are not allowed",
                    );
                },
            );
        },
    );

    await t.step("rejects a blob: URL", async () => {
        await withLocation("blob:https://evil.example/uuid", () => {
            assertThrows(
                () => resolveAndValidateFetchClientLocation(),
                Error,
                "remote module URLs are not allowed",
            );
        });
    });
});
