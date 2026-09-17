import { assertEquals } from "./deps.ts";
import { redactString, redactUrl } from "../lib/helpers/redactSensitive.ts";

Deno.test("Redaction - redactUrl", async (t) => {
    await t.step("redacts sensitive query params from URLs", () => {
        const url =
            "https://example.com/path?key=secret123&token=abc&normal=ok";
        const result = redactUrl(url);
        assertEquals(result.includes("secret123"), false);
        assertEquals(result.includes("token=abc"), false);
        assertEquals(result.includes("[REDACTED]"), true);
        assertEquals(result.includes("normal=ok"), true);
    });

    await t.step("leaves URLs without sensitive params unchanged", () => {
        const url =
            "https://example.com/path?itag=399&host=rr3.googlevideo.com";
        const result = redactUrl(url);
        assertEquals(result, url);
    });

    await t.step("redacts pot param", () => {
        const url =
            "https://example.com/videoplayback?pot=sensitive_value&itag=18";
        const result = redactUrl(url);
        assertEquals(result.includes("sensitive_value"), false);
        assertEquals(result.includes("[REDACTED]"), true);
        assertEquals(result.includes("itag=18"), true);
    });

    await t.step("redacts sig and signature params", () => {
        const url = "https://example.com/path?sig=abc123&signature=def456";
        const result = redactUrl(url);
        assertEquals(result.includes("sig=abc123"), false);
        assertEquals(result.includes("signature=def456"), false);
    });

    await t.step("handles strings with query-like patterns", () => {
        const str = "request to /path?token=secret123&other=value";
        const result = redactUrl(str);
        assertEquals(result.includes("secret123"), false);
        assertEquals(result.includes("[REDACTED]"), true);
    });

    await t.step("redacts ip, data and cookies params", () => {
        const url =
            "https://example.com/videoplayback?ip=203.0.113.7&data=Zm9v&cookies=a%3Db&itag=18";
        const result = redactUrl(url);
        assertEquals(result.includes("203.0.113.7"), false);
        assertEquals(result.includes("Zm9v"), false);
        assertEquals(result.includes("a%3Db"), false);
        assertEquals(result.includes("itag=18"), true);
    });
});

Deno.test("Redaction - redactString", async (t) => {
    await t.step("redacts Bearer tokens", () => {
        const str = "Got header: Bearer eyJhbGciOiJIUzI1NiJ9 in request";
        const result = redactString(str);
        assertEquals(result.includes("eyJhbGciOiJIUzI1NiJ9"), false);
        assertEquals(result.includes("Bearer [REDACTED]"), true);
    });

    await t.step("redacts Authorization headers", () => {
        const str = "Header Authorization: dXNlcjpwYXNz end";
        const result = redactString(str);
        assertEquals(result.includes("dXNlcjpwYXNz"), false);
        assertEquals(result.includes("Authorization: [REDACTED]"), true);
    });

    await t.step("redacts query params in strings", () => {
        const str = "Request to ?key=mysecretkey&other=value";
        const result = redactString(str);
        assertEquals(result.includes("mysecretkey"), false);
        assertEquals(result.includes("[REDACTED]"), true);
        assertEquals(result.includes("other=value"), true);
    });

    await t.step("leaves clean strings unchanged", () => {
        const str = "Normal log message with no secrets";
        const result = redactString(str);
        assertEquals(result, str);
    });

    await t.step(
        "preserves a trailing delimiter after a redacted value",
        () => {
            const str = "error (https://x/y?pot=SECRET)";
            const result = redactString(str);
            assertEquals(result, "error (https://x/y?pot=[REDACTED])");
        },
    );

    await t.step("masks URL userinfo embedded in a message", () => {
        const str = "fetch failed for https://user:pass@example.com/path";
        const result = redactString(str);
        assertEquals(result.includes("user:pass"), false);
        assertEquals(result.includes("//[REDACTED]@example.com"), true);
    });

    await t.step(
        "redacts a sensitive param at the start of a string or after whitespace",
        () => {
            const atStart = redactString("token=abc123 is the value");
            assertEquals(atStart.includes("abc123"), false);
            const afterWhitespace = redactString(
                "params were token=abc123 for this request",
            );
            assertEquals(afterWhitespace.includes("abc123"), false);
        },
    );
});

Deno.test("Redaction - hardening additions", async (t) => {
    await t.step("masks URL userinfo in redactUrl", () => {
        const url = "https://user:pass@example.com/path?itag=18";
        const result = redactUrl(url);
        assertEquals(result.includes("user:pass"), false);
        assertEquals(result.includes("//[REDACTED]@example.com"), true);
        assertEquals(result.includes("itag=18"), true);
    });

    await t.step("redacts the check param", () => {
        const url = "https://example.com/download?id=abc&check=TOKEN123";
        const result = redactUrl(url);
        assertEquals(result.includes("TOKEN123"), false);
        assertEquals(result.includes("check=[REDACTED]"), true);
    });

    await t.step(
        "redacts secret_key even though it is prefixed by 'secret'",
        () => {
            const url = "https://example.com/x?secret_key=abc123&other=ok";
            const result = redactUrl(url);
            assertEquals(result.includes("abc123"), false);
            assertEquals(result.includes("secret_key=[REDACTED]"), true);
            assertEquals(result.includes("other=ok"), true);
        },
    );
});
