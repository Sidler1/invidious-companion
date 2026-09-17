import { Hono } from "hono";
import { assert, assertEquals, assertExists } from "./deps.ts";
import { compactLogger } from "../routes/compactLogger.ts";
import { Metrics } from "../lib/helpers/metrics.ts";
import type { HonoVariables } from "../lib/types/HonoVariables.ts";

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

Deno.test("compactLogger records labelled latency and counts 401 responses", async () => {
    const metrics = new Metrics();
    // Typed app so c.set("metrics") type-checks without main.ts's global
    // ContextVariableMap augmentation being in this test's module graph.
    const app = new Hono<{ Variables: HonoVariables }>();
    app.use("*", async (c, next) => {
        c.set("metrics", metrics);
        await next();
    });
    app.use("*", compactLogger);
    app.get("/companion/youtubei/v1/player", (c) => c.text("nope", 401));

    await captureConsoleLog(async () => {
        await app.request("/companion/youtubei/v1/player");
    });

    const latency = await metrics.requestLatency.get();
    const sample = latency.values.find((v) =>
        v.labels.route === "/companion/youtubei/v1/player" &&
        v.labels.method === "GET" && v.labels.status === "401"
    );
    assertExists(sample);
    assertEquals((await metrics.authFailures.get()).values[0]?.value, 1);
});
