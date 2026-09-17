import { Innertube } from "youtubei.js";
import type { TokenMinter } from "../jobs/potoken.ts";
import type { Config } from "../helpers/config.ts";
import { Metrics } from "../helpers/metrics.ts";

export type HonoVariables = {
    innertubeClient: Innertube;
    config: Config;
    tokenMinter: TokenMinter | undefined;
    metrics: Metrics | undefined;
    /** Timestamp (ms) of the last successful content-token mint; 0 = never. */
    lastMintOkMs: number | undefined;
    /**
     * Monotonic counter bumped on every session swap (regeneration or
     * per-proxy session switch). Part of the player cache key so deciphered
     * stream URLs bound to an older session's IP/pot are never served.
     */
    sessionGeneration: number;
};
