import { assertEquals } from "./deps.ts";
import { delay } from "@std/async";
import type { Innertube } from "youtubei.js";
import type { Config } from "../lib/helpers/config.ts";
import { Metrics } from "../lib/helpers/metrics.ts";
import {
    type GeneratedSession,
    SessionLifecycle,
} from "../lib/session/sessionLifecycle.ts";
import {
    cleanupWorkers,
    registerWorker,
} from "../lib/session/workerRegistry.ts";
import { FakeWorker } from "./helpers/fakeWorker.ts";

const HOUR_MS = 60 * 60 * 1000;

function makeConfig(
    overrides: { perProxy?: boolean; lifetimeHours?: number } = {},
): Config {
    return {
        jobs: {
            youtube_session: {
                session_lifetime_hours: overrides.lifetimeHours ?? 6,
            },
        },
        networking: {
            proxy_pool: {
                enabled: overrides.perProxy ?? false,
                switch_proxy_on_limit: overrides.perProxy ?? false,
            },
        },
    } as unknown as Config;
}

type TestSession = GeneratedSession & { worker: FakeWorker };

function makeSession(egressProxyUrl: string | null = null): TestSession {
    const worker = new FakeWorker();
    registerWorker(worker);
    return {
        innertubeClient: { id: crypto.randomUUID() } as unknown as Innertube,
        tokenMinter: () => Promise.resolve("token"),
        worker,
        egressProxyUrl,
    };
}

async function counterValue(
    counter: { get(): Promise<{ values: { value: number }[] }> },
): Promise<number> {
    return (await counter.get()).values[0]?.value ?? 0;
}

interface Harness {
    lifecycle: SessionLifecycle;
    installed: { client: Innertube; minter: unknown }[];
    calls: string[];
    clock: { now: number };
    metrics: Metrics;
}

function harness(
    config: Config,
    generate?: (reason: string) => Promise<GeneratedSession>,
): Harness {
    const installed: Harness["installed"] = [];
    const calls: string[] = [];
    const clock = { now: 1_000_000 };
    const metrics = new Metrics();
    const lifecycle = new SessionLifecycle({
        config,
        metrics,
        now: () => clock.now,
        install: (client, minter) => {
            installed.push({ client, minter });
        },
        generate: (reason) => {
            calls.push(reason);
            return generate ? generate(reason) : Promise.resolve(makeSession());
        },
    });
    return { lifecycle, installed, calls, clock, metrics };
}

