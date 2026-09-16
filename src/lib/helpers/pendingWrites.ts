/**
 * Tracks fire-and-forget KV writes so graceful shutdown can drain them
 * before closing the store. Callers handle (log) their own rejections; the
 * tracker only cares that the promise settled.
 */
const pending = new Set<Promise<unknown>>();

export function trackPendingWrite(write: Promise<unknown>): void {
    const tracked: Promise<unknown> = write
        .catch(() => undefined)
        .finally(() => {
            pending.delete(tracked);
        });
    pending.add(tracked);
}

export async function awaitPendingWrites(): Promise<void> {
    await Promise.allSettled(Array.from(pending));
}

export function pendingWriteCount(): number {
    return pending.size;
}
