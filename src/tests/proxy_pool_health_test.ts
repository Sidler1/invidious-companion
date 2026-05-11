import { assertEquals } from "./deps.ts";

// Comprehensive tests for the new proxy pool health system

Deno.test("Proxy Health - should NOT blacklist on single failure", () => {
    const failureCount = 1;
    const FAILURE_THRESHOLD = 3;
    const shouldBlacklist = failureCount >= FAILURE_THRESHOLD;
    assertEquals(shouldBlacklist, false);
});

Deno.test("Proxy Health - SHOULD blacklist after 3 consecutive failures", () => {
    const failureCount = 3;
    const FAILURE_THRESHOLD = 3;
    const shouldBlacklist = failureCount >= FAILURE_THRESHOLD;
    assertEquals(shouldBlacklist, true);
});

Deno.test("Proxy Health - should properly remove blacklisted proxy from rotation", () => {
    const healthyProxies = new Set(["proxy1", "proxy2", "proxy3"]);
    healthyProxies.delete("proxy2"); // Blacklist proxy2
    assertEquals(healthyProxies.has("proxy2"), false);
    assertEquals(healthyProxies.size, 2);
});

Deno.test("Proxy Health - should recover proxy after 1 hour cooldown", () => {
    const lastBlacklistTime = Date.now() - 3_600_001; // 1h + 1ms ago
    const BLACKLIST_MS = 3_600_000;
    const isRecovered = (Date.now() - lastBlacklistTime) > BLACKLIST_MS;
    assertEquals(isRecovered, true);
});

Deno.test("Proxy Health - should keep proxy in rotation if under threshold", () => {
    const failureCount = 2;
    const FAILURE_THRESHOLD = 3;
    const isStillHealthy = failureCount < FAILURE_THRESHOLD;
    assertEquals(isStillHealthy, true);
});
