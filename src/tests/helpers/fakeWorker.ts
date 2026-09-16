/**
 * Minimal stand-in for a Web Worker: records posted messages, lets a test
 * emit "message" / "error" events, and remembers whether it was terminated.
 */
export class FakeWorker extends EventTarget {
    public terminated = false;
    public readonly posted: unknown[] = [];

    postMessage(message: unknown): void {
        this.posted.push(message);
    }

    terminate(): void {
        this.terminated = true;
    }

    emit(data: unknown): void {
        this.dispatchEvent(new MessageEvent("message", { data }));
    }

    emitError(message: string): void {
        this.dispatchEvent(new ErrorEvent("error", { message }));
    }
}
