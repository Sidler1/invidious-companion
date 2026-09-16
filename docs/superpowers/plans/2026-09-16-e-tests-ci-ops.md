# Plan E — Tests, CI, Container, Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the test, CI, container and documentation gaps E1–E10 of the 2026-09-16 review so the Invidious contract helpers are unit-tested, releases only ship CI-green commits, the container starts as documented, and the README matches the code.

**Architecture:** Pure-unit tests get a shared env/config helper (`src/tests/helpers/env.ts`) so no test mutates process globals without restoring them. CI is split into static checks → network-free unit tests → the single YouTube-bound integration test (inside the proxy retry loop) → a no-push Docker build; the release workflow gates on the same static checks and compiles through one shared `scripts/compile.sh`. Container/ops files are corrected in place.

**Tech Stack:** Deno 2.9 (`deno test`, `@std/assert`, WebCrypto), Hono, GitHub Actions, Docker/Compose, bash.

**Spec:** `docs/superpowers/specs/2026-09-16-code-review-findings.md` — section E (E1–E10).

**Scope note (coordination with plans B and C):** Route-level tests for `/videoplayback`, `/download` and `/api/v1/captions` (the `app.request` tests listed under E1) are delivered by **plan B** (video proxy) and **plan C** (security/routes) alongside the behavioural fixes they test. This plan delivers the E1 crypto round-trip tests (`encryptQuery_test.ts`, `verifyRequest_test.ts`) and the shared test helpers only.

**Deviation from spec E10 (documented):** `deno task compile … --target=x` cannot work — `deno task` appends extra arguments *after* `src/main.ts`, where they become program arguments (see `--_version_date`). The single source of truth is therefore `scripts/compile.sh`, called by both `deno task compile` and the release workflow.

## Global Constraints

- Runtime: Deno 2.9.x (Docker), `deno.json` tasks are the single source of truth for permission flags. Formatter indent width is **4**.
- Every change must pass `deno task format`, `deno task check`, `deno task lint` and `deno task test` (`SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa`).
- The Invidious ↔ companion contract (routes, query names, status codes, response bodies, `check`/`enc`/`data` wire format) must not change unless the finding says so explicitly; then `../invidious/` must be updated in lockstep.
- Logging goes through `logInfo/logWarn/logError/logDebug(CTX.X, msg)` from `src/lib/helpers/log.ts`. No bare `console.*` in `src/` outside `log.ts`.
- Immutability preferred; no mutation of shared objects outside `sharedState`.
- Files ≤ 800 lines, functions ≤ 50 lines where reasonably achievable.
- Tests: pure-unit tests must not need network. Integration tests live behind `main_test.ts`. Test names describe behaviour.
- Commit format: `<type>: <description>` (feat, fix, refactor, docs, test, chore, perf, ci). Attribution trailers as configured for the session.

**Running a single test file** (used throughout; `DENO_JOBS=1` and all permission flags are inside the task):

```bash
deno task test src/tests/<file>
```

**Wire-format facts the crypto tests rely on** (verified against `../invidious/src/invidious/helpers/utils.cr:409-438`): plaintext `"<unix seconds>|<videoId>"`, key = SHA-256(secret_key) used raw as AES-256-GCM key, output = `Base64.urlsafe_encode(IV[12] || ciphertext || authTag[16])` **with** `=` padding. `@std/encoding` `decodeBase64` accepts both padded and unpadded input (verified with `deno eval`).

---

### Task 1: Shared test helpers `withEnv` / `withTempConfig`

**Files:**
- Create: `src/tests/helpers/env.ts`
- Test: `src/tests/helpers_env_test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 2–7):
  - `withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T>` — sets each var (`undefined` = delete), runs `fn`, restores the previous value of every listed var in `finally`.
  - `withTempConfig<T>(content: string, fn: () => Promise<T> | T, env?: Record<string, string | undefined>): Promise<T>` — writes `content` to a temp `.toml`, runs `fn` under `withEnv({ ...env, CONFIG_FILE: <temp path> })`, removes the file in `finally`.

- [ ] **Step 1: Write the failing test**

Create `src/tests/helpers_env_test.ts`:

```ts
import { assertEquals, assertRejects } from "./deps.ts";
import { withEnv, withTempConfig } from "./helpers/env.ts";

const VAR = "COMPANION_TEST_WITH_ENV";

Deno.test("withEnv", async (t) => {
    await t.step("sets the variable for the callback and restores the previous value", async () => {
        Deno.env.set(VAR, "before");
        await withEnv({ [VAR]: "during" }, () => {
            assertEquals(Deno.env.get(VAR), "during");
        });
        assertEquals(Deno.env.get(VAR), "before");
        Deno.env.delete(VAR);
    });

    await t.step("deletes a variable when the value is undefined and restores it", async () => {
        Deno.env.set(VAR, "before");
        await withEnv({ [VAR]: undefined }, () => {
            assertEquals(Deno.env.get(VAR), undefined);
        });
        assertEquals(Deno.env.get(VAR), "before");
        Deno.env.delete(VAR);
    });

    await t.step("removes a variable that did not exist before", async () => {
        Deno.env.delete(VAR);
        await withEnv({ [VAR]: "during" }, () => {
            assertEquals(Deno.env.get(VAR), "during");
        });
        assertEquals(Deno.env.get(VAR), undefined);
    });

    await t.step("restores the variable when the callback throws", async () => {
        Deno.env.set(VAR, "before");
        await assertRejects(
            () =>
                withEnv({ [VAR]: "during" }, () => {
                    throw new Error("boom");
                }),
            Error,
            "boom",
        );
        assertEquals(Deno.env.get(VAR), "before");
        Deno.env.delete(VAR);
    });

    await t.step("returns the callback's value", async () => {
        const value = await withEnv({ [VAR]: "x" }, () => 42);
        assertEquals(value, 42);
    });
});

