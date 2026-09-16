import type { Innertube } from "youtubei.js";
import type { Config } from "../helpers/config.ts";
import type { Metrics } from "../helpers/metrics.ts";
import type { TokenGeneratorWorker, TokenMinter } from "../jobs/potoken.ts";
import { CTX, logError, logInfo, logWarn } from "../helpers/log.ts";
import { releaseWorker, type TerminableWorker } from "./workerRegistry.ts";

/** What a generator hands back. A GeneratedPoTokenSession is assignable. */
export interface GeneratedSession {
    innertubeClient: Innertube;
    tokenMinter: TokenMinter | undefined;
    /** undefined when there is no PO-token worker (oauth / po_token disabled). */
    worker: TokenGeneratorWorker | undefined;
    /** Egress proxy the session was minted through (null: direct / IPv6). */
    egressProxyUrl: string | null;
    sessionTtlSecs?: number;
}

export interface SessionLifecycleDeps {
    config: Config;
    metrics: Metrics | undefined;
    /** Produces a brand-new session (PO-token worker or plain client). */
    generate: (reason: string) => Promise<GeneratedSession>;
    /** Installs the pair into the request path (sharedState.set). */
    install: (client: Innertube, minter: TokenMinter | undefined) => void;
    /** Clock seam for tests. */
    now?: () => number;
}

interface CachedSession {
    client: Innertube;
    minter: TokenMinter | undefined;
    worker: TokenGeneratorWorker | undefined;
    generatedAtMs: number;
    sessionTtlSecs?: number;
}

const BLOCK_REGEN_COOLDOWN_MS = 60_000;

/**
 * Owns the session lifecycle: who is generating, whether a trigger must be
 * queued, which sessions (and therefore which workers) are still referenced,
 * and the timestamps readiness and the cron reason about.
 *
 * Invariants:
 * - At most one generation runs at a time (bootstrap or regenerate).
 * - A trigger that arrives during a regeneration runs once more afterwards
 *   instead of being lost.
 * - A worker is terminated only when neither the current session nor a
 *   cached per-proxy session references it.
 */
export class SessionLifecycle {
    private regenInFlight = false;
    private pendingTrigger: string | null = null;
    private _initialSessionReady = false;
    private _sessionGeneratedAtMs = 0;
    private _lastMintOkMs = 0;
    private lastBlockRegenMs = 0;
    private sessionTtlSecs: number | undefined;
    private currentWorker: TokenGeneratorWorker | undefined;
    private readonly perProxySessions = new Map<string, CachedSession>();
    // Every worker this instance has adopted or cached, so reconciliation
    // only ever releases workers it actually owns (see reconcileWorkers).
    private readonly knownWorkers = new Set<TerminableWorker>();
    private readonly perProxyEnabled: boolean;
    private readonly now: () => number;

    constructor(private readonly deps: SessionLifecycleDeps) {
        const pool = deps.config.networking.proxy_pool;
        this.perProxyEnabled = pool.enabled && pool.switch_proxy_on_limit;
        this.now = deps.now ?? Date.now;
    }

    get initialSessionReady(): boolean {
        return this._initialSessionReady;
    }

    get sessionGeneratedAtMs(): number {
        return this._sessionGeneratedAtMs;
    }

    get lastMintOkMs(): number {
        return this._lastMintOkMs;
    }

    get regenerationInFlight(): boolean {
        return this.regenInFlight;
    }

    // Effective session lifetime: the smaller of the operator's configured cap
    // and YouTube's estimated integrity-token TTL (when the worker reported
    // one). Honouring the server estimate means we refresh before the token
    // actually expires; session_lifetime_hours stays an upper bound.
    effectiveSessionLifetimeMs(): number {
        return this.lifetimeMsFor(this.sessionTtlSecs);
    }

    isSessionFresh(): boolean {
        if (this._sessionGeneratedAtMs === 0) return false;
        const age = this.now() - this._sessionGeneratedAtMs;
        return age < this.effectiveSessionLifetimeMs();
    }

    /** Install a freshly generated session and reconcile worker ownership. */
    adopt(session: GeneratedSession): void {
        const now = this.now();
        const minter = this.wrapMinter(session.tokenMinter);
        this.deps.install(session.innertubeClient, minter);
        this.currentWorker = session.worker;
        this._sessionGeneratedAtMs = now;
        this.sessionTtlSecs = session.sessionTtlSecs;
        // Generation validated a mint via checkToken, so the minter is known
        // good as of now.
        this._lastMintOkMs = now;
        this._initialSessionReady = true;

        if (this.perProxyEnabled && session.egressProxyUrl) {
            this.perProxySessions.set(session.egressProxyUrl, {
                client: session.innertubeClient,
                minter,
                worker: session.worker,
                generatedAtMs: now,
                sessionTtlSecs: session.sessionTtlSecs,
            });
        }
        this.evictExpiredProxySessions();
        this.reconcileWorkers();
    }

    /**
     * Regenerate the session. If one is already in flight the trigger is
     * queued and exactly one more regeneration runs after the current one.
     */
    async regenerate(reason: string): Promise<void> {
        if (this.regenInFlight) {
            this.pendingTrigger = reason;
            this.deps.metrics?.sessionRegenDropped.inc();
            logInfo(
                CTX.PO_TOKEN,
                `Regeneration (${reason}) queued behind in-flight generation`,
            );
            return;
        }
        this.regenInFlight = true;
        try {
            let current: string | null = reason;
            while (current !== null) {
                this.pendingTrigger = null;
                try {
                    await this.runGeneration(current);
                } catch (err) {
                    // A trigger that coalesced behind this generation still
                    // deserves its own attempt (spec A5): only give up and
                    // propagate the failure when nothing is queued behind it.
                    if (this.pendingTrigger === null) throw err;
                    logWarn(
                        CTX.PO_TOKEN,
                        `Session regeneration (${current}) failed, retrying for queued trigger (${this.pendingTrigger}): ${err}`,
                    );
                }
                current = this.pendingTrigger;
            }
        } finally {
            this.pendingTrigger = null;
            this.regenInFlight = false;
        }
    }

