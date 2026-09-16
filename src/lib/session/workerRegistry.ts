import { CTX, logError, logInfo } from "../helpers/log.ts";

/** The only capability the registry needs from a worker. */
export interface TerminableWorker {
    terminate(): void;
}

// Live PO-token workers. A Set (not an array) so termination is by identity,
// never by position: the "kill everything but the newest" loop this replaces
// assumed the completing worker was the last one pushed, which is false as
// soon as two generations overlap.
const registered = new Set<TerminableWorker>();

function safeTerminate(worker: TerminableWorker): void {
    try {
        worker.terminate();
    } catch (err) {
        logError(CTX.PO_TOKEN, "Failed to terminate worker", err);
    }
}

export function registerWorker(worker: TerminableWorker): void {
    registered.add(worker);
}

/** Terminate and forget one worker. No-op for unknown workers. */
export function releaseWorker(worker: TerminableWorker): void {
    if (!registered.delete(worker)) return;
    safeTerminate(worker);
}

/**
 * Terminate every registered worker that is not in `keep`. Called after a
 * session is adopted with the set of workers still referenced by the current
 * session and any cached per-proxy sessions.
 */
export function terminateUnreferenced(
    keep: ReadonlySet<TerminableWorker>,
): number {
    let terminated = 0;
    for (const worker of registered) {
        if (keep.has(worker)) continue;
        releaseWorker(worker);
        terminated++;
    }
    return terminated;
}

export function registeredWorkerCount(): number {
    return registered.size;
}

/** Shutdown: terminate everything. */
export function cleanupWorkers(): void {
    if (registered.size === 0) return;
    logInfo(
        CTX.PO_TOKEN,
        `Cleaning up ${registered.size} worker(s) for shutdown`,
    );
    for (const worker of registered) {
        releaseWorker(worker);
    }
}
