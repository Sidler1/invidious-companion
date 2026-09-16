/**
 * Best-effort outbound rate limiter. Caps the number of concurrent in-flight
 * requests and optionally enforces a minimum spacing between request starts.
 * Shared process-wide; combined with the failover-only proxy pool this
 * throttles how hard the single active egress IP is hit.
 */
export class FetchGate {
    private active = 0;
    private readonly waiters: Array<() => void> = [];
    private nextStart = 0;

    constructor(
        private readonly maxConcurrent: number,
        private readonly minIntervalMs: number,
    ) {}

    async run<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }

    // True when no concurrency slot is free right now. Used by the proxy pool
    // to decide whether to hop to another proxy instead of queuing here.
    saturated(): boolean {
        return this.active >= this.maxConcurrent;
    }

    private async acquire(): Promise<void> {
        if (this.active >= this.maxConcurrent) {
            await new Promise<void>((resolve) => this.waiters.push(resolve));
        }
        this.active++;
        if (this.minIntervalMs > 0) {
            const now = Date.now();
            const startAt = Math.max(now, this.nextStart);
            this.nextStart = startAt + this.minIntervalMs;
            const wait = startAt - now;
            if (wait > 0) {
                await new Promise((resolve) => setTimeout(resolve, wait));
            }
        }
    }

    private release(): void {
        this.active--;
        const next = this.waiters.shift();
        if (next) next();
    }
}
