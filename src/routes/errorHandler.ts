import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { CTX, logError } from "../lib/helpers/log.ts";

/**
 * Hono `onError` handler for both Hono apps.
 *
 * HTTPExceptions are deliberate responses (400/403/503/…) and pass through
 * untouched, so the Invidious contract is unchanged. Anything else is an
 * unexpected failure: it is logged through the redacting logger (Hono's
 * default handler would `console.error` the raw error, and Deno embeds full
 * request URLs — including `pot=` values — in fetch errors) and answered
 * with the same generic body Hono's default produces.
 */
export const errorHandler: ErrorHandler = (err, c) => {
    if (err instanceof HTTPException) {
        return err.getResponse();
    }
    const path = new URL(c.req.url).pathname;
    logError(
        CTX.SERVER,
        `Unhandled error on ${c.req.method} ${path}`,
        err,
    );
    return c.text("Internal Server Error", 500);
};
