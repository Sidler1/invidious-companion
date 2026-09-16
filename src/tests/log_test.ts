import { assert, assertEquals } from "./deps.ts";
import { CTX, logError, logWarn } from "../lib/helpers/log.ts";

function captureConsole(
    method: "error" | "warn",
    fn: () => void,
): string[] {
    const lines: string[] = [];
    const original = console[method];
    console[method] = (...args: unknown[]) => {
        lines.push(args.map((a) => String(a)).join(" "));
    };
    try {
        fn();
    } finally {
        console[method] = original;
    }
    return lines;
}

Deno.test("logError redacts secrets in the message", () => {
    const lines = captureConsole("error", () => {
        logError(
            CTX.SERVER,
            "request to https://x/timedtext?v=1&pot=SECRETTOKEN failed",
        );
    });
    assertEquals(lines.length, 1);
    assert(!lines[0].includes("SECRETTOKEN"));
    assert(lines[0].includes("pot=[REDACTED]"));
});

Deno.test("logError redacts secrets inside the error object", () => {
    const err = new Error(
        "error sending request for url (https://x/timedtext?pot=SECRETTOKEN&fmt=vtt)",
    );
    const lines = captureConsole("error", () => {
        logError(CTX.CAPTIONS, "caption fetch failed", err);
    });
    assertEquals(lines.length, 1);
    assert(!lines[0].includes("SECRETTOKEN"));
    assert(lines[0].includes("pot=[REDACTED]"));
    assert(lines[0].includes("caption fetch failed"));
});

Deno.test("logWarn redacts secrets in the message", () => {
    const lines = captureConsole("warn", () => {
        logWarn(CTX.PROXY, "Bearer abc123 was rejected");
    });
    assertEquals(lines.length, 1);
    assert(!lines[0].includes("abc123"));
    assert(lines[0].includes("Bearer [REDACTED]"));
});
