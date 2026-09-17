import { assertEquals } from "./deps.ts";
import {
    decipherStreamingData,
    DEFAULT_STREAMING_DATA_CLIENTS,
    finalizeStreamUrl,
    needsDecipher,
} from "../lib/helpers/playerDecipher.ts";

Deno.test("needsDecipher", async (t) => {
    await t.step("is true for web-family clients", () => {
        assertEquals(needsDecipher("WEB"), true);
        assertEquals(needsDecipher("TV_SIMPLY"), true);
        assertEquals(needsDecipher("MWEB"), true);
    });

    await t.step("is false for IOS and ANDROID clients", () => {
        assertEquals(needsDecipher("IOS"), false);
        assertEquals(needsDecipher("ANDROID"), false);
        assertEquals(needsDecipher("ANDROID_VR"), false);
    });
});

Deno.test("finalizeStreamUrl", async (t) => {
    await t.step("rewrites alr=yes to alr=no", () => {
        assertEquals(
            finalizeStreamUrl("https://h/videoplayback?alr=yes&n=1", undefined),
            "https://h/videoplayback?alr=no&n=1",
        );
    });

    await t.step("appends alr=no when absent", () => {
        assertEquals(
            finalizeStreamUrl("https://h/videoplayback?n=1", undefined),
            "https://h/videoplayback?n=1&alr=no",
        );
    });

    await t.step("appends the session pot when missing", () => {
        assertEquals(
            finalizeStreamUrl("https://h/videoplayback?n=1", "a b"),
            "https://h/videoplayback?n=1&alr=no&pot=a%20b",
        );
    });

    await t.step("does not duplicate an existing pot", () => {
        assertEquals(
            finalizeStreamUrl("https://h/videoplayback?pot=x&n=1", "y"),
            "https://h/videoplayback?pot=x&n=1&alr=no",
        );
    });
});

Deno.test("decipherStreamingData", async (t) => {
    const stub = (url: string) => ({ decipher: () => Promise.resolve(url) });

    await t.step(
        "deciphers both arrays for web clients and drops signatureCipher",
        async () => {
            const raw = {
                expiresInSeconds: "21540",
                formats: [{ itag: 18, signatureCipher: "s=1&url=x" }],
                adaptiveFormats: [{ itag: 137, signatureCipher: "s=2&url=y" }],
            };

            const out = await decipherStreamingData(
                {
                    formats: [stub("https://h/videoplayback?itag=18")],
                    adaptive_formats: [
                        stub("https://h/videoplayback?itag=137"),
                    ],
                },
                raw,
                {
                    player: undefined,
                    sessionPoToken: "tok",
                    clients: DEFAULT_STREAMING_DATA_CLIENTS,
                },
            );

            assertEquals(out.expiresInSeconds, "21540");
            assertEquals(out.formats, [{
                itag: 18,
                url: "https://h/videoplayback?itag=18&alr=no&pot=tok",
            }]);
            assertEquals(out.adaptiveFormats, [{
                itag: 137,
                url: "https://h/videoplayback?itag=137&alr=no&pot=tok",
            }]);
            // Input must not be mutated.
            assertEquals(raw.formats[0].signatureCipher, "s=1&url=x");
        },
    );

    await t.step(
        "passes an array through untouched when its client is ANDROID",
        async () => {
            const raw = {
                formats: [{ itag: 18, signatureCipher: "s=1&url=x" }],
                adaptiveFormats: [{ itag: 137, url: "https://h/a?n=1" }],
            };

            const out = await decipherStreamingData(
                {
                    formats: [stub("https://h/videoplayback?itag=18")],
                    adaptive_formats: [stub("https://h/should-not-be-used")],
                },
                raw,
                {
                    player: undefined,
                    sessionPoToken: "tok",
                    clients: { formats: "WEB", adaptiveFormats: "ANDROID_VR" },
                },
            );

            assertEquals(out.formats, [{
                itag: 18,
                url: "https://h/videoplayback?itag=18&alr=no&pot=tok",
            }]);
            assertEquals(out.adaptiveFormats, raw.adaptiveFormats);
        },
    );

    await t.step("tolerates missing arrays", async () => {
        const out = await decipherStreamingData(
            { formats: [], adaptive_formats: [] },
            { hlsManifestUrl: "https://h/m3u8" },
            {
                player: undefined,
                sessionPoToken: undefined,
                clients: DEFAULT_STREAMING_DATA_CLIENTS,
            },
        );
        assertEquals(out, {
            hlsManifestUrl: "https://h/m3u8",
            formats: undefined,
            adaptiveFormats: undefined,
        });
    });
});
