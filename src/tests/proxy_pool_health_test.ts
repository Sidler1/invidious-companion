import { assertEquals, assertRejects } from "./deps.ts";
import { withTempConfig } from "./helpers/env.ts";
import type { Config } from "../lib/helpers/config.ts";

const PROXY = "http://u:p@proxy1:8080";

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

const okResponse = () => jsonResponse({ playabilityStatus: { status: "OK" } });
const blockedResponse = () =>
    jsonResponse({
        playabilityStatus: {
            status: "LOGIN_REQUIRED",
            reason: "Sign in to confirm you're not a bot",
            subreason: "This helps protect our community.",
        },
    });

async function poolTestConfig(healthCheck: boolean): Promise<Config> {
    const { parseConfig } = await import("../lib/helpers/config.ts");
    const config = await withTempConfig(
        `[server]\nsecret_key = "aaaaaaaaaaaaaaaa"\n`,
        () => parseConfig(),
    );
    return {
        ...config,
        networking: {
            ...config.networking,
            proxy_pool: {
                enabled: true,
                rotation: "round-robin" as const,
                health_check: healthCheck,
                switch_proxy_on_limit: false,
                proxies: [PROXY],
            },
        },
    };
}

/**
 * Stubs `fetch` and `Deno.createHttpClient`. Health probes (generate_204)
 * always succeed; every other request is answered by `onRequest`, which
 * receives the 1-based index of that request. Returns how many non-probe
 * requests reached the "network".
 */
async function withMockedNetwork(
    onRequest: (requestIndex: number) => Promise<Response>,
    fn: () => Promise<void>,
): Promise<number> {
    const originalFetch = globalThis.fetch;
    const originalCreateHttpClient = Deno.createHttpClient;
    let requestCount = 0;

    Deno.createHttpClient =
        (() => ({} as unknown as Deno.HttpClient)) as typeof Deno.createHttpClient;
    globalThis.fetch = ((input: RequestInfo | URL) => {
        if (String(input).includes("generate_204")) {
            return Promise.resolve(jsonResponse({ status: "OK" }));
        }
        requestCount += 1;
        return onRequest(requestCount);
    }) as typeof fetch;

    try {
        await fn();
    } finally {
        globalThis.fetch = originalFetch;
        Deno.createHttpClient = originalCreateHttpClient;
    }
    return requestCount;
}

const connectionReset = () => Promise.reject(new Error("connection reset"));

Deno.test("proxy pool health - does not blacklist a proxy after two failures", async () => {
    const requests = await withMockedNetwork(
        (i) => (i <= 2 ? connectionReset() : Promise.resolve(okResponse())),
        async () => {
            const { getFetchClient } = await import(
                "../lib/helpers/getFetchClient.ts"
            );
            const fetchClient = getFetchClient(await poolTestConfig(true));

            await assertRejects(
                () => fetchClient("http://example.com/1"),
                Error,
                "connection reset",
            );
            await assertRejects(
                () => fetchClient("http://example.com/2"),
                Error,
                "connection reset",
            );

            const recovered = await fetchClient("http://example.com/3");
            assertEquals(recovered.status, 200);
            await recovered.body?.cancel();
        },
    );
    assertEquals(requests, 3);
});

Deno.test("proxy pool health - blacklists a proxy after three consecutive failures and rejects once the pool is exhausted", async () => {
    const requests = await withMockedNetwork(
        () => connectionReset(),
        async () => {
            const { getFetchClient } = await import(
                "../lib/helpers/getFetchClient.ts"
            );
            const fetchClient = getFetchClient(await poolTestConfig(true));

            for (let i = 1; i <= 3; i++) {
                await assertRejects(
                    () => fetchClient(`http://example.com/${i}`),
                    Error,
                    "connection reset",
                );
            }

            // The only proxy is now blacklisted for 1h: no upstream attempt is made.
            await assertRejects(
                () => fetchClient("http://example.com/4"),
                Error,
                "No healthy proxy available",
            );
        },
    );
    assertEquals(requests, 3);
});

Deno.test("proxy pool health - a detected YouTube block counts as a failure toward the blacklist", async () => {
    const requests = await withMockedNetwork(
        () => Promise.resolve(blockedResponse()),
        async () => {
            const { getFetchClient } = await import(
                "../lib/helpers/getFetchClient.ts"
            );
            const fetchClient = getFetchClient(await poolTestConfig(true));

            // With a single proxy there is nowhere to fail over to, so the
            // blocked response itself is returned — but each one is counted.
            for (let i = 1; i <= 3; i++) {
                const res = await fetchClient(`http://example.com/${i}`);
                assertEquals(res.status, 200);
                await res.body?.cancel();
            }

            await assertRejects(
                () => fetchClient("http://example.com/4"),
                Error,
                "No healthy proxy available",
            );
        },
    );
    assertEquals(requests, 3);
});

Deno.test("proxy pool health - never blacklists when health_check is disabled", async () => {
    const requests = await withMockedNetwork(
        () => connectionReset(),
        async () => {
            const { getFetchClient } = await import(
                "../lib/helpers/getFetchClient.ts"
            );
            const fetchClient = getFetchClient(await poolTestConfig(false));

            for (let i = 1; i <= 5; i++) {
                // Still "connection reset", never "No healthy proxy available".
                await assertRejects(
                    () => fetchClient(`http://example.com/${i}`),
                    Error,
                    "connection reset",
                );
            }
        },
    );
    assertEquals(requests, 5);
});