Deno.test("withTempConfig", async (t) => {
    await t.step("points CONFIG_FILE at a file with the given content and removes it afterwards", async () => {
        let seenPath = "";
        await withTempConfig("[server]\nport = 1234\n", async () => {
            seenPath = Deno.env.get("CONFIG_FILE") ?? "";
            assertEquals(
                await Deno.readTextFile(seenPath),
                "[server]\nport = 1234\n",
            );
        });
        assertEquals(Deno.env.get("CONFIG_FILE"), undefined);
        await assertRejects(() => Deno.stat(seenPath), Deno.errors.NotFound);
    });

    await t.step("applies extra env vars for the duration of the callback", async () => {
        Deno.env.delete(VAR);
        await withTempConfig("", () => {
            assertEquals(Deno.env.get(VAR), "extra");
        }, { [VAR]: "extra" });
        assertEquals(Deno.env.get(VAR), undefined);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno task test src/tests/helpers_env_test.ts`
Expected: FAIL — `error: Module not found "file:///.../src/tests/helpers/env.ts"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/tests/helpers/env.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno task test src/tests/helpers_env_test.ts`
Expected: `ok | 2 passed (7 steps) | 0 failed`.

- [ ] **Step 5: Format, lint, check**

Run: `deno fmt src/tests/helpers/env.ts src/tests/helpers_env_test.ts && deno task lint && deno task check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/tests/helpers/env.ts src/tests/helpers_env_test.ts
git commit -m "test: add withEnv/withTempConfig helpers that restore process state"
```

---

### Task 2: Migrate the config tests to the shared helpers

**Files:**
- Modify: `src/tests/captions_config_test.ts:1-24`
- Modify: `src/tests/config_additions_test.ts:1-24, 103-127, 159-178`
- Modify: `src/tests/config_negative_test.ts:1-31`
- Modify: `src/tests/secret_key_validation_test.ts` (whole file)

**Interfaces:**
- Consumes: `withEnv`, `withTempConfig` from Task 1.
- Produces: nothing new; behaviour of the tests is unchanged, only their state handling.

- [ ] **Step 1: Replace the local helper in `captions_config_test.ts`**

Replace lines 1–24 (the imports and the local `withTempConfig`) with:

```ts
import { assertEquals } from "./deps.ts";
import { parseConfig } from "../lib/helpers/config.ts";
import { withTempConfig } from "./helpers/env.ts";
```

The rest of the file is unchanged.

- [ ] **Step 2: Replace the local helper in `config_additions_test.ts` and fix the two leaking steps**

Replace lines 1–24 with:

```ts
import { assert, assertEquals } from "./deps.ts";
import { parseConfig } from "../lib/helpers/config.ts";
import { withEnv, withTempConfig } from "./helpers/env.ts";
```

Replace the step `"player_fallback_clients parses a comma-separated env var"` (lines 103–127) with:

```ts
    await t.step(
        "player_fallback_clients parses a comma-separated env var",
        async () => {
            await withTempConfig(
                `[server]\nsecret_key = "1234567890abcdef"\n`,
                async () => {
                    const config = await parseConfig();
                    assertEquals(
                        config.jobs.youtube_session.player_fallback_clients,
                        ["TV_SIMPLY", "ANDROID_VR"],
                    );
                },
                {
                    JOBS_YOUTUBE_SESSION_PLAYER_FALLBACK_CLIENTS:
                        "TV_SIMPLY, ANDROID_VR",
                },
            );
        },
    );
```

Replace the step `"rejects missing SERVER_SECRET_KEY"` (lines 159–178) with:

```ts
    await t.step("rejects missing SERVER_SECRET_KEY", async () => {
        await withTempConfig("", async () => {
            await withEnv({ SERVER_SECRET_KEY: undefined }, async () => {
                try {
                    await parseConfig();
                    assert(
                        false,
                        "Config parsing should fail when SERVER_SECRET_KEY is missing",
                    );
                } catch (error) {
                    assert(
                        error instanceof Error &&
                            error.message.includes("SERVER_SECRET_KEY"),
                        `Should get validation error for missing secret key, got: ${
                            error instanceof Error
                                ? error.message
                                : String(error)
                        }`,
                    );
                }
            });
        });
    });
```

- [ ] **Step 3: Replace the local helper in `config_negative_test.ts`**

Replace lines 1–31 with:

```ts
import { assert } from "./deps.ts";
import { parseConfig } from "../lib/helpers/config.ts";
import { withTempConfig as withTempConfigBase } from "./helpers/env.ts";

// Every negative case here supplies its own [server].secret_key in the TOML,
// but the env fallback must also be valid so a missing TOML key never masks
// the assertion under test.
function withTempConfig<T>(
    content: string,
    fn: () => Promise<T>,
): Promise<T> {
    return withTempConfigBase(content, fn, {
        SERVER_SECRET_KEY: "aaaaaaaaaaaaaaaa",
    });
}
```

The rest of the file (`expectConfigError` and the test body) is unchanged.

- [ ] **Step 4: Rewrite `secret_key_validation_test.ts` so every `parseConfig` call runs under `withEnv`**

Replace the whole file with:

```ts
/**
 * Test for secret key validation in the actual Invidious companion configuration
 * This test verifies that SERVER_SECRET_KEY validation properly rejects special characters
 * when the actual config is parsed
 */
import { assert, assertEquals } from "./deps.ts";
import { parseConfig } from "../lib/helpers/config.ts";
import { withEnv, withTempConfig } from "./helpers/env.ts";

// An empty temp config guarantees the env var is the only source of the key,
// even on a machine that has a local config/config.toml.
function parseWithSecretKey(key: string | undefined) {
    return withTempConfig(
        "",
        () => parseConfig(),
        { SERVER_SECRET_KEY: key },
    );
}

async function expectSecretKeyError(
    key: string | undefined,
    matchers: string[],
    description: string,
): Promise<void> {
    try {
        await parseWithSecretKey(key);
        assert(false, `${description}: config parsing should have failed`);
    } catch (error) {
        const errorStr = error instanceof Error
            ? error.toString()
            : String(error);
        assert(
            errorStr.includes("Failed to parse configuration"),
            `${description}: should get config parsing error, got: ${errorStr}`,
        );
        assert(
            matchers.some((m) => errorStr.includes(m)),
            `${description}: expected one of ${
                JSON.stringify(matchers)
            } in error, got: ${errorStr}`,
        );
    }
}

const LENGTH_MATCHERS = [
    "exactly 16 character",
    "String must contain exactly 16 character",
];
const CHARACTER_MATCHERS = [
    "SERVER_SECRET_KEY contains invalid characters",
    "alphanumeric characters",
];

Deno.test("Secret key validation in Invidious companion config", async (t) => {
    await t.step("accepts valid alphanumeric keys", async () => {
        const validKeys = [
            "aaaaaaaaaaaaaaaa", // all lowercase
            "AAAAAAAAAAAAAAAA", // all uppercase
            "1234567890123456", // all numbers
            "Aa1Bb2Cc3Dd4Ee5F", // mixed case
            "ABC123DEF456789A", // mixed letters and numbers
        ];

        for (const key of validKeys) {
            const config = await parseWithSecretKey(key);
            assertEquals(
                config.server.secret_key,
                key,
                `Key "${key}" should be accepted and stored correctly`,
            );
        }
    });

    await t.step("rejects keys with special characters", async () => {
        const invalidKeys = [
            "my#key!123456789", // Contains # and !
            "test@key12345678", // Contains @ (fixed length)
            "key-with-dashes1", // Contains -
            "key_with_under_s", // Contains _
            "key with spaces1", // Contains spaces (fixed length to 16)
            "key$with$dollar$", // Contains $
            "key+with+plus+12", // Contains +
            "key=with=equals=", // Contains =
            "key(with)parens1", // Contains ()
            "key[with]bracket", // Contains []
        ];

        for (const key of invalidKeys) {
            await expectSecretKeyError(
                key,
                CHARACTER_MATCHERS,
                `Key "${key}"`,
            );
        }
    });

    await t.step("rejects keys with wrong length", async () => {
        const wrongLengthKeys = [
            "short", // Too short
            "thiskeyistoolongtobevalid", // Too long
            "", // Empty
            "a", // Single character
            "exactly15chars", // 15 chars
            "exactly17charss", // 17 chars
        ];

        for (const key of wrongLengthKeys) {
            await expectSecretKeyError(
                key,
                LENGTH_MATCHERS,
                `Key "${key}" (length ${key.length})`,
            );
        }
    });

    await t.step(
        "reports the length error first when both length and characters are invalid",
        async () => {
            await expectSecretKeyError("bad#", LENGTH_MATCHERS, 'Key "bad#"');
        },
    );

    await t.step("fails when SERVER_SECRET_KEY is missing", async () => {
        await expectSecretKeyError(
            undefined,
            LENGTH_MATCHERS,
            "missing SERVER_SECRET_KEY",
        );
    });

    await t.step("does not leak SERVER_SECRET_KEY into the environment", async () => {
        await withEnv({ SERVER_SECRET_KEY: undefined }, async () => {
            await parseWithSecretKey("aaaaaaaaaaaaaaaa");
            assertEquals(Deno.env.get("SERVER_SECRET_KEY"), undefined);
        });
    });
});
```

- [ ] **Step 5: Run the four files**

Run: `deno task test src/tests/captions_config_test.ts src/tests/config_additions_test.ts src/tests/config_negative_test.ts src/tests/secret_key_validation_test.ts`
Expected: all passed, 0 failed (`captions config` 2 steps, `Config validation additions` 7 steps, `Config negative paths` 13 steps, `Secret key validation…` 6 steps).

- [ ] **Step 6: Format, lint, check, then commit**

Run: `deno fmt src/tests && deno task lint && deno task check`
Expected: no errors.

```bash
git add src/tests/captions_config_test.ts src/tests/config_additions_test.ts src/tests/config_negative_test.ts src/tests/secret_key_validation_test.ts
git commit -m "test: run config tests through shared env helpers so no env var leaks"
```

---

### Task 3: Migrate `proxy_pool_test.ts` and `dynamicImportValidation_test.ts` to `withEnv`, drop tautological config cases

**Files:**
- Modify: `src/tests/proxy_pool_test.ts:1-64, 110-147, 218-262, 335-379, 404-443`
- Modify: `src/tests/dynamicImportValidation_test.ts` (whole file)

**Interfaces:**
- Consumes: `withEnv`, `withTempConfig` from Task 1.
- Produces: `poolTestConfig(proxies: string[], options?)` **local to the test file** (not exported) — reused by Task 6's new file via its own copy (each test file stays self-contained by design).

- [ ] **Step 1: Delete the two tautological tests and add a config builder in `proxy_pool_test.ts`**

Replace lines 1–64 (imports, the two `proxy_pool config parsing` tests and the `basic creation` test) with:

```ts
import { assertEquals, assertExists, assertRejects } from "./deps.ts";
import { withTempConfig } from "./helpers/env.ts";
import type { Config } from "../lib/helpers/config.ts";

// Builds a Config with the proxy pool enabled, from an otherwise-default
// config. An empty temp config file makes the result independent of any
// local config/config.toml.
async function poolTestConfig(
    proxies: string[],
    options: { healthCheck?: boolean; switchProxyOnLimit?: boolean } = {},
): Promise<Config> {
    const { parseConfig } = await import("../lib/helpers/config.ts");
    const config = await withTempConfig(
        `[server]\nsecret_key = "aaaaaaaaaaaaaaaa"\n`,
        () => parseConfig(),
    );
    return {
        ...config,
        networking: {
            ...config.networking,
            proxy_pool: {
                enabled: true,
                rotation: "round-robin" as const,
                health_check: options.healthCheck ?? true,
                switch_proxy_on_limit: options.switchProxyOnLimit ?? false,
                proxies,
            },
        },
    };
}

Deno.test({
    name: "getFetchClient with proxy_pool - basic creation (no real network)",
    fn: async () => {
        const { getFetchClient } = await import(
            "../lib/helpers/getFetchClient.ts"
        );
        const testConfig = await poolTestConfig([
            "http://user:pass@127.0.0.1:1",
        ]);

        const fetchClient = getFetchClient(testConfig);
        assertExists(fetchClient);
    },
    sanitizeResources: false, // HttpClients are created internally and not closed in this unit test
});
```

- [ ] **Step 2: Replace the inline config construction in the four remaining tests**

In each of the tests `keeps using one healthy proxy across calls`, `fails over to another proxy within the same request when a block is detected`, `cooldown expiry triggers probe and failed proxy is blacklisted again`, and `rotateSessionEgressProxy - advances the pinned egress proxy to a different one`, delete these lines inside the `try` block:

```ts
            const { parseConfig } = await import("../lib/helpers/config.ts");
            Deno.env.set("SERVER_SECRET_KEY", "aaaaaaaaaaaaaaaa");

            const config = await parseConfig();

            const testConfig = {
                ...config,
                networking: {
                    ...config.networking,
                    proxy_pool: {
                        enabled: true,
                        rotation: "round-robin" as const,
                        health_check: true,
                        switch_proxy_on_limit: false,
                        proxies: [ ... ],
                    },
                },
            };
```

and replace them with a single call carrying the same proxy list:

- `keeps using one healthy proxy across calls`:
  ```ts
            const testConfig = await poolTestConfig([
                "http://u:p@proxy1:8080",
                "http://u:p@proxy2:8080",
            ]);
  ```
- `fails over to another proxy …`:
  ```ts
            const testConfig = await poolTestConfig([
                "http://u:p@proxy1:8080",
                "http://u:p@proxy2:8080",
            ]);
  ```
- `cooldown expiry triggers probe …`:
  ```ts
            const testConfig = await poolTestConfig(["http://u:p@proxy1:8080"]);
  ```
- `rotateSessionEgressProxy …` (keep the existing `const proxies = [...]` declaration above it):
  ```ts
            const testConfig = await poolTestConfig(proxies);
  ```

The `Deno.env.set("SERVER_SECRET_KEY", …)` lines at 115, 223, 340 and 408 disappear with this change; confirm with `grep -n 'Deno.env' src/tests/proxy_pool_test.ts` → no output.

- [ ] **Step 3: Rewrite `dynamicImportValidation_test.ts` with `withEnv` per step**

Replace the whole file with:

```ts
import { assert, assertEquals, assertThrows } from "./deps.ts";
import { resolveAndValidateFetchClientLocation } from "../lib/helpers/dynamicImportValidation.ts";
import { withEnv } from "./helpers/env.ts";

// Both env vars are read at call time, so every step scopes them with withEnv
// and gets a clean, restored environment even when an assertion throws.
function withLocation<T>(
    location: string | undefined,
    fn: () => T,
    compiled = false,
): Promise<T> {
    return withEnv({
        GET_FETCH_CLIENT_LOCATION: location,
        DENO_COMPILED: compiled ? "true" : undefined,
    }, fn);
}

Deno.test("Dynamic import validation", async (t) => {
    await t.step("returns default when env var is not set", async () => {
        await withLocation(undefined, () => {
            assertEquals(
                resolveAndValidateFetchClientLocation(),
                "getFetchClient",
            );
        });
    });

    await t.step("accepts allowed internal module paths", async () => {
        const allowed = [
            "getFetchClient",
            "./getFetchClient",
            "../lib/helpers/getFetchClient",
        ];
        for (const path of allowed) {
            await withLocation(path, () => {
                assertEquals(resolveAndValidateFetchClientLocation(), path);
            });
        }
    });

    await t.step("rejects remote URLs (http)", async () => {
        await withLocation("https://evil.com/malicious.ts", () => {
            assertThrows(
                () => resolveAndValidateFetchClientLocation(),
                Error,
                "remote module URLs are not allowed",
            );
        });
    });

    await t.step("rejects remote URLs (npm)", async () => {
        await withLocation("npm:malicious-package", () => {
            assertThrows(
                () => resolveAndValidateFetchClientLocation(),
                Error,
                "remote module URLs are not allowed",
            );
        });
    });

    await t.step("rejects suspicious path traversal", async () => {
        await withLocation("../../etc/passwd", () => {
            assertThrows(
                () => resolveAndValidateFetchClientLocation(),
                Error,
                "suspicious path traversal",
            );
        });
    });

    await t.step("warns but allows non-standard local paths", async () => {
        await withLocation("./myCustomModule", () => {
            assertEquals(
                resolveAndValidateFetchClientLocation(),
                "./myCustomModule",
            );
        });
    });

    await t.step("accepts compiled path with allowed basename", async () => {
        await withLocation("getFetchClient", () => {
            // In compiled mode the mainModule path is prepended; the basename
            // is still "getFetchClient".
            assert(
                resolveAndValidateFetchClientLocation().endsWith(
                    "getFetchClient",
                ),
            );
        }, true);
    });
});
```

(Plan C adds the two allowlist-bypass cases — `https://x/getFetchClient.ts` and `../../x/getFetchClient.ts` — to this file when it fixes C1; they use the same `withLocation` helper.)

- [ ] **Step 4: Run both files**

Run: `deno task test src/tests/proxy_pool_test.ts src/tests/dynamicImportValidation_test.ts`
Expected: `ok | 6 passed (7 steps) | 0 failed` (5 proxy-pool tests + 1 dynamic-import test with 7 steps).

- [ ] **Step 5: Format, lint, check, commit**

Run: `deno fmt src/tests && deno task lint && deno task check`
Expected: no errors.

```bash
git add src/tests/proxy_pool_test.ts src/tests/dynamicImportValidation_test.ts
git commit -m "test: scope env mutation in proxy-pool and dynamic-import tests; drop tautological config cases"
```

---

### Task 4: `encryptQuery` / `decryptQuery` round-trip tests (E1)

**Files:**
- Test: `src/tests/encryptQuery_test.ts`

**Interfaces:**
- Consumes: `encryptQuery(queryParams: string, config: Config): Promise<string>` and `decryptQuery(queryParams: string, config: Config): Promise<string>` from `src/lib/helpers/encryptQuery.ts` (decrypt returns `""` on any failure — that fail-closed contract is what the tampering cases assert; plan C's C6 changes only `encryptQuery` to throw and does not affect these assertions).
- Produces: nothing.

- [ ] **Step 1: Write the test**

Create `src/tests/encryptQuery_test.ts`:

```ts
import { assert, assertEquals, assertNotEquals } from "./deps.ts";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { decryptQuery, encryptQuery } from "../lib/helpers/encryptQuery.ts";
import type { Config } from "../lib/helpers/config.ts";

const config = {
    server: { secret_key: "aaaaaaaaaaaaaaaa" },
} as unknown as Config;
const otherKeyConfig = {
    server: { secret_key: "bbbbbbbbbbbbbbbb" },
} as unknown as Config;

const IV_BYTES = 12;
const TAG_BYTES = 16;

Deno.test("encryptQuery/decryptQuery", async (t) => {
    await t.step("round-trips a JSON query string", async () => {
        const plaintext = JSON.stringify({ pot: "abc123", ip: "203.0.113.7" });
        const token = await encryptQuery(plaintext, config);
        assertNotEquals(token, "");
        assertEquals(await decryptQuery(token, config), plaintext);
    });

    await t.step("emits base64(IV[12] || ciphertext || tag[16])", async () => {
        const plaintext = "hello";
        const token = await encryptQuery(plaintext, config);
        const bytes = decodeBase64(token);
        assertEquals(bytes.length, IV_BYTES + plaintext.length + TAG_BYTES);
    });

    await t.step("uses a fresh IV so equal plaintexts encrypt differently", async () => {
        const first = await encryptQuery("same", config);
        const second = await encryptQuery("same", config);
        assertNotEquals(first, second);
        assertNotEquals(
            encodeBase64(decodeBase64(first).slice(0, IV_BYTES)),
            encodeBase64(decodeBase64(second).slice(0, IV_BYTES)),
        );
    });

    await t.step("fails closed when the ciphertext is tampered with", async () => {
        const token = await encryptQuery("payload", config);
        const bytes = decodeBase64(token);
        bytes[IV_BYTES] ^= 0xff; // first ciphertext byte
        assertEquals(await decryptQuery(encodeBase64(bytes), config), "");
    });

    await t.step("fails closed when the auth tag is tampered with", async () => {
        const token = await encryptQuery("payload", config);
        const bytes = decodeBase64(token);
        bytes[bytes.length - 1] ^= 0x01; // last tag byte
        assertEquals(await decryptQuery(encodeBase64(bytes), config), "");
    });

    await t.step("fails closed with a different secret key", async () => {
        const token = await encryptQuery("payload", config);
        assertEquals(await decryptQuery(token, otherKeyConfig), "");
    });

    await t.step("fails closed on input that is not base64", async () => {
        assertEquals(await decryptQuery("not base64 !!!", config), "");
    });

    await t.step("fails closed on input shorter than an IV", async () => {
        assertEquals(await decryptQuery(encodeBase64(new Uint8Array(5)), config), "");
    });

    await t.step("round-trips an empty string", async () => {
        const token = await encryptQuery("", config);
        assert(token.length > 0);
        assertEquals(await decryptQuery(token, config), "");
    });
});
```

- [ ] **Step 2: Run the test**

Run: `deno task test src/tests/encryptQuery_test.ts`
Expected: `ok | 1 passed (9 steps) | 0 failed`. (These characterise existing behaviour, so they pass immediately; the value is regression protection for the wire format. The `[ERROR] [ENCRYPT] Failed to decrypt query parameters` log lines from the fail-closed steps are expected output.)

- [ ] **Step 3: Format, lint, check, commit**

Run: `deno fmt src/tests/encryptQuery_test.ts && deno task lint && deno task check`

```bash
git add src/tests/encryptQuery_test.ts
git commit -m "test: cover AES-GCM query encryption round trip and fail-closed decryption"
```

---

### Task 5: `verifyRequest` contract tests against an independent Invidious-style signer (E1)

> **Overlap with plan C (Task 4):** plan C also creates `src/tests/verifyRequest_test.ts` together with an independent signer in `src/tests/helpers/check.ts` (`makeCheck`). If plan C has already merged, do **not** create the file: open the existing one, reuse `makeCheck` instead of the `signCheck` below, and add only the cases that are missing there (padded vs. unpadded base64url, standard-alphabet base64, wrong key). If plan C has not merged yet, execute this task as written; plan C's Task 4 then has to merge its cases into this file.

**Files:**
- Test: `src/tests/verifyRequest_test.ts`

**Interfaces:**
- Consumes: `verifyRequest(stringToCheck: string, videoId: string, config: Config): Promise<boolean>` from `src/lib/helpers/verifyRequest.ts`.
- Produces: nothing. (`signCheck` below is a deliberate re-implementation of `invidious_companion_encrypt` from `../invidious/src/invidious/helpers/utils.cr` — it must **not** import `encryptQuery.ts`, otherwise a shared bug would pass.)

- [ ] **Step 1: Write the test**

Create `src/tests/verifyRequest_test.ts`:

```ts
import { assertEquals } from "./deps.ts";
import { encodeBase64 } from "@std/encoding/base64";
import { encodeBase64Url } from "jsr:@std/encoding@1.0.11/base64url";
import { verifyRequest } from "../lib/helpers/verifyRequest.ts";
import type { Config } from "../lib/helpers/config.ts";

const SECRET = "aaaaaaaaaaaaaaaa";
const config = { server: { secret_key: SECRET } } as unknown as Config;
const VIDEO_ID = "jNQXAC9IVRw";

const SIX_HOURS = 6 * 60 * 60;
const FIVE_MINUTES = 5 * 60;

function nowSeconds(): number {
    return Math.round(Date.now() / 1000);
}

/**
 * Mirrors Invidious' `invidious_companion_encrypt` byte for byte:
 * key = SHA-256(secret), AES-256-GCM with a 96-bit IV, output
 * IV || ciphertext || tag, base64url with `=` padding (Crystal's
 * `Base64.urlsafe_encode` default).
 */
async function signRaw(
    plaintext: string,
    secret: string,
    encoding: "base64url-padded" | "base64url" | "base64" = "base64url-padded",
): Promise<string> {
    const keyMaterial = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(secret),
    );
    const key = await crypto.subtle.importKey(
        "raw",
        keyMaterial,
        { name: "AES-GCM" },
        false,
        ["encrypt"],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertextWithTag = new Uint8Array(
        await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            key,
            new TextEncoder().encode(plaintext),
        ),
    );
    const combined = new Uint8Array(iv.length + ciphertextWithTag.length);
    combined.set(iv, 0);
    combined.set(ciphertextWithTag, iv.length);

    if (encoding === "base64") return encodeBase64(combined);
    const unpadded = encodeBase64Url(combined);
    if (encoding === "base64url") return unpadded;
    return unpadded + "=".repeat((4 - (unpadded.length % 4)) % 4);
}

function signCheck(
    timestamp: number,
    videoId: string,
    secret = SECRET,
    encoding?: "base64url-padded" | "base64url" | "base64",
): Promise<string> {
    return signRaw(`${timestamp}|${videoId}`, secret, encoding);
}

Deno.test("verifyRequest", async (t) => {
    await t.step("accepts a freshly signed check for the same videoId", async () => {
        const check = await signCheck(nowSeconds(), VIDEO_ID);
        assertEquals(await verifyRequest(check, VIDEO_ID, config), true);
    });

    await t.step("accepts padded base64url (Invidious default encoding)", async () => {
        const check = await signCheck(nowSeconds(), VIDEO_ID, SECRET, "base64url-padded");
        assertEquals(check.includes("=") || check.length % 4 === 0, true);
        assertEquals(await verifyRequest(check, VIDEO_ID, config), true);
    });

    await t.step("accepts unpadded base64url", async () => {
        const check = await signCheck(nowSeconds(), VIDEO_ID, SECRET, "base64url");
        assertEquals(await verifyRequest(check, VIDEO_ID, config), true);
    });

    await t.step("accepts standard base64", async () => {
        const check = await signCheck(nowSeconds(), VIDEO_ID, SECRET, "base64");
        assertEquals(await verifyRequest(check, VIDEO_ID, config), true);
    });

    await t.step("rejects a check signed for another videoId", async () => {
        const check = await signCheck(nowSeconds(), "dQw4w9WgXcQ");
        assertEquals(await verifyRequest(check, VIDEO_ID, config), false);
    });

    await t.step("rejects a check older than 6 hours", async () => {
        const check = await signCheck(nowSeconds() - SIX_HOURS - 60, VIDEO_ID);
        assertEquals(await verifyRequest(check, VIDEO_ID, config), false);
    });

    await t.step("accepts a check just inside the 6 hour window", async () => {
        const check = await signCheck(nowSeconds() - SIX_HOURS + 60, VIDEO_ID);
        assertEquals(await verifyRequest(check, VIDEO_ID, config), true);
    });

    await t.step("rejects a check more than 5 minutes in the future", async () => {
        const check = await signCheck(nowSeconds() + FIVE_MINUTES + 60, VIDEO_ID);
        assertEquals(await verifyRequest(check, VIDEO_ID, config), false);
    });

    await t.step("accepts a check within the 5 minute clock-skew tolerance", async () => {
        const check = await signCheck(nowSeconds() + FIVE_MINUTES - 60, VIDEO_ID);
        assertEquals(await verifyRequest(check, VIDEO_ID, config), true);
    });

    await t.step("rejects a tampered auth tag", async () => {
        const check = await signCheck(nowSeconds(), VIDEO_ID, SECRET, "base64");
        const bytes = Uint8Array.from(atob(check), (ch) => ch.charCodeAt(0));
        bytes[bytes.length - 1] ^= 0x01;
        assertEquals(
            await verifyRequest(encodeBase64(bytes), VIDEO_ID, config),
            false,
        );
    });

    await t.step("rejects a check signed with a different secret", async () => {
        const check = await signCheck(nowSeconds(), VIDEO_ID, "bbbbbbbbbbbbbbbb");
        assertEquals(await verifyRequest(check, VIDEO_ID, config), false);
    });

    await t.step("rejects a non-numeric timestamp", async () => {
        const check = await signRaw(`not-a-number|${VIDEO_ID}`, SECRET);
        assertEquals(await verifyRequest(check, VIDEO_ID, config), false);
    });

    await t.step("rejects a plaintext without the separator", async () => {
        const check = await signRaw(`${nowSeconds()}${VIDEO_ID}`, SECRET);
        assertEquals(await verifyRequest(check, VIDEO_ID, config), false);
    });

    await t.step("rejects an empty check", async () => {
        assertEquals(await verifyRequest("", VIDEO_ID, config), false);
    });

    await t.step("rejects garbage input", async () => {
        assertEquals(await verifyRequest("%%%not-base64%%%", VIDEO_ID, config), false);
    });
});
```

- [ ] **Step 2: Run the test**

Run: `deno task test src/tests/verifyRequest_test.ts`
Expected: `ok | 1 passed (15 steps) | 0 failed`. The first run also downloads `jsr:@std/encoding@1.0.11/base64url` (same version as the import-mapped `base64`; it is already in `deno.lock`'s `@std/encoding` entry, so the lockfile does not change — confirm with `git status --short deno.lock` → empty).

- [ ] **Step 3: Format, lint, check, commit**

Run: `deno fmt src/tests/verifyRequest_test.ts && deno task lint && deno task check`

```bash
git add src/tests/verifyRequest_test.ts
git commit -m "test: verify the check-token contract against an independent Invidious-style signer"
```

---

### Task 6: Replace the tautological proxy-health tests with real blacklist tests (E3)

**Files:**
- Modify: `src/tests/proxy_pool_health_test.ts` (whole file)

**Interfaces:**
- Consumes: `getFetchClient(config: Config, metrics?: Metrics): FetchFn` from `src/lib/helpers/getFetchClient.ts`; `withTempConfig` from Task 1.
- Behaviour under test (from `getFetchClient.ts:158-159, 287-306, 313-349, 379-474`): `FAILURE_THRESHOLD = 3`, `BLACKLIST_MS = 3_600_000`; a thrown fetch or a detected block calls `markProxyFailure`; with `health_check: false` failures are never counted; when no healthy proxy is left the fetch rejects with `"… No healthy proxy available."`. `networking.fetch.retry.enabled` defaults to `false`, so each `fetchClient()` call performs exactly one upstream attempt per proxy.

- [ ] **Step 1: Replace the file**

Replace the whole of `src/tests/proxy_pool_health_test.ts` with:

```ts
import { assertEquals, assertRejects } from "./deps.ts";
import { withTempConfig } from "./helpers/env.ts";
import type { Config } from "../lib/helpers/config.ts";

const PROXY = "http://u:p@proxy1:8080";

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

const okResponse = () => jsonResponse({ playabilityStatus: { status: "OK" } });
const blockedResponse = () =>
    jsonResponse({
        playabilityStatus: {
            status: "LOGIN_REQUIRED",
            reason: "Sign in to confirm you're not a bot",
            subreason: "This helps protect our community.",
        },
    });

async function poolTestConfig(healthCheck: boolean): Promise<Config> {
    const { parseConfig } = await import("../lib/helpers/config.ts");
    const config = await withTempConfig(
        `[server]\nsecret_key = "aaaaaaaaaaaaaaaa"\n`,
        () => parseConfig(),
    );
    return {
        ...config,
        networking: {
            ...config.networking,
            proxy_pool: {
                enabled: true,
                rotation: "round-robin" as const,
                health_check: healthCheck,
                switch_proxy_on_limit: false,
                proxies: [PROXY],
            },
        },
    };
}

/**
 * Stubs `fetch` and `Deno.createHttpClient`. Health probes (generate_204)
 * always succeed; every other request is answered by `onRequest`, which
 * receives the 1-based index of that request. Returns how many non-probe
 * requests reached the "network".
 */
async function withMockedNetwork(
    onRequest: (requestIndex: number) => Promise<Response>,
    fn: () => Promise<void>,
): Promise<number> {
    const originalFetch = globalThis.fetch;
    const originalCreateHttpClient = Deno.createHttpClient;
    let requestCount = 0;

    Deno.createHttpClient = (() =>
        ({} as unknown as Deno.HttpClient)) as typeof Deno.createHttpClient;
    globalThis.fetch = ((input: RequestInfo | URL) => {
        if (String(input).includes("generate_204")) {
            return Promise.resolve(jsonResponse({ status: "OK" }));
        }
        requestCount += 1;
        return onRequest(requestCount);
    }) as typeof fetch;

    try {
        await fn();
    } finally {
        globalThis.fetch = originalFetch;
        Deno.createHttpClient = originalCreateHttpClient;
    }
    return requestCount;
}

const connectionReset = () => Promise.reject(new Error("connection reset"));

Deno.test("proxy pool health - does not blacklist a proxy after two failures", async () => {
    const requests = await withMockedNetwork(
        (i) => (i <= 2 ? connectionReset() : Promise.resolve(okResponse())),
        async () => {
            const { getFetchClient } = await import(
                "../lib/helpers/getFetchClient.ts"
            );
            const fetchClient = getFetchClient(await poolTestConfig(true));

            await assertRejects(() => fetchClient("http://example.com/1"), Error, "connection reset");
            await assertRejects(() => fetchClient("http://example.com/2"), Error, "connection reset");

            const recovered = await fetchClient("http://example.com/3");
            assertEquals(recovered.status, 200);
            await recovered.body?.cancel();
        },
    );
    assertEquals(requests, 3);
});

Deno.test("proxy pool health - blacklists a proxy after three consecutive failures and rejects once the pool is exhausted", async () => {
    const requests = await withMockedNetwork(
        () => connectionReset(),
        async () => {
            const { getFetchClient } = await import(
                "../lib/helpers/getFetchClient.ts"
            );
            const fetchClient = getFetchClient(await poolTestConfig(true));

            for (let i = 1; i <= 3; i++) {
                await assertRejects(() => fetchClient(`http://example.com/${i}`), Error, "connection reset");
            }

            // The only proxy is now blacklisted for 1h: no upstream attempt is made.
            await assertRejects(() => fetchClient("http://example.com/4"), Error, "No healthy proxy available");
        },
    );
    assertEquals(requests, 3);
});

Deno.test("proxy pool health - a detected YouTube block counts as a failure toward the blacklist", async () => {
    const requests = await withMockedNetwork(
        () => Promise.resolve(blockedResponse()),
        async () => {
            const { getFetchClient } = await import(
                "../lib/helpers/getFetchClient.ts"
            );
            const fetchClient = getFetchClient(await poolTestConfig(true));

            // With a single proxy there is nowhere to fail over to, so the
            // blocked response itself is returned — but each one is counted.
            for (let i = 1; i <= 3; i++) {
                const res = await fetchClient(`http://example.com/${i}`);
                assertEquals(res.status, 200);
                await res.body?.cancel();
            }

            await assertRejects(() => fetchClient("http://example.com/4"), Error, "No healthy proxy available");
        },
    );
    assertEquals(requests, 3);
});

Deno.test("proxy pool health - never blacklists when health_check is disabled", async () => {
    const requests = await withMockedNetwork(
        () => connectionReset(),
        async () => {
            const { getFetchClient } = await import(
                "../lib/helpers/getFetchClient.ts"
            );
            const fetchClient = getFetchClient(await poolTestConfig(false));

            for (let i = 1; i <= 5; i++) {
                // Still "connection reset", never "No healthy proxy available".
                await assertRejects(() => fetchClient(`http://example.com/${i}`), Error, "connection reset");
            }
        },
    );
    assertEquals(requests, 5);
});
```

- [ ] **Step 2: Run the test**

Run: `deno task test src/tests/proxy_pool_health_test.ts`
Expected: `ok | 4 passed | 0 failed`. Expected log noise: `[WARN] [PROXY] Blacklisted for 1h: http://proxy1:8080 (3 failures)` in tests 2 and 3, and `[WARN] [PROXY] Detected YouTube anti-bot response …` in test 3.

If test 2 or 3 fails with `"connection reset"` on the fourth call instead of `"No healthy proxy available"`, the blacklist threshold in `getFetchClient.ts` has changed — that is exactly the regression these tests exist to catch; do not loosen the test.

- [ ] **Step 3: Format, lint, check, commit**

Run: `deno fmt src/tests/proxy_pool_health_test.ts && deno task lint && deno task check`

```bash
git add src/tests/proxy_pool_health_test.ts
git commit -m "test: replace tautological proxy-health cases with real blacklist threshold tests"
```

---

### Task 7: Real `cleanupWorkers` test with a fake Worker (E3)

> **Overlap with plan A (Task 1):** plan A replaces `src/tests/shutdown_test.ts` with a registry-based test (`src/lib/session/workerRegistry.ts`, `src/tests/helpers/fakeWorker.ts`). **Skip this task entirely if plan A has merged** — its test already covers E3 for `cleanupWorkers`. Execute it only when plan E runs before plan A.

**Files:**
- Modify: `src/tests/shutdown_test.ts` (whole file)

**Interfaces:**
- Consumes: `poTokenGenerate(config: Config, metrics: Metrics | undefined)` and `cleanupWorkers(): void` from `src/lib/jobs/potoken.ts`. `poTokenGenerate` constructs `new Worker(new URL("./worker.ts", import.meta.url).href, { type: "module", name: "PO Token Generator" })` and pushes it into the module-private `workers` array synchronously (`potoken.ts:101-108`); the returned promise only settles when the worker posts a message, which the fake never does. `cleanupWorkers` shifts every entry and calls `terminate()` (`potoken.ts:343-361`).
- Produces: nothing. No source change is needed — `globalThis.Worker` is stubbed. (If plan A changes how workers are registered, this test still holds as long as `new Worker(...)` remains the registration point.)

- [ ] **Step 1: Replace the file**

Replace the whole of `src/tests/shutdown_test.ts` with:

```ts
import { assertEquals } from "./deps.ts";
import { cleanupWorkers, poTokenGenerate } from "../lib/jobs/potoken.ts";
import type { Config } from "../lib/helpers/config.ts";

// Minimal stand-in for a Web Worker: records termination, never posts a
// message, so poTokenGenerate's promise stays pending and no real BotGuard
// worker is spawned.
class FakeWorker {
    terminated = false;
    constructor(_url: string | URL, _options?: WorkerOptions) {}
    addEventListener(_type: string, _listener: EventListener): void {}
    removeEventListener(_type: string, _listener: EventListener): void {}
    postMessage(_message: unknown): void {}
    terminate(): void {
        this.terminated = true;
    }
}

function withFakeWorkers<T>(fn: (created: FakeWorker[]) => T): T {
    const originalWorker = globalThis.Worker;
    const created: FakeWorker[] = [];
    globalThis.Worker = class extends FakeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
            super(url, options);
            created.push(this);
        }
    } as unknown as typeof Worker;
    try {
        return fn(created);
    } finally {
        globalThis.Worker = originalWorker;
    }
}

Deno.test("cleanupWorkers - is a no-op when no workers exist", () => {
    withFakeWorkers((created) => {
        cleanupWorkers();
        assertEquals(created.length, 0);
    });
});

Deno.test("cleanupWorkers - terminates every registered worker and empties the registry", () => {
    withFakeWorkers((created) => {
        // Each call registers one worker; the promises never settle (no
        // messages are posted) and are intentionally not awaited.
        poTokenGenerate({} as Config, undefined);
        poTokenGenerate({} as Config, undefined);
        assertEquals(created.length, 2);
        assertEquals(created.map((w) => w.terminated), [false, false]);

        cleanupWorkers();
        assertEquals(created.map((w) => w.terminated), [true, true]);

        // Second call finds an empty registry and must not terminate again
        // or throw.
        created.forEach((w) => w.terminated = false);
        cleanupWorkers();
        assertEquals(created.map((w) => w.terminated), [false, false]);
    });
});
```

- [ ] **Step 2: Run the test**

Run: `deno task test src/tests/shutdown_test.ts`
Expected: `ok | 2 passed | 0 failed`, with `[INFO] [PO-TOKEN] Cleaning up 2 worker(s) for shutdown` in the output.

- [ ] **Step 3: Run the whole unit suite to confirm nothing leaks between files**

Run: `deno task test --ignore=src/tests/main_test.ts`
Expected: all tests pass; no `Leaks detected` sanitizer errors.

- [ ] **Step 4: Format, lint, check, commit**

Run: `deno fmt src/tests/shutdown_test.ts && deno task lint && deno task check`

```bash
git add src/tests/shutdown_test.ts
git commit -m "test: assert cleanupWorkers terminates registered workers via a fake Worker"
```

---

### Task 8: CI — run on push to master, split unit/integration, pin the tor action, add a no-push Docker build (E2, E4, E10)

**Files:**
- Modify: `.github/workflows/deno-check.yaml` (whole file)
- Delete: `.github/workflows/docker-build-push.yaml.bak`

**Interfaces:**
- Consumes: `deno task test --ignore=src/tests/main_test.ts` (Deno appends task arguments to the `deno test` command, so `--ignore` is a valid test-runner flag here) and `deno task test src/tests/main_test.ts`.
- Produces: job names `static-checks`, `unit-tests`, `integration-tests`, `docker-build` that Task 9's release workflow does **not** depend on (release has its own `verify` job so it never waits on the network-bound integration job).

- [ ] **Step 1: Write the new workflow**

Replace `.github/workflows/deno-check.yaml` with:

```yaml
name: Testing

on:
  pull_request:
    branches: [master]
  push:
    branches: [master]

jobs:
  static-checks:
    name: Format, type-check, lint
    runs-on: ubuntu-latest
    steps:
      - name: Setup repo
        uses: actions/checkout@v6

      - name: Setup Deno
        uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x

      - name: Cache Deno dependencies
        uses: actions/cache@v5
        with:
          path: |
            ~/.cache/deno
          key: deno-${{ runner.os }}-${{ hashFiles('deno.lock') }}
          restore-keys: |
            deno-${{ runner.os }}-

      - name: Verify formatting
        run: deno task format

      - name: Verify typing
        run: deno task check

      - name: Run linter
        run: deno task lint

  unit-tests:
    name: Unit tests (no network)
    runs-on: ubuntu-latest
    needs: static-checks
    steps:
      - name: Setup repo
        uses: actions/checkout@v6

      - name: Setup Deno
        uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x

      - name: Cache Deno dependencies
        uses: actions/cache@v5
        with:
          path: |
            ~/.cache/deno
          key: deno-${{ runner.os }}-${{ hashFiles('deno.lock') }}
          restore-keys: |
            deno-${{ runner.os }}-

      # main_test.ts boots the real server and talks to YouTube; everything
      # else is deterministic and must fail fast without any proxy/retry loop.
      - name: Run unit tests
        run: deno task test --ignore=src/tests/main_test.ts

  integration-tests:
    name: Integration test (YouTube via proxy)
    runs-on: ubuntu-latest
    needs: static-checks
    steps:
      - name: Setup repo
        uses: actions/checkout@v6

      - name: Setup Deno
        uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x

      - name: Cache Deno dependencies
        uses: actions/cache@v5
        with:
          path: |
            ~/.cache/deno
          key: deno-${{ runner.os }}-${{ hashFiles('deno.lock') }}
          restore-keys: |
            deno-${{ runner.os }}-

      - name: Checkout binaries repo
        uses: actions/checkout@v6
        with:
          repository: iv-org/binaries
          path: ci-binaries

      - name: Install and run tor
        # Pinned to a commit SHA; `main` is a mutable ref.
        uses: tor-actions/setup-tor@64121bc84235ab7038224e8ce08601efdb9bd8d9 # main 2026-09
        with:
          daemon: true
          port: 9150
          config: |
            ExcludeExitNodes {us}
            StrictNodes 1

      - name: Run integration test with opera-proxy (fallback to tor)
        run: |
          OPERA_SUCCESS=false
          for attempt in {1..4}; do
            echo "=== Opera-proxy attempt $attempt/4 ==="
            ci-binaries/opera-proxy-amd64 &
            PROXY_PID=$!
            sleep 3s
            curl -s -x http://127.0.0.1:18080 --retry 5 --retry-delay 2 --retry-connrefused https://check.torproject.org/api/ip; echo
            rm -rf /var/tmp/youtubei.js
            if PROXY=http://127.0.0.1:18080 deno task test src/tests/main_test.ts; then
              OPERA_SUCCESS=true
              kill $PROXY_PID 2>/dev/null
              break
            fi
            kill $PROXY_PID 2>/dev/null
          done

          if [ "$OPERA_SUCCESS" = true ]; then
            echo "=== Integration test passed with opera-proxy ==="
            exit 0
          fi

          echo "=== Opera-proxy failed, falling back to tor ==="
          for attempt in {1..12}; do
            echo "=== Tor attempt $attempt/12 ==="
            sudo pkill -HUP tor
            curl -s --socks5 127.0.0.1:9150 https://check.torproject.org/api/ip; echo
            rm -rf /var/tmp/youtubei.js
            if PROXY=socks5://127.0.0.1:9150 deno task test src/tests/main_test.ts; then
              echo "=== Integration test passed with tor ==="
              exit 0
            fi
          done

          echo "=== All attempts failed ==="
          exit 1

  docker-build:
    name: Docker image builds
    runs-on: ubuntu-latest
    needs: static-checks
    steps:
      - name: Setup repo
        uses: actions/checkout@v6

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v4

      # Build only (no registry push): catches a broken Dockerfile or a
      # compile failure inside the builder stage before it reaches master.
      - name: Build image
        uses: docker/build-push-action@v7
        with:
          context: .
          push: false
          load: false
          platforms: linux/amd64
          build-args: |
            CHECK_CHECKSUMS=1
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 2: Delete the dead workflow**

```bash
git rm .github/workflows/docker-build-push.yaml.bak
```

- [ ] **Step 3: Validate the YAML locally**

Run: `deno eval 'import { parse } from "jsr:@std/yaml@1.0.5"; const doc = parse(await Deno.readTextFile(".github/workflows/deno-check.yaml")) as Record<string, unknown>; console.log(Object.keys(doc.jobs as object));'`
Expected: `[ "static-checks", "unit-tests", "integration-tests", "docker-build" ]`.

Run: `deno task test --ignore=src/tests/main_test.ts`
Expected: unit suite passes locally in well under a minute, with no `Checking if Invidious companion works` test in the output (proves the ignore pattern excludes `main_test.ts`).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deno-check.yaml
git commit -m "ci: run checks on master pushes, split unit and integration tests, pin tor action, build image on PR"
```

---

### Task 9: One compile entrypoint for `deno task compile` and the release workflow; gate releases on static checks (E2, E10)

**Files:**
- Create: `scripts/compile.sh`
- Modify: `deno.json:4` (the `compile` task)
- Modify: `Dockerfile:118` (copy `scripts/` into the builder)
- Modify: `.github/workflows/release-binaries.yaml` (whole file)

**Interfaces:**
- Produces: `scripts/compile.sh [extra deno-compile flags]` — holds every `deno compile` flag; `COMPILE_OUTPUT` env var overrides the output path (default `invidious_companion`); any arguments are inserted before `src/main.ts`. Permission set = the current `deno.json` task (unrestricted `--allow-read`), which is the documented source of truth; the release workflow's narrower `--allow-read` list is dropped because it breaks `CONFIG_FILE`/`CACHE_DIRECTORY` outside the working directory (spec E10).
- Consumes: nothing from other tasks. (Docker build uses `deno task compile` → the script; the builder image is Debian and has `bash`.)

- [ ] **Step 1: Create `scripts/compile.sh`**

```bash
#!/usr/bin/env bash
# Single source of truth for `deno compile`. Called by `deno task compile`
# (host build, Dockerfile builder stage) and by the release workflow, which
# passes `--target=<triple>`. Any arguments are forwarded to `deno compile`
# ahead of the entrypoint; COMPILE_OUTPUT overrides the output path.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

OUTPUT="${COMPILE_OUTPUT:-invidious_companion}"
VERSION_DATE="$(git log -1 --format=%ci | awk '{print $1}' | sed s/-/./g)"
VERSION_COMMIT="$(git rev-list HEAD --max-count=1 --abbrev-commit)"

exec deno compile \
    --include ./src/lib/helpers/youtubePlayerReq.ts \
    --include ./src/lib/helpers/getFetchClient.ts \
    --allow-import=github.com:443,jsr.io:443,cdn.jsdelivr.net:443,esm.sh:443,deno.land:443 \
    --allow-net \
    --allow-env \
    --allow-read \
    --allow-sys=hostname \
    --allow-write=/var/tmp/youtubei.js,/tmp/invidious-companion.sock,/tmp/companionsock \
    --output "${OUTPUT}" \
    "$@" \
    src/main.ts \
    --_version_date="${VERSION_DATE}" \
    --_version_commit="${VERSION_COMMIT}"
```

Then: `chmod +x scripts/compile.sh`.

- [ ] **Step 2: Point the task at the script**

In `deno.json`, replace line 4 (the whole `"compile": "deno compile …"` entry) with:

```json
    "compile": "bash scripts/compile.sh",
```

- [ ] **Step 3: Copy the script into the Docker builder stage**

In `Dockerfile`, after line 118 (`COPY ./src/ ./src/`) add:

```dockerfile
COPY ./scripts/ ./scripts/
```

- [ ] **Step 4: Verify the host build still works**

Run: `deno task compile && ./invidious_companion --help 2>&1 | head -3; ls -la invidious_companion`
Expected: the binary is produced; `Version <date>-<sha>` (or the normal startup output) appears; `invidious_companion` exists. Then `rm invidious_companion`.

Run: `COMPILE_OUTPUT=/tmp/ic-test bash scripts/compile.sh --target=x86_64-unknown-linux-gnu && ls -la /tmp/ic-test && rm /tmp/ic-test`
Expected: builds to `/tmp/ic-test` with an explicit target (this is the exact invocation shape the release workflow uses).

- [ ] **Step 5: Rewrite the release workflow**

Replace `.github/workflows/release-binaries.yaml` with:

```yaml
name: Rolling Release Binaries

on:
  push:
    branches:
      - master
  workflow_dispatch:

jobs:
  verify:
    name: Format, type-check, lint
    runs-on: ubuntu-latest
    steps:
      - name: Setup repo
        uses: actions/checkout@v6

      - name: Setup Deno
        uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x

      - name: Cache Deno dependencies
        uses: actions/cache@v5
        with:
          path: |
            ~/.cache/deno
          key: deno-${{ runner.os }}-${{ hashFiles('deno.lock') }}
          restore-keys: |
            deno-${{ runner.os }}-

      - name: Verify formatting
        run: deno task format

      - name: Verify typing
        run: deno task check

      - name: Run linter
        run: deno task lint

      - name: Run unit tests
        run: deno task test --ignore=src/tests/main_test.ts

  build:
    runs-on: ubuntu-latest
    needs: verify
    permissions:
      contents: write
    strategy:
      matrix:
        target:
          - x86_64-pc-windows-msvc
          - aarch64-apple-darwin
          - x86_64-unknown-linux-gnu
          - aarch64-unknown-linux-gnu

    steps:
      - name: Setup repo
        uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - name: Setup Deno
        uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x

      - name: Cache Deno dependencies
        uses: actions/cache@v5
        with:
          path: |
            ~/.cache/deno
          key: deno-${{ runner.os }}-${{ matrix.target }}-${{ hashFiles('deno.lock') }}
          restore-keys: |
            deno-${{ runner.os }}-${{ matrix.target }}-
            deno-${{ runner.os }}-

      - name: Set binary name
        id: binary-name
        run: |
          case "${{ matrix.target }}" in
            *-windows-*)
              echo "name=invidious_companion.exe" >> $GITHUB_OUTPUT
              echo "archive_name=invidious_companion-${{ matrix.target }}.zip" >> $GITHUB_OUTPUT
              ;;
            *)
              echo "name=invidious_companion" >> $GITHUB_OUTPUT
              echo "archive_name=invidious_companion-${{ matrix.target }}.tar.gz" >> $GITHUB_OUTPUT
              ;;
          esac

      # Same flags as `deno task compile` (scripts/compile.sh is the single
      # source of truth); only the target and output name differ.
      - name: Build binary
        env:
          COMPILE_OUTPUT: ${{ steps.binary-name.outputs.name }}
        run: bash scripts/compile.sh --target=${{ matrix.target }}

      - name: Create archive
        run: |
          case "${{ matrix.target }}" in
            *-windows-*)
              zip "${{ steps.binary-name.outputs.archive_name }}" "${{ steps.binary-name.outputs.name }}"
              ;;
            *)
              tar -czf "${{ steps.binary-name.outputs.archive_name }}" "${{ steps.binary-name.outputs.name }}"
              ;;
          esac

      - name: Upload artifact
        uses: actions/upload-artifact@v7
        with:
          name: binary-${{ matrix.target }}
          path: ${{ steps.binary-name.outputs.archive_name }}
          retention-days: 90

  release:
    runs-on: ubuntu-latest
    needs: build
    permissions:
      contents: write
    steps:
      - name: Download all artifacts
        uses: actions/download-artifact@v8
        with:
          path: artifacts

      - uses: ncipollo/release-action@v1
        with:
          tag: release-${{ github.ref_name }}
          removeArtifacts: true
          allowUpdates: true
          artifacts: artifacts/**
          body: |
            Binaries from ${{ github.ref_name }} branch.
```

- [ ] **Step 6: Validate and commit**

Run: `deno eval 'import { parse } from "jsr:@std/yaml@1.0.5"; const doc = parse(await Deno.readTextFile(".github/workflows/release-binaries.yaml")) as { jobs: Record<string, { needs?: string }> }; console.log(doc.jobs.build.needs, doc.jobs.release.needs);'`
Expected: `verify build`.

Run: `deno task check && deno task lint && deno task format`
Expected: no errors (`deno.json` is not covered by `fmt --check src/**`, but keep it 2-space indented like the rest of the file).

```bash
git add scripts/compile.sh deno.json Dockerfile .github/workflows/release-binaries.yaml
git commit -m "ci: compile through scripts/compile.sh everywhere and gate releases on static checks"
```

---

### Task 10: Container hygiene — `.dockerignore`, config copy, pinned base image, working `docker-compose.yaml` (E6, E7, E10)

**Files:**
- Modify: `.dockerignore` (whole file)
- Modify: `Dockerfile:127, 157`
- Modify: `docker-compose.yaml` (whole file)
- Create: `.env.example`

**Interfaces:**
- Consumes: nothing.
- Produces: the compose service expects `SERVER_SECRET_KEY` from the shell or `.env` and mounts `./config/config.toml` read-only. Task 11 documents this.

- [ ] **Step 1: `.dockerignore` — never ship a real config or `.env`**

Replace the whole of `.dockerignore` with:

```
invidious_companion
test_things/
config/config.toml
config/local.toml
.env
```

`.git` must **not** be ignored: the builder bind-mounts it (`Dockerfile:123`) to stamp the version.

- [ ] **Step 2: Dockerfile — copy only the example config, pin the runtime base image**

Replace line 127

```dockerfile
FROM gcr.io/distroless/cc AS app
```

with (digest of `gcr.io/distroless/cc-debian12:latest` as of 2026-09-16, obtained with `docker buildx imagetools inspect gcr.io/distroless/cc-debian12:latest`; refresh with the same command when bumping):

```dockerfile
FROM gcr.io/distroless/cc-debian12:latest@sha256:e5d81ddde149641e2a9ba55be4545bc125c67de07508b03ba4c22e6eb0ded5aa AS app
```

Replace line 157

```dockerfile
COPY ./config/ ./config/
```

with:

```dockerfile
# Only the example ships in the image; the real config is mounted at runtime
# (see docker-compose.yaml) so secrets never land in an image layer.
COPY ./config/config.example.toml ./config/config.example.toml
```

- [ ] **Step 3: `docker-compose.yaml` — require the secret, mount the config, drop the obsolete `version`**

Replace the whole file with:

```yaml
services:
  invidious_companion:
    build:
      context: .
      dockerfile: Dockerfile
    # image: quay.io/invidious/invidious-companion:latest
    environment:
      # 16 alphanumeric characters; put it in .env (see .env.example) or export
      # it in the shell. Compose refuses to start without it.
      SERVER_SECRET_KEY: ${SERVER_SECRET_KEY:?set SERVER_SECRET_KEY (16 alphanumeric chars) in .env or the environment}
    ports:
      - 127.0.0.1:8282:8282
    restart: unless-stopped
    cap_drop:
      - ALL
    read_only: true
    user: 10001:10001
    volumes:
      # cache for youtube library
      - /var/tmp/youtubei.js:/var/tmp/youtubei.js:rw
      # optional TOML overrides; create it with
      #   cp config/config.example.toml config/config.toml
      - ./config/config.toml:/app/config/config.toml:ro
    security_opt:
      - no-new-privileges:true
```

- [ ] **Step 4: Add `.env.example`**

Create `.env.example` (the real `.env` is git- and docker-ignored):

```
# Copy to .env and replace the value. Exactly 16 alphanumeric characters
# (e.g. `pwgen 16 1`). Must match `invidious_companion_key` in Invidious.
SERVER_SECRET_KEY=CHANGEME12345678
```

- [ ] **Step 5: Verify**

Run: `docker compose config >/dev/null; echo "exit=$?"`
Expected: `exit=1` with `error while interpolating services.invidious_companion.environment.SERVER_SECRET_KEY: required variable SERVER_SECRET_KEY is missing a value: set SERVER_SECRET_KEY (16 alphanumeric chars) in .env or the environment`.

Run: `SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa docker compose config | grep -A1 'SERVER_SECRET_KEY\|config.toml'`
Expected: the env var is rendered and the `config/config.toml` bind mount appears; no `version` warning.

Run (needs Docker; skip if unavailable and say so in the commit message): `docker build --build-arg CHECK_CHECKSUMS=1 -t invidious-companion:plan-e . && docker run --rm --entrypoint /bin/sh invidious-companion:plan-e -c 'ls /app/config' 2>/dev/null || docker create --name ic-plan-e invidious-companion:plan-e && docker cp ic-plan-e:/app/config /tmp/ic-plan-e-config && ls /tmp/ic-plan-e-config && docker rm ic-plan-e && rm -rf /tmp/ic-plan-e-config`
Expected: the image builds; the copied `config` directory contains only `config.example.toml` (distroless has no shell, hence the `docker cp` fallback).

- [ ] **Step 6: Commit**

```bash
git add .dockerignore Dockerfile docker-compose.yaml .env.example
git commit -m "chore(docker): keep secrets out of image layers, pin runtime base by digest, make compose start as documented"
```

---

### Task 11: README — env table from the schema, endpoints, working test command, structure (E8)

**Files:**
- Modify: `README.md:29-36, 72-78, 91-148, 191-203, 205-230`

**Interfaces:**
- Consumes: the compose changes from Task 10 and the test command form `deno task test src/tests/<file>`.
- Produces: nothing.

- [ ] **Step 1: Replace "Entry Points" (lines 29–36)**

```markdown
## Entry Points

- Main runtime entry: `src/main.ts`
    - Started by `deno task dev`
    - Compiled by `deno task compile` (→ `scripts/compile.sh`) into `./invidious_companion`
- Route registration: `src/routes/index.ts`
    - Companion routes are served under `server.base_path` (default: `/companion`)
    - Misc routes are served at the root: `/healthz`, `/readyz` and optional `/metrics`

## Endpoints

Root (no base path):

| Method | Path       | Auth                          | Purpose                                                                 |
|--------|------------|-------------------------------|-------------------------------------------------------------------------|
| GET    | `/healthz` | none                          | Liveness; always `200`.                                                 |
| GET    | `/readyz`  | none                          | Readiness JSON; `503` until config, Innertube client and PO-token minter are up. |
| GET    | `/metrics` | `Authorization: Bearer <secret_key>` | Prometheus metrics; only mounted when `SERVER_ENABLE_METRICS=true`. |

Under `server.base_path` (default `/companion`):

| Method | Path                            | Auth                                  | Purpose                                              |
|--------|---------------------------------|---------------------------------------|------------------------------------------------------|
| POST   | `/youtubei/v1/player`           | `Authorization: Bearer <secret_key>`  | Player response for Invidious.                       |
| GET    | `/latest_version`               | `check` when `SERVER_VERIFY_REQUESTS` | Redirect to a stream URL by `id` + `itag`.           |
| POST   | `/download`                     | `check` when `SERVER_VERIFY_REQUESTS` | Download widget dispatcher (captions or stream).     |
| GET    | `/api/manifest/dash/id/:id`     | `check` when `SERVER_VERIFY_REQUESTS` | DASH manifest.                                       |
| GET    | `/api/v1/captions/:id`          | `check` when `SERVER_VERIFY_REQUESTS` | Caption list, or one track as `text/vtt` (`label`/`lang`). `503` when `CAPTIONS_ENABLED=false`. |
| GET    | `/videoplayback`                | `enc`/`data` when `SERVER_ENCRYPT_QUERY_PARAMS` | Streams bytes from `googlevideo.com` with `Range` passthrough. |
```

- [ ] **Step 2: Replace "4) Docker (optional)" (lines 72–78)**

```markdown
### 4) Docker (optional)

```bash
cp .env.example .env                                  # then edit SERVER_SECRET_KEY
cp config/config.example.toml config/config.toml      # optional TOML overrides, mounted read-only
docker compose up -d
```

Compose refuses to start when `SERVER_SECRET_KEY` is unset. The real
`config/config.toml` and `.env` are excluded from the image (`.dockerignore`);
only `config/config.example.toml` is copied in.

> If your Docker installation only supports legacy syntax, use `docker-compose up -d`.
```

- [ ] **Step 3: Replace "Environment Variables" (lines 91–148)**

```markdown
## Environment Variables

Every setting can be provided through `config/config.toml` (see
`config/config.example.toml`) or through the environment variable listed here.
TOML values take precedence over environment variables. The table is derived
from the Zod schema in `src/lib/helpers/config.ts`.

### Required

| Variable            | Description                                           |
|---------------------|-------------------------------------------------------|
| `SERVER_SECRET_KEY` | Required. Must be exactly 16 alphanumeric characters. |

### Server

| Variable                      | Default                         | Description                                                    |
|-------------------------------|---------------------------------|----------------------------------------------------------------|
| `PORT`                        | `8282`                          | HTTP port (when not using Unix socket).                        |
| `HOST`                        | `127.0.0.1`                     | HTTP bind host.                                                |
| `SERVER_USE_UNIX_SOCKET`      | `false`                         | Listen on Unix socket instead of TCP.                          |
| `SERVER_UNIX_SOCKET_PATH`     | `/tmp/invidious-companion.sock` | Unix socket path.                                              |
| `SERVER_BASE_PATH`            | `/companion`                    | Base route prefix for companion endpoints.                     |
| `SERVER_VERIFY_REQUESTS`      | `false`                         | Require a signed `check` param on Invidious-facing routes.     |
| `SERVER_ENCRYPT_QUERY_PARAMS` | `false`                         | Encrypt `pot`/`ip` in `/videoplayback` URLs (`enc=true&data=`). |
| `SERVER_ENABLE_METRICS`       | `false`                         | Expose `/metrics` (bearer-protected with `SERVER_SECRET_KEY`). |
| `CONFIG_FILE`                 | `config/config.toml`            | Override config file location.                                 |
| `LOG_LEVEL`                   | `info`                          | `debug`, `info`, `warn` or `error`.                            |

### Captions

| Variable           | Default | Description                                                              |
|--------------------|---------|--------------------------------------------------------------------------|
| `CAPTIONS_ENABLED` | `true`  | Set to `false` to answer `/api/v1/captions` with `503` (each caption fetch consumes a PO token). |

### Cache

| Variable                     | Default    | Description                                             |
|------------------------------|------------|---------------------------------------------------------|
| `CACHE_ENABLED`              | `true`     | Cache deciphered player responses in Deno KV.           |
| `CACHE_DIRECTORY`            | `/var/tmp` | KV store lives at `<dir>/youtubei.js/kv_cache.sqlite3`. |
| `CACHE_TTL_SECONDS`          | `3600`     | Positive cache TTL (max 21600).                         |
| `CACHE_NEGATIVE_TTL_SECONDS` | `30`       | TTL for non-OK player responses; `0` disables.          |

### Networking

| Variable                                     | Default | Description                                                    |
|----------------------------------------------|---------|----------------------------------------------------------------|
| `PROXY`                                      | `null`  | Single egress proxy URL (http/https/socks4/socks5).            |
| `NETWORKING_IPV6_BLOCK`                      | `null`  | IPv6 block for per-request source-address rotation.            |
| `NETWORKING_FETCH_TIMEOUT_MS`                | `30000` | Upstream fetch timeout (1000–300000).                          |
| `NETWORKING_FETCH_RETRY_ENABLED`             | `false` | Retry upstream fetches with exponential backoff.               |
| `NETWORKING_FETCH_RETRY_TIMES`               | `1`     | Max retries (1–10).                                            |
| `NETWORKING_FETCH_RETRY_INITIAL_DEBOUNCE`    | `0`     | First retry delay (ms).                                        |
| `NETWORKING_FETCH_RETRY_DEBOUNCE_MULTIPLIER` | `0`     | Backoff multiplier.                                            |
| `NETWORKING_VIDEOPLAYBACK_UMP`               | `false` | Enable YouTube's UMP video format.                             |
| `NETWORKING_RATE_LIMIT_ENABLED`              | `true`  | Cap outbound concurrency per egress IP.                        |
| `NETWORKING_RATE_LIMIT_MAX_CONCURRENT`       | `8`     | Max in-flight upstream requests (per proxy when pooled).       |
| `NETWORKING_RATE_LIMIT_MIN_INTERVAL_MS`      | `0`     | Minimum spacing between request starts.                        |
| `NETWORKING_PROXY_POOL_SWITCH_ON_LIMIT`      | `false` | Hop to another pool proxy when the active one is saturated.    |

`[networking.proxy_pool]` (`enabled`, `rotation`, `health_check`, `proxies`) is
**TOML-only**; there is no environment variable for the proxy list.

### Jobs / YouTube session

| Variable                                       | Default                      | Description                                                        |
|------------------------------------------------|------------------------------|--------------------------------------------------------------------|
| `JOBS_YOUTUBE_SESSION_PO_TOKEN_ENABLED`        | `true`                       | Generate PO tokens with BotGuard.                                  |
| `JOBS_YOUTUBE_SESSION_FREQUENCY`               | `*/5 * * * *`                | Cron that checks whether the session needs regenerating.           |
| `JOBS_YOUTUBE_SESSION_LIFETIME_HOURS`          | `6`                          | Keep a session this long before re-attesting; `0` = every tick.    |
| `JOBS_YOUTUBE_SESSION_PLAYER_FALLBACK_CLIENTS` | `TV_SIMPLY,MWEB,ANDROID_VR`  | Comma-separated Innertube clients tried when WEB has no stream URLs. |
| `YOUTUBE_SESSION_OAUTH_ENABLED`                | `false`                      | Use OAuth instead of PO tokens.                                    |
| `YOUTUBE_SESSION_COOKIES`                      | `""`                         | Cookie header for the Innertube session.                           |
| `YOUTUBE_SESSION_PLAYER_ID`                    | `""`                         | Pin a specific player JS id.                                       |
| `YOUTUBE_SESSION_GL`                           | `""`                         | Region (e.g. `US`); match the egress country.                      |
| `YOUTUBE_SESSION_HL`                           | `""`                         | Language (e.g. `en`).                                              |

### Advanced / debugging

| Variable                    | Description                                                                                   |
|-----------------------------|-----------------------------------------------------------------------------------------------|
| `GET_FETCH_CLIENT_LOCATION` | Overrides the module location of `getFetchClient` (allow-listed internal paths only).         |
| `YT_PLAYER_REQ_LOCATION`    | Overrides the module location of `youtubePlayerReq` (allow-listed internal paths only).       |
```

- [ ] **Step 4: Replace "Tests" (lines 191–203)**

```markdown
## Tests

Run the full suite (`DENO_JOBS=1` and every permission flag are part of the task):

```bash
SERVER_SECRET_KEY=aaaaaaaaaaaaaaaa deno task test
```

`src/tests/main_test.ts` boots the real server and talks to YouTube; everything
else is network-free. To run only the unit tests, or a single file, pass the
paths to the task (extra arguments are appended to `deno test`):

```bash
deno task test --ignore=src/tests/main_test.ts   # unit tests only
deno task test src/tests/verifyRequest_test.ts   # one file
```

Tests that need environment variables or a config file use
`src/tests/helpers/env.ts` (`withEnv`, `withTempConfig`) so nothing leaks
between files.
```

- [ ] **Step 5: Replace "Project Structure" (lines 205–230)**

```markdown
## Project Structure

```text
.
├── config/
│   └── config.example.toml
├── scripts/
│   └── compile.sh
├── src/
│   ├── main.ts
│   ├── constants.ts
│   ├── routes/
│   │   ├── index.ts
│   │   ├── compactLogger.ts
│   │   ├── health.ts
│   │   ├── readiness.ts
│   │   ├── metrics.ts
│   │   ├── videoPlaybackProxy.ts
│   │   ├── invidious_routes/
│   │   └── youtube_api_routes/
│   ├── lib/
│   │   ├── helpers/
│   │   ├── jobs/
│   │   └── types/
│   └── tests/
│       └── helpers/
├── deno.json
├── deno.lock
├── Dockerfile
├── docker-compose.yaml
└── .env.example
```
```

- [ ] **Step 6: Verify the documented commands**

Run: `deno task test src/tests/verifyRequest_test.ts`
Expected: passes (proves the README single-file command works, including `/tmp` writes for temp configs elsewhere).

Run: `grep -c 'CAPTIONS_ENABLED\|PLAYER_FALLBACK_CLIENTS\|LOG_LEVEL\|YT_PLAYER_REQ_LOCATION\|/readyz' README.md`
Expected: `5` or more.

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs: sync README env table, endpoints and test commands with the code"
```

---

### Task 12: Safe `update.sh` (E9)

**Files:**
- Modify: `update.sh` (whole file)

**Interfaces:**
- Consumes: the rolling release archive published by Task 9's workflow (`release-master`, `invidious_companion-x86_64-unknown-linux-gnu.tar.gz` containing `invidious_companion`).
- Produces: nothing.

- [ ] **Step 1: Replace the script**

Replace the whole of `update.sh` with:

```bash
#!/usr/bin/env bash
# Update the systemd-managed companion binary from the rolling GitHub release.
#
#   ./update.sh            # download, validate, swap, restart, verify
#   ./update.sh --follow   # …then tail the service log (interactive use)
#
# Safe for unattended use: the service is only stopped after the archive has
# been downloaded and validated, the previous binary is kept as a .bak, and a
# failed restart rolls back to it.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/var/www/invidious-companion}"
SERVICE="${SERVICE:-invidious-companion}"
BINARY="invidious_companion"
ARCHIVE="invidious_companion-x86_64-unknown-linux-gnu.tar.gz"
URL="https://github.com/Sidler1/invidious-companion/releases/download/release-master/${ARCHIVE}"

FOLLOW=false
if [ "${1:-}" = "--follow" ]; then
    FOLLOW=true
fi

log() { printf '[update] %s\n' "$*"; }
die() { printf '[update] ERROR: %s\n' "$*" >&2; exit 1; }

cd "${INSTALL_DIR}" || die "install dir ${INSTALL_DIR} not found"

WORKDIR="$(mktemp -d "${INSTALL_DIR}/.update.XXXXXX")"
trap 'rm -rf "${WORKDIR}"' EXIT

log "downloading ${URL}"
curl -fsSL --retry 3 --retry-delay 2 -o "${WORKDIR}/${ARCHIVE}" "${URL}" \
    || die "download failed"

log "validating archive"
tar -tzf "${WORKDIR}/${ARCHIVE}" >/dev/null || die "archive is corrupt"
tar -tzf "${WORKDIR}/${ARCHIVE}" | grep -qx "${BINARY}" \
    || die "archive does not contain ${BINARY}"
tar -xzf "${WORKDIR}/${ARCHIVE}" -C "${WORKDIR}" "${BINARY}"
chmod 0755 "${WORKDIR}/${BINARY}"
"${WORKDIR}/${BINARY}" --help >/dev/null 2>&1 || true   # smoke: must be executable on this host
[ -x "${WORKDIR}/${BINARY}" ] || die "extracted binary is not executable"

if [ -f "${BINARY}" ] && cmp -s "${BINARY}" "${WORKDIR}/${BINARY}"; then
    log "already up to date; nothing to do"
    exit 0
fi

rollback() {
    log "restart failed; rolling back"
    if [ -f "${BINARY}.bak" ]; then
        mv -f "${BINARY}.bak" "${BINARY}"
        systemctl restart "${SERVICE}" || true
    fi
    die "update failed, previous binary restored"
}

log "stopping ${SERVICE}"
systemctl stop "${SERVICE}"

if [ -f "${BINARY}" ]; then
    cp -f "${BINARY}" "${BINARY}.bak"
fi
# Same filesystem as INSTALL_DIR, so the move is atomic.
mv -f "${WORKDIR}/${BINARY}" "${BINARY}"

log "starting ${SERVICE}"
systemctl start "${SERVICE}" || rollback

# Give the process a moment to crash-loop before declaring success.
sleep 3
systemctl is-active --quiet "${SERVICE}" || rollback

log "updated successfully"
systemctl status --no-pager --lines=5 "${SERVICE}" || true

if [ "${FOLLOW}" = true ]; then
    journalctl -u "${SERVICE}" -f
fi
```

- [ ] **Step 2: Static validation**

Run: `bash -n update.sh && (command -v shellcheck >/dev/null && shellcheck update.sh || echo "shellcheck not installed, skipped")`
Expected: no syntax errors; shellcheck clean (or skipped).

- [ ] **Step 3: Dry-run the download/validate path without touching a service**

Run (in a scratch directory; `systemctl` is stubbed so nothing on the host is stopped):

```bash
TMP="$(mktemp -d)" && mkdir -p "$TMP/bin" && printf '#!/bin/sh\necho "stub systemctl $*"\n' > "$TMP/bin/systemctl" && chmod +x "$TMP/bin/systemctl" \
  && PATH="$TMP/bin:$PATH" INSTALL_DIR="$TMP" bash update.sh; echo "exit=$?"; ls -la "$TMP"; rm -rf "$TMP"
```

Expected: `[update] downloading …`, `[update] validating archive`, `stub systemctl stop invidious-companion`, `stub systemctl start invidious-companion`, then — because the stub's `is-active` exits 0 — `[update] updated successfully`; the listing shows `invidious_companion` and no leftover `.update.*` directory. Run it a second time → `[update] already up to date; nothing to do`.

- [ ] **Step 4: Commit**

```bash
git add update.sh
git commit -m "chore: make update.sh validate before stopping, keep a backup and roll back on failure"
```

---

## Self-Review

**1. Spec coverage**

| Spec item | Task |
|---|---|
| E1 crypto round-trip tests | Tasks 4, 5 (route tests → plans B/C, declared in header) |
| E2 CI on push + release gated on checks | Tasks 8, 9 |
| E3 tautological tests replaced | Tasks 3 (proxy_pool config cases), 6 (health), 7 (shutdown) |
| E4 unit/integration split | Task 8 (`--ignore` unit job, `main_test.ts` alone in the proxy loop) |
| E5 env helpers + migration | Tasks 1, 2, 3 |
| E6 docker-compose | Task 10 |
| E7 dockerignore / Dockerfile config copy | Task 10 |
| E8 README | Task 11 |
| E9 update.sh | Task 12 |
| E10 permission drift, base-image pin, tor SHA, `.bak`, docker build job | Task 9 (compile.sh), Task 10 (digest), Task 8 (SHA, delete `.bak`, docker-build job) |

Gap: E10's literal "`deno task compile` with `--target` appended" is replaced by `scripts/compile.sh` for the reason given in the header. E8's `DENO_JOBS=1` prefix is redundant because the task already sets it; the README states that instead of repeating it.

**2. Placeholder scan** — no TBD/TODO; every code step contains the full file or the exact replacement text; the only value looked up at execution time (distroless digest) is provided concretely with the command used to refresh it.

**3. Type consistency** — `withEnv(vars, fn)` / `withTempConfig(content, fn, env?)` signatures match between Task 1 and all callers in Tasks 2–7; `poolTestConfig` is intentionally file-local in Tasks 3 and 6 with different parameter shapes (documented in each Interfaces block); `COMPILE_OUTPUT` and `--target` usage match between `scripts/compile.sh` (Task 9 step 1) and the release workflow (step 5); job names in Task 8 match the header note.
