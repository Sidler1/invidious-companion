import { assertEquals } from "./deps.ts";
import {
    cleanupWorkers,
    registeredWorkerCount,
    registerWorker,
    releaseWorker,
} from "../lib/session/workerRegistry.ts";
import { FakeWorker } from "./helpers/fakeWorker.ts";

Deno.test("workerRegistry", async (t) => {
    await t.step("cleanupWorkers does not throw with no workers", () => {
        cleanupWorkers();
        assertEquals(registeredWorkerCount(), 0);
    });

    await t.step("releaseWorker terminates exactly that worker", () => {
        const a = new FakeWorker();
        const b = new FakeWorker();
        registerWorker(a);
        registerWorker(b);

        releaseWorker(a);

        assertEquals(a.terminated, true);
        assertEquals(b.terminated, false);
        assertEquals(registeredWorkerCount(), 1);
        cleanupWorkers();
    });

    await t.step("releaseWorker ignores unknown workers", () => {
        const stranger = new FakeWorker();
        releaseWorker(stranger);
        assertEquals(stranger.terminated, false);
    });

    await t.step("cleanupWorkers terminates every registered worker", () => {
        const a = new FakeWorker();
        const b = new FakeWorker();
        registerWorker(a);
        registerWorker(b);

        cleanupWorkers();

        assertEquals(a.terminated, true);
        assertEquals(b.terminated, true);
        assertEquals(registeredWorkerCount(), 0);
    });
});