Deno.test("SessionLifecycle", async (t) => {
    await t.step("adopt installs the session and marks it ready", () => {
        const h = harness(makeConfig());
        const session = makeSession();

        h.lifecycle.adopt(session);

        assertEquals(h.installed.length, 1);
        assertEquals(h.installed[0].client, session.innertubeClient);
        assertEquals(h.lifecycle.initialSessionReady, true);
        assertEquals(h.lifecycle.sessionGeneratedAtMs, h.clock.now);
        assertEquals(h.lifecycle.lastMintOkMs, h.clock.now);
        assertEquals(h.lifecycle.isSessionFresh(), true);
        cleanupWorkers();
    });

    await t.step(
        "adopt terminates the previous worker when per-proxy sessions are off",
        () => {
            const h = harness(makeConfig());
            const first = makeSession();
            const second = makeSession();

            h.lifecycle.adopt(first);
            h.lifecycle.adopt(second);

            assertEquals(first.worker.terminated, true);
            assertEquals(second.worker.terminated, false);
            cleanupWorkers();
        },
    );

    await t.step(
        "per-proxy sessions keep their workers until the lifetime expires",
        () => {
            const h = harness(makeConfig({ perProxy: true, lifetimeHours: 6 }));
            const a = makeSession("http://a:1");
            const b = makeSession("http://b:1");

            h.lifecycle.adopt(a);
            h.lifecycle.adopt(b);
            assertEquals(a.worker.terminated, false);
            assertEquals(b.worker.terminated, false);

            h.clock.now += 7 * HOUR_MS;
            const c = makeSession("http://c:1");
            h.lifecycle.adopt(c);

            assertEquals(a.worker.terminated, true);
            assertEquals(b.worker.terminated, true);
            assertEquals(c.worker.terminated, false);
            cleanupWorkers();
        },
    );

    await t.step(
        "switchToProxy reuses a fresh cached session and its live worker",
        () => {
            const h = harness(makeConfig({ perProxy: true }));
            const a = makeSession("http://a:1");
            const b = makeSession("http://b:1");
            h.lifecycle.adopt(a);
            h.lifecycle.adopt(b);

            const outcome = h.lifecycle.switchToProxy("http://a:1");

            assertEquals(outcome, "reused");
            assertEquals(h.installed.at(-1)?.client, a.innertubeClient);
            assertEquals(a.worker.terminated, false);
            cleanupWorkers();
        },
    );

    await t.step(
        "switchToProxy regenerates when the cached session is stale",
        async () => {
            const h = harness(makeConfig({ perProxy: true, lifetimeHours: 1 }));
            h.lifecycle.adopt(makeSession("http://a:1"));
            h.lifecycle.adopt(makeSession("http://b:1"));
            h.clock.now += 2 * HOUR_MS;

            const outcome = h.lifecycle.switchToProxy("http://a:1");
            await delay(0);

            assertEquals(outcome, "regenerating");
            assertEquals(h.calls, ["proxy-switch"]);
            cleanupWorkers();
        },
    );

    await t.step(
        "switchToProxy is ignored before the first session is ready",
        () => {
            const h = harness(makeConfig({ perProxy: true }));
            assertEquals(h.lifecycle.switchToProxy("http://a:1"), "ignored");
            assertEquals(h.calls, []);
        },
    );

    await t.step(
        "regenerate coalesces a trigger that arrives while one is in flight",
        async () => {
            let release!: (s: GeneratedSession) => void;
            const h = harness(
                makeConfig(),
                () =>
                    new Promise<GeneratedSession>((resolve) => {
                        release = resolve;
                    }),
            );

            const first = h.lifecycle.regenerate("scheduled");
            await h.lifecycle.regenerate("block-detected");
            assertEquals(h.calls, ["scheduled"]);
            assertEquals(await counterValue(h.metrics.sessionRegenDropped), 1);

            release(makeSession());
            await delay(0);
            assertEquals(h.calls, ["scheduled", "block-detected"]);

            release(makeSession());
            await first;
            assertEquals(h.lifecycle.regenerationInFlight, false);
            assertEquals(h.installed.length, 2);
            cleanupWorkers();
        },
    );

    await t.step(
        "regenerate retries a trigger coalesced behind a failing generation instead of dropping it",
        async () => {
            let rejectFirst!: (err: Error) => void;
            let resolveSecond!: (s: GeneratedSession) => void;
            let callCount = 0;
            const h = harness(
                makeConfig(),
                () => {
                    callCount++;
                    if (callCount === 1) {
                        return new Promise<GeneratedSession>(
                            (_resolve, reject) => {
                                rejectFirst = reject;
                            },
                        );
                    }
                    return new Promise<GeneratedSession>((resolve) => {
                        resolveSecond = resolve;
                    });
                },
            );

            const first = h.lifecycle.regenerate("scheduled");
            await h.lifecycle.regenerate("block-detected");
            assertEquals(h.calls, ["scheduled"]);

            rejectFirst(new Error("attestation failed"));
            await delay(0);
            // The coalesced trigger ran instead of being dropped with the
            // failed generation.
            assertEquals(h.calls, ["scheduled", "block-detected"]);
            assertEquals(
                await counterValue(h.metrics.potokenGenerationFailure),
                1,
            );
            assertEquals(h.lifecycle.regenerationInFlight, true);

            resolveSecond(makeSession());
            // Nothing was pending after the retry succeeded, so the original
            // regenerate("scheduled") call resolves rather than rejecting.
            await first;
            assertEquals(h.lifecycle.regenerationInFlight, false);
            cleanupWorkers();
        },
    );

    await t.step(
        "regenerate rethrows a generation failure and counts it",
        async () => {
            const h = harness(
                makeConfig(),
                () => Promise.reject(new Error("attestation failed")),
            );

            let message = "";
            try {
                await h.lifecycle.regenerate("scheduled");
            } catch (err) {
                message = (err as Error).message;
            }

            assertEquals(message, "attestation failed");
            assertEquals(
                await counterValue(h.metrics.potokenGenerationFailure),
                1,
            );
            assertEquals(h.lifecycle.regenerationInFlight, false);
        },
    );

    await t.step(
        "bootstrap holds the in-flight guard so nothing runs concurrently",
        async () => {
            let release!: (s: GeneratedSession) => void;
            const h = harness(makeConfig());

            const bootstrapping = h.lifecycle.bootstrap(() =>
                new Promise<GeneratedSession>((resolve) => {
                    release = resolve;
                })
            );
            assertEquals(h.lifecycle.regenerationInFlight, true);

            await h.lifecycle.regenerate("scheduled");
            assertEquals(h.calls, []);

            release(makeSession());
            await bootstrapping;

            assertEquals(h.lifecycle.initialSessionReady, true);
            assertEquals(h.lifecycle.regenerationInFlight, false);
            // A trigger queued during bootstrap is discarded, not replayed.
            await delay(0);
            assertEquals(h.calls, []);
            cleanupWorkers();
        },
    );

    await t.step(
        "the installed minter records the last successful mint",
        async () => {
            const h = harness(makeConfig());
            h.lifecycle.adopt(makeSession());
            const minter = h.installed[0].minter as (
                id: string,
            ) => Promise<string>;

            h.clock.now += 1_000;
            const token = await minter("dQw4w9WgXcQ");

            assertEquals(token, "token");
            assertEquals(h.lifecycle.lastMintOkMs, h.clock.now);
            cleanupWorkers();
        },
    );

    await t.step(
        "onBlockDetected regenerates once per cooldown window",
        async () => {
            const h = harness(makeConfig());
            assertEquals(h.lifecycle.onBlockDetected(), false);

            h.lifecycle.adopt(makeSession());
            assertEquals(h.lifecycle.onBlockDetected(), true);
            assertEquals(h.lifecycle.onBlockDetected(), false);
            await delay(0);
            assertEquals(h.calls, ["block-detected"]);

            h.clock.now += 61_000;
            assertEquals(h.lifecycle.onBlockDetected(), true);
            await delay(0);
            assertEquals(h.calls, ["block-detected", "block-detected"]);
            cleanupWorkers();
        },
    );
});
