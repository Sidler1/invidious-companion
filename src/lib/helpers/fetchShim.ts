import { retry, type RetryOptions } from "@std/async";
import type { Config } from "./config.ts";
import type { FetchGate } from "./fetchGate.ts";

export type FetchInputParameter = Parameters<typeof fetch>[0];
/**
 * `client`: a pre-built Deno.HttpClient (proxy / local address binding).
 * `streaming`: set by callers that stream a large body (video proxy). When
 * true, fetchShim attaches NO timeout signal, because `AbortSignal.timeout`
 * covers the whole body read and would cut long transfers. A header-phase
 * timeout for streaming requests is a follow-up (not covered here).
 */
export type FetchInitParameterWithClient = RequestInit & {
    client?: Deno.HttpClient;
    streaming?: boolean;
};
export type FetchReturn = ReturnType<typeof fetch>;
export type FetchFn = (
    input: FetchInputParameter,
    init?: FetchInitParameterWithClient,
) => FetchReturn;

/**
 * Decide which AbortSignal a fetch gets.
 * - streaming: only the caller's signal (or none); never a timeout.
 * - otherwise: the timeout signal, combined with the caller's signal when one
 *   is given so neither is silently dropped.
 */
export function buildFetchSignal(
    timeoutMs: number | undefined,
    callerSignal: AbortSignal | null | undefined,
    streaming: boolean | undefined,
): AbortSignal | null {
    if (streaming || !timeoutMs) {
        return callerSignal ?? null;
    }
    const timeoutSignal = AbortSignal.timeout(Number(timeoutMs));
    if (!callerSignal) {
        return timeoutSignal;
    }
    return AbortSignal.any([callerSignal, timeoutSignal]);
}

/**
 * The one place every outbound YouTube request passes through: applies the
 * timeout policy, the optional retry loop and the rate gate.
 * `onRetry` is invoked for every attempt after the first (metrics hook).
 */
export function fetchShim(
    config: Config,
    retryOptions: RetryOptions,
    input: FetchInputParameter,
    init: FetchInitParameterWithClient | undefined,
    gate: FetchGate | undefined,
    onRetry: () => void,
): FetchReturn {
    const fetchTimeout = config.networking.fetch?.timeout_ms;
    const fetchRetry = config.networking.fetch?.retry?.enabled;
    // `streaming` is our own flag, never handed to the native fetch.
    const { streaming, signal: callerSignal, ...nativeInit } = init ?? {};
    let attempt = 0;
    const callFetch = () => {
        // Every invocation after the first is a retry.
        if (attempt++ > 0) onRetry();
        const doFetch = () =>
            fetch(input, {
                ...nativeInit,
                // A fresh timeout per attempt, so retries get the full budget.
                signal: buildFetchSignal(fetchTimeout, callerSignal, streaming),
            });
        return gate ? gate.run(doFetch) : doFetch();
    };
    return fetchRetry ? retry(callFetch, retryOptions) : callFetch();
}
