import { assert, assertEquals } from "./deps.ts";
import { buildFetchSignal } from "../lib/helpers/fetchShim.ts";

Deno.test("buildFetchSignal", async (t) => {
    await t.step("returns null when streaming and no caller signal", () => {
        assertEquals(buildFetchSignal(30_000, undefined, true), null);
    });

    await t.step("returns the caller signal untouched when streaming", () => {
        const controller = new AbortController();
        const signal = buildFetchSignal(30_000, controller.signal, true);
        assert(signal === controller.signal);
    });

    await t.step("returns a timeout signal when not streaming", () => {
        const signal = buildFetchSignal(30_000, undefined, false);
        assert(signal instanceof AbortSignal);
        assertEquals(signal.aborted, false);
    });

    await t.step("returns null when no timeout and not streaming", () => {
        assertEquals(buildFetchSignal(undefined, undefined, false), null);
    });

    await t.step(
        "combines caller signal and timeout when not streaming",
        () => {
            const controller = new AbortController();
            const signal = buildFetchSignal(30_000, controller.signal, false);
            assert(signal !== null);
            assert(signal !== controller.signal);
            assertEquals(signal!.aborted, false);
            controller.abort();
            assertEquals(signal!.aborted, true);
        },
    );
});
