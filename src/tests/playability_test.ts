import { assertEquals, assertThrows } from "./deps.ts";
import { HTTPException } from "hono/http-exception";
import {
    assertPlayable,
    getPlayabilityStatus,
} from "../lib/helpers/playability.ts";

Deno.test("getPlayabilityStatus reads status and reason from raw JSON", () => {
    assertEquals(
        getPlayabilityStatus({
            playabilityStatus: { status: "ERROR", reason: "Video unavailable" },
        }),
        { status: "ERROR", reason: "Video unavailable" },
    );
    assertEquals(getPlayabilityStatus({}), {
        status: undefined,
        reason: undefined,
    });
});

Deno.test("assertPlayable", async (t) => {
    await t.step("passes for OK", () => {
        assertPlayable("abcdefghijk", { playabilityStatus: { status: "OK" } });
    });

    await t.step("throws 403 with the legacy message otherwise", async () => {
        const err = assertThrows(
            () =>
                assertPlayable("abcdefghijk", {
                    playabilityStatus: {
                        status: "ERROR",
                        reason: "Video unavailable",
                    },
                }),
            HTTPException,
        );
        assertEquals(err.status, 403);
        assertEquals(
            await err.getResponse().text(),
            "The video can't be played: abcdefghijk due to reason: Video unavailable",
        );
    });
});
