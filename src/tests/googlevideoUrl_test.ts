import { assertEquals } from "./deps.ts";
import {
    isGooglevideoHost,
    isValidExpire,
    resolveRedirectTarget,
} from "../lib/helpers/googlevideoUrl.ts";

Deno.test("isGooglevideoHost", async (t) => {
    await t.step("accepts a googlevideo subdomain", () => {
        assertEquals(
            isGooglevideoHost("rr3---sn-4g5edne6.googlevideo.com"),
            true,
        );
    });

    await t.step("rejects suffix and userinfo tricks", () => {
        assertEquals(isGooglevideoHost("rr3.googlevideo.com.evil.com"), false);
        assertEquals(isGooglevideoHost("rr3.googlevideo.com@evil.com"), false);
        assertEquals(isGooglevideoHost("googlevideo.com"), false);
        assertEquals(isGooglevideoHost(undefined), false);
        assertEquals(isGooglevideoHost(""), false);
    });
});

Deno.test("resolveRedirectTarget", async (t) => {
    const base = "https://rr1---sn-a.googlevideo.com/videoplayback?id=1";

    await t.step("returns an absolute googlevideo https URL", () => {
        assertEquals(
            resolveRedirectTarget(
                "https://rr2---sn-b.googlevideo.com/videoplayback?id=1&x=2",
                base,
            ),
            "https://rr2---sn-b.googlevideo.com/videoplayback?id=1&x=2",
        );
    });

    await t.step("resolves a relative Location against the base", () => {
        assertEquals(
            resolveRedirectTarget("/videoplayback?id=1&r=1", base),
            "https://rr1---sn-a.googlevideo.com/videoplayback?id=1&r=1",
        );
    });

    await t.step("rejects non-googlevideo hosts", () => {
        assertEquals(
            resolveRedirectTarget("https://evil.com/videoplayback", base),
            null,
        );
    });

    await t.step("rejects non-https targets", () => {
        assertEquals(
            resolveRedirectTarget(
                "http://rr2---sn-b.googlevideo.com/videoplayback",
                base,
            ),
            null,
        );
    });

    await t.step("rejects unparsable Location values", () => {
        assertEquals(resolveRedirectTarget("http://[::1", base), null);
    });

    await t.step("accepts a c.youtube.com redirect target", () => {
        assertEquals(
            resolveRedirectTarget(
                "https://rr1.c.youtube.com/videoplayback",
                base,
            ),
            "https://rr1.c.youtube.com/videoplayback",
        );
    });

    await t.step("rejects a c.youtube.com suffix trick", () => {
        assertEquals(
            resolveRedirectTarget("https://rr1.c.youtube.com.evil.com/", base),
            null,
        );
    });

    await t.step("rejects a redirect target with userinfo", () => {
        assertEquals(
            resolveRedirectTarget("https://user@rr1.googlevideo.com/", base),
            null,
        );
    });

    await t.step("rejects a redirect target with an explicit port", () => {
        assertEquals(
            resolveRedirectTarget("https://rr1.googlevideo.com:8443/", base),
            null,
        );
    });
});

Deno.test("isValidExpire", async (t) => {
    const now = 1_700_000_000;

    await t.step("accepts a future integer timestamp", () => {
        assertEquals(isValidExpire(String(now + 60), now), true);
    });

    await t.step("accepts the current second", () => {
        assertEquals(isValidExpire(String(now), now), true);
    });

    await t.step("rejects a past timestamp", () => {
        assertEquals(isValidExpire(String(now - 1), now), false);
    });

    await t.step("rejects non-numeric, float, empty and missing values", () => {
        assertEquals(isValidExpire("abc", now), false);
        assertEquals(isValidExpire("NaN", now), false);
        assertEquals(isValidExpire("1700000000.5", now), false);
        assertEquals(isValidExpire("", now), false);
        assertEquals(isValidExpire(undefined, now), false);
    });
});
