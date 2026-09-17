import { Hono } from "hono";
import { assert, assertEquals } from "./deps.ts";
import { compactLogger } from "../routes/compactLogger.ts";

async function captureConsoleLog(fn: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
        lines.push(args.map((a) => String(a)).join(" "));
    };
    try {
        await fn();
    } finally {
        console.log = original;
    }
    return lines;
}

Deno.test("compactLogger writes request and response lines through the HTTP context", async () => {
    const app = new Hono();
    app.use("*", compactLogger);
    app.get("/companion/latest_version", (c) => c.text("ok"));

    const lines = await captureConsoleLog(async () => {
        const res = await app.request(
            "/companion/latest_version?id=jNQXAC9IVRw&itag=18&pot=SECRET",
        );
        assertEquals(res.status, 200);
    });

    assertEquals(lines.length, 2);
    assert(lines[0].startsWith("[INFO]  [HTTP] <-- GET"));
    assert(lines[0].includes("/latest_version id=jNQXAC9IVRw itag=18"));
    assert(lines[1].startsWith("[INFO]  [HTTP] --> GET"));
    assert(lines[1].includes(" 200 "));
    assert(!lines.join("\n").includes("SECRET"));
});
