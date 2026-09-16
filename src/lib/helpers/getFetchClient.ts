import type { RetryOptions } from "@std/async";
import type { Config } from "./config.ts";
import type { Metrics } from "./metrics.ts";
import { generateRandomIPv6 } from "./ipv6Rotation.ts";
import { CTX, logWarn } from "./log.ts";
import { FetchGate } from "./fetchGate.ts";
import { checkYouTubeBlock } from "./youtubeBlockDetection.ts";
import {
    type FetchFn,
    type FetchInitParameterWithClient,
    type FetchInputParameter,
    fetchShim as rawFetchShim,
} from "./fetchShim.ts";
import { createProxyPool } from "./proxyPool.ts";

export type {
    FetchFn,
    FetchInitParameterWithClient,
    FetchInputParameter,
    FetchReturn,
} from "./fetchShim.ts";

// Process-wide latch: if generating an IPv6 source address ever fails (host
// has no IPv6 support), we disable rotation permanently rather than retrying
// on every request. Intentionally one-way — recovery requires a restart.
let ipv6Enabled = true;

/**
 * Singleton cache: ensures getFetchClient(config) returns the SAME fetch
 * function (with shared proxy pool state, round-robin index, health tracking)
 * no matter how many times it's called across the codebase.
 *
 * Before this fix, every call to getFetchClient() created a brand-new set of
 * HttpClients, round-robin state, and health tracking — meaning proxy pool
 * state was never shared between main.ts, potoken.ts, and videoPlaybackProxy.ts.
 */
let cachedFetchFn: FetchFn | null = null;
let cachedConfigRef: Config | null = null;

// Module-level metrics handle. Set on the first call that provides it (from
// main.ts at startup) and shared by all internal helpers in this isolate.
// Note: the PO-token worker runs in a separate isolate and has no metrics.
let metricsRef: Metrics | undefined;

// Invoked (in the main isolate only) when a YouTube anti-bot block is detected
// and could not be worked around within the request. main.ts registers a
// debounced handler that proactively regenerates the session.
let onYouTubeBlock: (() => void) | undefined;
export function setOnYouTubeBlock(cb: () => void): void {
    onYouTubeBlock = cb;
}

// Invoked (main isolate only) whenever the proxy pool's active egress proxy
// changes AND switch_proxy_on_limit is enabled. main.ts uses it to swap in the
// per-proxy session (visitor_data + PO token) bound to the new egress IP, so a
// rate-limit-driven hop keeps the session IP-consistent. Not fired when the
// flag is off — the pool then behaves as pure failover, unchanged.
let onActiveProxyChange: ((proxyUrl: string) => void) | undefined;
export function setOnActiveProxyChange(cb: (proxyUrl: string) => void): void {
    onActiveProxyChange = cb;
}

// When the proxy pool is active, this points at its proxy selector so the
// session bootstrap (PO-token worker) can be pinned to the same egress IP the
// request path is using. Null when no pool is configured.
let poolActiveProxySelector:
    | ((excluded?: Set<string>) => Promise<string | null>)
    | null = null;

// When the proxy pool is active, advances the pinned egress proxy to a fresh
// healthy one (see rotateSessionEgressProxy). Null when no pool is configured.
let rotateActiveEgressProxy: (() => Promise<string | null>) | null = null;

/**
 * Resolve the egress proxy the current session should use, so the PO-token
 * worker can attest from the same IP the player/stream requests go through.
 * Returns the pool's active proxy when a pool is configured, otherwise the
 * single configured proxy (or null for direct/IPv6).
 */
export async function getSessionEgressProxy(
    config: Config,
): Promise<string | null> {
    // Ensure the pool (and its selector) has been initialised.
    getFetchClient(config);
    if (poolActiveProxySelector) {
        return await poolActiveProxySelector();
    }
    return config.networking.proxy ?? null;
}

/**
 * Advance the session's egress proxy to a *different* healthy proxy in the
 * pool, returning the newly-pinned proxy URL. Used by the startup PO-token
 * bootstrap to sweep the pool for a non-blocked IP between attempts: a single
 * detected block is only one of the three failures needed to blacklist a
 * proxy, so without this the bootstrap would keep re-pinning (and re-attesting
 * through) the same blocked proxy. Returns the single configured proxy / null
 * when no pool is in use (nothing to rotate).
 */
export async function rotateSessionEgressProxy(
    config: Config,
): Promise<string | null> {
    // Ensure the pool (and its rotator) has been initialised.
    getFetchClient(config);
    if (rotateActiveEgressProxy) {
        return await rotateActiveEgressProxy();
    }
    return config.networking.proxy ?? null;
}

// Process-wide outbound rate limiter (built from config.networking.rate_limit).
let fetchGate: FetchGate | undefined;

// Adapter: keeps the module-level gate and the retry metric out of fetchShim.ts.
function fetchShim(
    config: Config,
    retryOptions: RetryOptions,
    input: FetchInputParameter,
    init?: FetchInitParameterWithClient,
    gate?: FetchGate,
) {
    return rawFetchShim(
        config,
        retryOptions,
        input,
        init,
        gate ?? fetchGate,
        () => metricsRef?.upstreamRetries.inc(),
    );
}

