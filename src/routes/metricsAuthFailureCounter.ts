import type { MiddlewareHandler } from "hono";

/**
 * Counts bearer-auth failures on /metrics into the same `authFailures`
 * counter compactLogger increments for the companion app, so the metric's
 * help text ("bearer auth on /youtubei/v1/* and /metrics") stays accurate:
 * /metrics is mounted on the root app via miscRoutes, not the companion
 * app, so it never passes through compactLogger.
 *
 * Kept in its own module (rather than inline in routes/index.ts) so tests
 * can import it without pulling in routes/index.ts's much wider module
 * graph (player.ts, download.ts, ...), which assumes main.ts's global
 * ContextVariableMap augmentation is present.
 */
export const metricsAuthFailureCounter: MiddlewareHandler = async (
    c,
    next,
) => {
    await next();
    if (c.res.status === 401) {
        c.get("metrics")?.authFailures.inc();
    }
};
