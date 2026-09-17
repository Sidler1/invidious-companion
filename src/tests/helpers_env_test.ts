import { assertEquals, assertRejects } from "./deps.ts";
import { withEnv, withTempConfig } from "./helpers/env.ts";

const VAR = "COMPANION_TEST_WITH_ENV";

Deno.test("withEnv", async (t) => {
    await t.step(
        "sets the variable for the callback and restores the previous value",
        async () => {
            Deno.env.set(VAR, "before");
            await withEnv({ [VAR]: "during" }, () => {
                assertEquals(Deno.env.get(VAR), "during");
            });
            assertEquals(Deno.env.get(VAR), "before");
            Deno.env.delete(VAR);
        },
    );

    await t.step(
        "deletes a variable when the value is undefined and restores it",
        async () => {
            Deno.env.set(VAR, "before");
            await withEnv({ [VAR]: undefined }, () => {
                assertEquals(Deno.env.get(VAR), undefined);
            });
            assertEquals(Deno.env.get(VAR), "before");
            Deno.env.delete(VAR);
        },
    );

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
    await t.step(
        "points CONFIG_FILE at a file with the given content and removes it afterwards",
        async () => {
            let seenPath = "";
            await withTempConfig("[server]\nport = 1234\n", async () => {
                seenPath = Deno.env.get("CONFIG_FILE") ?? "";
                assertEquals(
                    await Deno.readTextFile(seenPath),
                    "[server]\nport = 1234\n",
                );
            });
            assertEquals(Deno.env.get("CONFIG_FILE"), undefined);
            await assertRejects(
                () => Deno.stat(seenPath),
                Deno.errors.NotFound,
            );
        },
    );

    await t.step(
        "applies extra env vars for the duration of the callback",
        async () => {
            Deno.env.delete(VAR);
            await withTempConfig("", () => {
                assertEquals(Deno.env.get(VAR), "extra");
            }, { [VAR]: "extra" });
            assertEquals(Deno.env.get(VAR), undefined);
        },
    );
});