export const getFetchClient = (config: Config, metrics?: Metrics): FetchFn => {
    if (metrics) metricsRef = metrics;

    // Return cached instance if the same config object is used
    if (cachedFetchFn && cachedConfigRef === config) {
        return cachedFetchFn;
    }

    const proxyAddress = config.networking.proxy;
    const ipv6Block = config.networking.ipv6_block;

    const fetchMaxAttempts = config.networking.fetch?.retry?.times;
    const fetchInitialDebounce = config.networking.fetch?.retry
        ?.initial_debounce;
    const fetchDebounceMultiplier = config.networking.fetch?.retry
        ?.debounce_multiplier;
    const retryOptions: RetryOptions = {
        maxAttempts: fetchMaxAttempts,
        minTimeout: fetchInitialDebounce,
        multiplier: fetchDebounceMultiplier,
        jitter: 0,
    };

    // (Re)build the outbound rate limiter for this config.
    const rl = config.networking.rate_limit;
    fetchGate = rl?.enabled
        ? new FetchGate(rl.max_concurrent, rl.min_interval_ms)
        : undefined;

    // The proxy pool is failover-only (see proxyPool.ts). Per-proxy rate
    // gates live inside the pool, so the shared module-level gate would
    // double-count and is disabled on this path.
    const proxyPool = config.networking.proxy_pool;
    if (proxyPool?.enabled && proxyPool.proxies.length > 0) {
        if (rl?.enabled) fetchGate = undefined;
        const pool = createProxyPool({
            config,
            retryOptions,
            fetchShim,
            getMetrics: () => metricsRef,
            getOnYouTubeBlock: () => onYouTubeBlock,
            getOnActiveProxyChange: () => onActiveProxyChange,
        });
        // Expose the selector so the session bootstrap can pin to this pool's
        // active egress proxy (see getSessionEgressProxy), and the rotator so
        // the startup bootstrap can hop between PO-token attempts.
        poolActiveProxySelector = pool.ensureActiveProxy;
        rotateActiveEgressProxy = pool.rotateActiveProxy;

        cachedFetchFn = pool.fetch;
        cachedConfigRef = config;
        return pool.fetch;
    }

    // Single proxy / IPv6 path — no pool, so nothing to pin the session
    // bootstrap's selector/rotator to.
    poolActiveProxySelector = null;
    rotateActiveEgressProxy = null;

    if (proxyAddress || (ipv6Block && ipv6Enabled)) {
        const reusableClient = proxyAddress && !ipv6Block
            ? Deno.createHttpClient({ proxy: { url: proxyAddress } })
            : undefined;

        const fn: FetchFn = async (
            input: FetchInputParameter,
            init?: FetchInitParameterWithClient,
        ) => {
            let client: Deno.HttpClient;
            if (reusableClient) {
                client = reusableClient;
            } else {
                const clientOptions: Deno.CreateHttpClientOptions = {};
                if (proxyAddress) clientOptions.proxy = { url: proxyAddress };
                if (ipv6Block && ipv6Enabled) {
                    try {
                        clientOptions.localAddress = generateRandomIPv6(
                            ipv6Block,
                        );
                        metricsRef?.ipv6AddressGenerated.inc();
                    } catch {
                        ipv6Enabled = false;
                        metricsRef?.ipv6Fallback.inc();
                    }
                }
                client = Deno.createHttpClient(clientOptions);
            }

            let fetchRes: Response;
            try {
                fetchRes = await fetchShim(config, retryOptions, input, {
                    client,
                    ...init,
                });
            } catch (e) {
                if (!reusableClient) client.close();
                throw e;
            }
            // Per-request clients (IPv6 rotation) would otherwise never be
            // closed and leak a socket/FD per request. The client must stay
            // open until the body has been streamed, so close it only when
            // the response settles.
            if (!reusableClient) {
                fetchRes = closeClientWhenDone(fetchRes, client);
            }

            // Detect YouTube block signals even on single-proxy path.
            // Previously this detection only existed in the proxy_pool path,
            // so blocks via a single proxy or direct connection were invisible.
            const isBlocked = await checkYouTubeBlock(fetchRes);
            if (isBlocked) {
                logWarn(
                    CTX.PROXY,
                    `YouTube block detected on direct/single-proxy path — consider enabling proxy_pool`,
                );
                // No alternate egress to retry here, but a proactive session
                // regeneration may still recover (new visitor_data/PO token).
                onYouTubeBlock?.();
            }

            return fetchRes;
        };

        cachedFetchFn = fn;
        cachedConfigRef = config;
        return fn;
    }

    // No proxy path — direct fetch
    const fn: FetchFn = (
        input: FetchInputParameter,
        init?: FetchInitParameterWithClient,
    ) => fetchShim(config, retryOptions, input, init);

    cachedFetchFn = fn;
    cachedConfigRef = config;
    return fn;
};

/**
 * Tie the lifetime of a per-request HttpClient to its response: close the
 * client once the body has been fully read, cancelled, or errored. Closing
 * earlier would abort the in-flight body stream; never closing leaks a
 * socket/FD per request (fatal under IPv6 rotation, where a fresh client is
 * created for every request).
 */
function closeClientWhenDone(
    res: Response,
    client: Deno.HttpClient,
): Response {
    const close = () => {
        try {
            client.close();
        } catch {
            // Already closed.
        }
    };
    if (!res.body) {
        close();
        return res;
    }
    const monitored = res.body.pipeThrough(
        new TransformStream({ flush: close, cancel: close }),
    );
    const wrapped = new Response(monitored, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
    });
    // new Response() drops these read-only fetch metadata fields; callers
    // (e.g. youtubei.js) may inspect them.
    Object.defineProperty(wrapped, "url", { value: res.url });
    Object.defineProperty(wrapped, "redirected", { value: res.redirected });
    return wrapped;
}