    /**
     * Run the startup bootstrap under the same guard as regenerate, so the
     * cron / block / proxy-switch triggers cannot start a second generator
     * while the bootstrap is still searching for a valid token.
     */
    async bootstrap(run: () => Promise<GeneratedSession>): Promise<void> {
        if (this.regenInFlight) {
            throw new Error("bootstrap called while a generation is in flight");
        }
        this.regenInFlight = true;
        try {
            this.adopt(await run());
        } finally {
            // Triggers that queued during bootstrap are dropped: the bootstrap
            // just produced a fresh session, replaying them would only churn.
            this.pendingTrigger = null;
            this.regenInFlight = false;
        }
    }

    /**
     * The proxy pool hopped to `proxyUrl`. Reuse that proxy's cached session
     * if it is still fresh, otherwise mint one for it in the background.
     */
    switchToProxy(proxyUrl: string): "reused" | "regenerating" | "ignored" {
        // The bootstrap loop rotates the egress proxy itself while hunting for
        // a token; ignore those hops until a session is established.
        if (!this._initialSessionReady) return "ignored";
        const cached = this.perProxySessions.get(proxyUrl);
        if (cached && this.isCachedFresh(cached)) {
            this.deps.install(cached.client, cached.minter);
            this.currentWorker = cached.worker;
            this._sessionGeneratedAtMs = cached.generatedAtMs;
            this.sessionTtlSecs = cached.sessionTtlSecs;
            return "reused";
        }
        logInfo(
            CTX.PROXY,
            "Active egress proxy changed — minting session for new IP",
        );
        this.regenerate("proxy-switch").catch((err) =>
            logError(CTX.PROXY, "Proxy-switch session regeneration failed", err)
        );
        return "regenerating";
    }

    /**
     * A YouTube block was detected. Regenerate proactively, debounced so a
     * burst of blocked requests can't trigger a regeneration storm. Returns
     * whether a regeneration was triggered.
     */
    onBlockDetected(): boolean {
        if (!this._initialSessionReady) return false;
        const now = this.now();
        if (now - this.lastBlockRegenMs < BLOCK_REGEN_COOLDOWN_MS) return false;
        this.lastBlockRegenMs = now;
        this.deps.metrics?.blockTriggeredRegens.inc();
        logWarn(
            CTX.PO_TOKEN,
            "YouTube block detected — regenerating session proactively",
        );
        this.regenerate("block-detected").catch((err) =>
            logError(
                CTX.PO_TOKEN,
                "Block-triggered session regeneration failed",
                err,
            )
        );
        return true;
    }

    /** Drop cached per-proxy sessions past their lifetime; returns how many. */
    evictExpiredProxySessions(): number {
        let evicted = 0;
        for (const [proxyUrl, cached] of this.perProxySessions) {
            if (this.isCachedFresh(cached)) continue;
            this.perProxySessions.delete(proxyUrl);
            evicted++;
        }
        if (evicted > 0) this.reconcileWorkers();
        return evicted;
    }

    private async runGeneration(reason: string): Promise<void> {
        try {
            this.adopt(await this.deps.generate(reason));
            logInfo(CTX.PO_TOKEN, `Session regenerated (${reason})`);
        } catch (err) {
            this.deps.metrics?.potokenGenerationFailure.inc();
            throw err;
        }
    }

    private isCachedFresh(cached: CachedSession): boolean {
        const lifetimeMs = this.lifetimeMsFor(cached.sessionTtlSecs);
        return this.now() - cached.generatedAtMs < lifetimeMs;
    }

    // Shared formula for both the live session and cached per-proxy
    // sessions: the smaller of the operator's configured cap and YouTube's
    // estimated integrity-token TTL, when one was reported.
    private lifetimeMsFor(ttlSecs: number | undefined): number {
        const configMs = this.deps.config.jobs.youtube_session
            .session_lifetime_hours * 60 * 60 * 1000;
        if (ttlSecs && ttlSecs > 0) {
            return Math.min(configMs, ttlSecs * 1000);
        }
        return configMs;
    }

    private referencedWorkers(): Set<TerminableWorker> {
        const keep = new Set<TerminableWorker>();
        if (this.currentWorker) keep.add(this.currentWorker);
        for (const cached of this.perProxySessions.values()) {
            if (cached.worker) keep.add(cached.worker);
        }
        return keep;
    }

    // Release every worker this instance previously adopted or cached that
    // is no longer referenced. Deliberately scoped to `knownWorkers` rather
    // than a global "terminate every unreferenced registered worker" sweep:
    // the worker registry is process-wide, so a blind sweep would also catch
    // a worker some *other* in-flight generation just registered but has not
    // handed to adopt() yet, terminating a session before it is ever used.
    private reconcileWorkers(): void {
        const keep = this.referencedWorkers();
        for (const worker of keep) this.knownWorkers.add(worker);
        for (const worker of this.knownWorkers) {
            if (keep.has(worker)) continue;
            releaseWorker(worker);
            this.knownWorkers.delete(worker);
        }
    }

    // Wrap the minter so every successful per-video mint refreshes
    // lastMintOkMs, which readiness uses to detect a dead minter.
    private wrapMinter(
        minter: TokenMinter | undefined,
    ): TokenMinter | undefined {
        if (!minter) return undefined;
        return async (videoId: string): Promise<string> => {
            const token = await minter(videoId);
            this._lastMintOkMs = this.now();
            return token;
        };
    }
}
