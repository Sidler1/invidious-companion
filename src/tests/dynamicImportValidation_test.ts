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
});
