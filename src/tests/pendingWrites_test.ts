import { assertEquals } from "./deps.ts";
import {
    awaitPendingWrites,
    pendingWriteCount,
    trackPendingWrite,
} from "../lib/helpers/pendingWrites.ts";

Deno.test("pendingWrites", async (t) => {
    await t.step(
        "awaitPendingWrites resolves once every tracked write settled",
        async () => {
            let resolveWrite!: () => void;
            trackPendingWrite(
                new Promise<void>((resolve) => {
                    resolveWrite = resolve;
                }),
            );
            assertEquals(pendingWriteCount(), 1);

            let drained = false;
            const draining = awaitPendingWrites().then(() => {
                drained = true;
            });
            await new Promise((resolve) => setTimeout(resolve, 0));
            assertEquals(drained, false);

            resolveWrite();
            await draining;
            assertEquals(drained, true);
            assertEquals(pendingWriteCount(), 0);
        },
    );

    await t.step(
        "a rejected write is forgotten and does not reject the drain",
        async () => {
            trackPendingWrite(Promise.reject(new Error("disk full")));

            await awaitPendingWrites();

            assertEquals(pendingWriteCount(), 0);
        },
    );
});
