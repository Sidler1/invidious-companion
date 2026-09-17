/**
 * Test helpers for process-global state. Every test that touches `Deno.env`
 * or needs a config file must go through these so the previous state is
 * restored in `finally` — with DENO_JOBS=1 all test files share one process
 * and run in alphabetical order, so leaked env vars make later tests
 * order-dependent.
 */

type EnvVars = Record<string, string | undefined>;

function applyEnv(vars: EnvVars): void {
    for (const [name, value] of Object.entries(vars)) {
        if (value === undefined) {
            Deno.env.delete(name);
        } else {
            Deno.env.set(name, value);
        }
    }
}

/**
 * Set (or, with `undefined`, delete) the given env vars for the duration of
 * `fn`, then restore each of them to its previous value.
 */
export async function withEnv<T>(
    vars: EnvVars,
    fn: () => Promise<T> | T,
): Promise<T> {
    const snapshot: EnvVars = {};
    for (const name of Object.keys(vars)) {
        snapshot[name] = Deno.env.get(name);
    }
    applyEnv(vars);
    try {
        return await fn();
    } finally {
        applyEnv(snapshot);
    }
}

/**
 * Write `content` to a temporary TOML file, point `CONFIG_FILE` at it (plus
 * any extra `env` vars) while `fn` runs, then remove the file and restore
 * the env.
 */
export async function withTempConfig<T>(
    content: string,
    fn: () => Promise<T> | T,
    env: EnvVars = {},
): Promise<T> {
    const tempConfigPath = await Deno.makeTempFile({ suffix: ".toml" });
    await Deno.writeTextFile(tempConfigPath, content);
    try {
        return await withEnv({ ...env, CONFIG_FILE: tempConfigPath }, fn);
    } finally {
        await Deno.remove(tempConfigPath).catch(() => {});
    }
}
