/**
 * Minimal stand-in for a Web Worker: records posted messages, lets a test
 * emit "message" / "error" events, and remembers whether it was terminated.
 *
 * Composes an internal EventTarget rather than extending it. Extending
 * EventTarget would inherit its generic `(type: string, listener:
 * EventListenerOrEventListenerObject) => void` addEventListener, which
 * TypeScript cannot narrow via a subclass override (base and override must
 * stay assignment-compatible) — so callers like `TokenGeneratorWorker` that
 * expect per-event-type listener types (`MessageEvent` for "message",
 * `ErrorEvent` for "error") would need casts at every call site. Declaring
 * the narrower overloads directly on this class avoids that.
 */
export class FakeWorker {
    public terminated = false;
    public readonly posted: unknown[] = [];
    private readonly target = new EventTarget();

    postMessage(message: unknown): void {
        this.posted.push(message);
    }

    terminate(): void {
        this.terminated = true;
    }

    emit(data: unknown): void {
        this.target.dispatchEvent(new MessageEvent("message", { data }));
    }

    emitError(message: string): void {
        this.target.dispatchEvent(new ErrorEvent("error", { message }));
    }

    emitMessageError(): void {
        this.target.dispatchEvent(new MessageEvent("messageerror"));
    }

    addEventListener(
        type: "message" | "messageerror",
        listener: (event: MessageEvent) => void,
    ): void;
    addEventListener(
        type: "error",
        listener: (event: ErrorEvent) => void,
    ): void;
    addEventListener(
        type: string,
        listener:
            | ((event: MessageEvent) => void)
            | ((event: ErrorEvent) => void),
    ): void {
        this.target.addEventListener(type, listener as EventListener);
    }

    removeEventListener(
        type: "message",
        listener: (event: MessageEvent) => void,
    ): void {
        this.target.removeEventListener(type, listener as EventListener);
    }
}
