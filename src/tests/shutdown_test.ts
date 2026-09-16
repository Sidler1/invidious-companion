import { assertEquals } from "./deps.ts";
import {
    cleanupWorkers,
    registeredWorkerCount,
    registerWorker,
} from "../lib/session/workerRegistry.ts";
import { FakeWorker } from "./helpers/fakeWorker.ts";

Deno.test("cleanupWorkers terminates a registered worker and empties the registry", () => {
    const worker = new FakeWorker();
    registerWorker(worker);

    cleanupWorkers();

    assertEquals(worker.terminated, true);
    assertEquals(registeredWorkerCount(), 0);
});
