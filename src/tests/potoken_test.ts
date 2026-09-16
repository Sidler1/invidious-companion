Deno.env.set("SERVER_SECRET_KEY", "aaaaaaaaaaaaaaaa");

import { assertEquals, assertRejects } from "./deps.ts";
import { createMinter, poTokenGenerate } from "../lib/jobs/potoken.ts";
import { registeredWorkerCount } from "../lib/session/workerRegistry.ts";
import { parseConfig } from "../lib/helpers/config.ts";
import { Metrics } from "../lib/helpers/metrics.ts";
import { FakeWorker } from "./helpers/fakeWorker.ts";

async function counterValue(
    counter: { get(): Promise<{ values: { value: number }[] }> },
): Promise<number> {
    return (await counter.get()).values[0]?.value ?? 0;
}

Deno.test("poTokenGenerate", async (t) => {
    const config = await parseConfig();

    await t.step("posts initialise once the worker reports ready", async () => {
        const worker = new FakeWorker();
        const pending = poTokenGenerate(config, undefined, {
            createWorker: () => worker,
            timeoutMs: 200,
        });

        worker.emit({ type: "ready" });
        // Let the async message listener run.
        await new Promise((resolve) => setTimeout(resolve, 0));

        assertEquals(worker.posted.length, 1);
        assertEquals(
            (worker.posted[0] as { type: string }).type,
            "initialise",
        );
        // Never initialised → the generation timeout settles the promise.
        await assertRejects(() => pending, Error, "timed out");
        assertEquals(worker.terminated, true);
    });

    await t.step(
        "rejects and terminates the worker on a worker error event",
        async () => {
            const worker = new FakeWorker();
            const pending = poTokenGenerate(config, undefined, {
                createWorker: () => worker,
                timeoutMs: 5_000,
            });

            worker.emitError("boom");

            await assertRejects(() => pending, Error, "boom");
            assertEquals(worker.terminated, true);
            assertEquals(registeredWorkerCount(), 0);
        },
    );

    await t.step(
        "rejects on a fatal error message without requestId",
        async () => {
            const worker = new FakeWorker();
            const pending = poTokenGenerate(config, undefined, {
                createWorker: () => worker,
                timeoutMs: 5_000,
            });

            worker.emit({ type: "error", error: "attestation failed" });

            await assertRejects(() => pending, Error, "attestation failed");
            assertEquals(worker.terminated, true);
        },
    );

    await t.step(
        "rejects and terminates the worker on a messageerror event",
        async () => {
            const worker = new FakeWorker();
            const pending = poTokenGenerate(config, undefined, {
                createWorker: () => worker,
                timeoutMs: 5_000,
            });

            worker.emitMessageError();

            await assertRejects(() => pending, Error, "unserialisable");
            assertEquals(worker.terminated, true);
            assertEquals(registeredWorkerCount(), 0);
        },
    );

    await t.step("rejects when generation exceeds the timeout", async () => {
        const worker = new FakeWorker();
        const pending = poTokenGenerate(config, undefined, {
            createWorker: () => worker,
            timeoutMs: 20,
        });

        await assertRejects(() => pending, Error, "timed out after 20ms");
        assertEquals(worker.terminated, true);
    });
});

Deno.test("createMinter", async (t) => {
    await t.step(
        "resolves with the content token for the matching requestId",
        async () => {
            const worker = new FakeWorker();
            const minter = createMinter(worker, undefined, 1_000);

            const pending = minter("dQw4w9WgXcQ");
            const request = worker.posted[0] as { requestId: string };
            worker.emit({
                type: "content-token",
                contentToken: "tok",
                requestId: request.requestId,
            });

            assertEquals(await pending, "tok");
        },
    );

    await t.step("counts a mint timeout and rejects", async () => {
        const worker = new FakeWorker();
        const metrics = new Metrics();
        const minter = createMinter(worker, metrics, 10);

        await assertRejects(() => minter("dQw4w9WgXcQ"), Error, "timed out");
        assertEquals(await counterValue(metrics.mintTimeouts), 1);
    });

    await t.step(
        "counts a worker-reported mint failure and rejects",
        async () => {
            const worker = new FakeWorker();
            const metrics = new Metrics();
            const minter = createMinter(worker, metrics, 1_000);

            const pending = minter("dQw4w9WgXcQ");
            const request = worker.posted[0] as { requestId: string };
            worker.emit({
                type: "error",
                error: "minter not ready",
                requestId: request.requestId,
            });

            await assertRejects(() => pending, Error, "minter not ready");
            assertEquals(await counterValue(metrics.mintFailures), 1);
        },
    );
});
