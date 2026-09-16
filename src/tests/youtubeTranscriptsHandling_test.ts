import { HTTPException } from "hono/http-exception";
import { assertEquals, assertThrows } from "./deps.ts";
import { buildCaptionUrl } from "../lib/helpers/youtubeTranscriptsHandling.ts";

const VALID_BASE =
    "https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw&lang=en&caps=asr";

function assertRejectedWith502(baseUrl: string) {
    const err = assertThrows(
        () => buildCaptionUrl(baseUrl, "POT", "WEB"),
        HTTPException,
    );
    assertEquals(err.status, 502);
}

Deno.test("buildCaptionUrl keeps the original query and adds pot parameters", () => {
    const url = buildCaptionUrl(VALID_BASE, "POT123", "WEB");
    assertEquals(url.hostname, "www.youtube.com");
    assertEquals(url.pathname, "/api/timedtext");
    assertEquals(url.searchParams.get("v"), "jNQXAC9IVRw");
    assertEquals(url.searchParams.get("lang"), "en");
    assertEquals(url.searchParams.get("fmt"), "vtt");
    assertEquals(url.searchParams.get("potc"), "1");
    assertEquals(url.searchParams.get("pot"), "POT123");
    assertEquals(url.searchParams.get("c"), "WEB");
});

Deno.test("buildCaptionUrl works for a base URL without a query string", () => {
    const url = buildCaptionUrl(
        "https://www.youtube.com/api/timedtext",
        "P",
        "WEB",
    );
    assertEquals(url.search, "?fmt=vtt&potc=1&pot=P&c=WEB");
});

Deno.test("buildCaptionUrl rejects a foreign host", () => {
    assertRejectedWith502("https://evil.example/api/timedtext?v=abc");
});

Deno.test("buildCaptionUrl rejects a look-alike host", () => {
    assertRejectedWith502("https://www.youtube.com.evil.example/api/timedtext");
});

Deno.test("buildCaptionUrl rejects a userinfo trick", () => {
    assertRejectedWith502("https://www.youtube.com@evil.example/api/timedtext");
});

Deno.test("buildCaptionUrl rejects plain http", () => {
    assertRejectedWith502("http://www.youtube.com/api/timedtext?v=abc");
});

Deno.test("buildCaptionUrl rejects an unparsable URL", () => {
    assertRejectedWith502("not a url");
});
