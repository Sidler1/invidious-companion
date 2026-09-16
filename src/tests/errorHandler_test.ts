import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { assert, assertEquals } from "./deps.ts";
import { errorHandler } from "../routes/errorHandler.ts";

function captureConsoleError(fn: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
        lines.push(args.map((a) => String(a)).join(" "));
    };
    return fn().then(() => lines).finally(() => {
        console.error = original;
    });
}

function buildApp(): Hono {
    const app = new Hono();
    app.onError(errorHandler);
    app.get("/boom", () => {
        throw new Error(
            "error sending request for url (https://x/timedtext?pot=SECRETTOKEN)",
        );
    });
    app.get("/teapot", () => {
        throw new HTTPException(418, { res: new Response("short and stout") });
    });
    return app;
}

Deno.test("errorHandler returns a generic 500 and logs a redacted error", async () => {
    const app = buildApp();
    let res: Response | undefined;
    const lines = await captureConsoleError(async () => {
        res = await app.request("/boom");
    });
    assertEquals(res?.status, 500);
    assertEquals(await res?.text(), "Internal Server Error");
    assertEquals(lines.length, 1);
    assert(lines[0].includes("[ERROR] [SERVER]"));
    assert(lines[0].includes("GET /boom"));
    assert(!lines[0].includes("SECRETTOKEN"));
});

Deno.test("errorHandler passes HTTPException responses through unchanged", async () => {
    const app = buildApp();
    let res: Response | undefined;
    const lines = await captureConsoleError(async () => {
        res = await app.request("/teapot");
    });
    assertEquals(res?.status, 418);
    assertEquals(await res?.text(), "short and stout");
    assertEquals(lines.length, 0);
});
