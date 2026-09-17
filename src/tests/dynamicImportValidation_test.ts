import { assert, assertEquals, assertThrows } from "./deps.ts";
import { resolveAndValidateFetchClientLocation } from "../lib/helpers/dynamicImportValidation.ts";

Deno.test("Dynamic import validation", async (t) => {
    const origLocation = Deno.env.get("GET_FETCH_CLIENT_LOCATION");
    const origCompiled = Deno.env.get("DENO_COMPILED");

    function cleanup() {
        if (origLocation === undefined) {
            Deno.env.delete("GET_FETCH_CLIENT_LOCATION");
        } else {
            Deno.env.set("GET_FETCH_CLIENT_LOCATION", origLocation);
        }
        if (origCompiled === undefined) {
            Deno.env.delete("DENO_COMPILED");
        } else {
            Deno.env.set("DENO_COMPILED", origCompiled);
        }
    }

    await t.step("returns default when env var is not set", () => {
        Deno.env.delete("GET_FETCH_CLIENT_LOCATION");
        const result = resolveAndValidateFetchClientLocation();
        assertEquals(result, "getFetchClient");
        cleanup();
    });

    await t.step("accepts allowed internal module paths", () => {
        const allowed = [
            "getFetchClient",
            "./getFetchClient",
            "../lib/helpers/getFetchClient",
        ];
        for (const path of allowed) {
            Deno.env.set("GET_FETCH_CLIENT_LOCATION", path);
            Deno.env.delete("DENO_COMPILED");
            const result = resolveAndValidateFetchClientLocation();
            assertEquals(result, path);
        }
        cleanup();
    });

    await t.step("rejects remote URLs (http)", () => {
        Deno.env.set(
            "GET_FETCH_CLIENT_LOCATION",
            "https://evil.com/malicious.ts",
        );
        Deno.env.delete("DENO_COMPILED");
        assertThrows(
            () => resolveAndValidateFetchClientLocation(),
            Error,
            "remote module URLs are not allowed",
        );
        cleanup();
    });

    await t.step("rejects remote URLs (npm)", () => {
        Deno.env.set("GET_FETCH_CLIENT_LOCATION", "npm:malicious-package");
        Deno.env.delete("DENO_COMPILED");
        assertThrows(
            () => resolveAndValidateFetchClientLocation(),
            Error,
            "remote module URLs are not allowed",
        );
        cleanup();
    });

    await t.step("rejects suspicious path traversal", () => {
        Deno.env.set(
            "GET_FETCH_CLIENT_LOCATION",
            "../../etc/passwd",
        );
        Deno.env.delete("DENO_COMPILED");
        assertThrows(
            () => resolveAndValidateFetchClientLocation(),
            Error,
            "suspicious path traversal",
        );
        cleanup();
    });

    await t.step("warns but allows non-standard local paths", () => {
        Deno.env.set("GET_FETCH_CLIENT_LOCATION", "./myCustomModule");
        Deno.env.delete("DENO_COMPILED");
        // Should not throw, just warn
        const result = resolveAndValidateFetchClientLocation();
        assertEquals(result, "./myCustomModule");
        cleanup();
    });

    await t.step("accepts compiled path with allowed basename", () => {
        Deno.env.set("GET_FETCH_CLIENT_LOCATION", "getFetchClient");
        Deno.env.set("DENO_COMPILED", "true");
        // In compiled mode, it prepends mainModule path — basename is still "getFetchClient"
        const result = resolveAndValidateFetchClientLocation();
        assert(result.endsWith("getFetchClient"));
        cleanup();
    });

    await t.step(
        "rejects a remote URL even when its basename is an allowed module",
        () => {
            Deno.env.set(
                "GET_FETCH_CLIENT_LOCATION",
                "https://evil.example/getFetchClient.ts",
            );
            Deno.env.delete("DENO_COMPILED");
            try {
                assertThrows(
                    () => resolveAndValidateFetchClientLocation(),
                    Error,
                    "remote module URLs are not allowed",
                );
            } finally {
                cleanup();
            }
        },
    );

    await t.step(
        "rejects path traversal even when its basename is an allowed module",
        () => {
            Deno.env.set(
                "GET_FETCH_CLIENT_LOCATION",
                "../../../tmp/getFetchClient.ts",
            );
            Deno.env.delete("DENO_COMPILED");
            try {
                assertThrows(
                    () => resolveAndValidateFetchClientLocation(),
                    Error,
                    "suspicious path traversal",
                );
            } finally {
                cleanup();
            }
        },
    );

    await t.step(
        "rejects traversal hidden behind the allowed ../lib/ prefix",
        () => {
            Deno.env.set(
                "GET_FETCH_CLIENT_LOCATION",
                "../lib/../../tmp/getFetchClient.ts",
            );
            Deno.env.delete("DENO_COMPILED");
            try {
                assertThrows(
                    () => resolveAndValidateFetchClientLocation(),
                    Error,
                    "suspicious path traversal",
                );
            } finally {
                cleanup();
            }
        },
    );

    await t.step(
        "rejects percent-encoded traversal (%2e%2e/%2e%2e/tmp/getFetchClient.ts)",
        () => {
            Deno.env.set(
                "GET_FETCH_CLIENT_LOCATION",
                "%2e%2e/%2e%2e/tmp/getFetchClient.ts",
            );
            Deno.env.delete("DENO_COMPILED");
            try {
                assertThrows(
                    () => resolveAndValidateFetchClientLocation(),
                    Error,
                    "suspicious path traversal",
                );
            } finally {
                cleanup();
            }
        },
    );

    await t.step(
        "rejects uppercase percent-encoded traversal (%2E%2E/getFetchClient.ts)",
        () => {
            Deno.env.set(
                "GET_FETCH_CLIENT_LOCATION",
                "%2E%2E/getFetchClient.ts",
            );
            Deno.env.delete("DENO_COMPILED");
            try {
                assertThrows(
                    () => resolveAndValidateFetchClientLocation(),
                    Error,
                    "suspicious path traversal",
                );
            } finally {
                cleanup();
            }
        },
    );

    await t.step(
        "rejects malformed percent-encoding (%zz/getFetchClient.ts)",
        () => {
            Deno.env.set(
                "GET_FETCH_CLIENT_LOCATION",
                "%zz/getFetchClient.ts",
            );
            Deno.env.delete("DENO_COMPILED");
            try {
                assertThrows(
                    () => resolveAndValidateFetchClientLocation(),
                    Error,
                    "suspicious path traversal",
                );
            } finally {
                cleanup();
            }
        },
    );

    await t.step(
        "accepts compiled path with percent-encoded space (file:///tmp/my%20dir/getFetchClient.ts)",
        () => {
            Deno.env.set(
                "GET_FETCH_CLIENT_LOCATION",
                "file:///tmp/my%20dir/getFetchClient.ts",
            );
            Deno.env.delete("DENO_COMPILED");
            const result = resolveAndValidateFetchClientLocation();
            assertEquals(result, "file:///tmp/my%20dir/getFetchClient.ts");
            cleanup();
        },
    );

    await t.step(
        "rejects a data: URL even when it defines an allowed module name",
        () => {
            Deno.env.set(
                "GET_FETCH_CLIENT_LOCATION",
                "data:text/javascript,export function getFetchClient(){}",
            );
            Deno.env.delete("DENO_COMPILED");
            try {
                assertThrows(
                    () => resolveAndValidateFetchClientLocation(),
                    Error,
                    "remote module URLs are not allowed",
                );
            } finally {
                cleanup();
            }
        },
    );

    await t.step("rejects a blob: URL", () => {
        Deno.env.set(
            "GET_FETCH_CLIENT_LOCATION",
            "blob:https://evil.example/uuid",
        );
        Deno.env.delete("DENO_COMPILED");
        try {
            assertThrows(
                () => resolveAndValidateFetchClientLocation(),
                Error,
                "remote module URLs are not allowed",
            );
        } finally {
            cleanup();
        }
    });
});
