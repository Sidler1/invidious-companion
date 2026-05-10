import { assertEquals } from "./deps.ts";
import { cleanupWorkers } from "../lib/jobs/potoken.ts";

Deno.test("cleanupWorkers - should not throw when no workers exist", () => {
    // This should not throw even if no workers were created
    cleanupWorkers();
    assertEquals(true, true);
});
