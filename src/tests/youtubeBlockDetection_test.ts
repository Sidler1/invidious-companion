import { assertEquals } from "./deps.ts";
import { checkYouTubeBlock } from "../lib/helpers/youtubeBlockDetection.ts";

const CHUNK = new TextEncoder().encode("x".repeat(4096));

/**
 * A pull-based body that only produces the next chunk when someone reads it,
 * like a real fetch body. Response.clone() tees it; a tee branch's cancel()
 * settles only once the source is drained, so the detector must never await
 * that cancel before the caller has read the original body.
 */
function lazyResponse(chunks: Uint8Array[]): Response {
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (index >= chunks.length) {
                controller.close();
                return;
            }
            controller.enqueue(chunks[index++]);
        },
    });
    return new Response(body, {
        status: 200,
        headers: { "content-type": "text/html" },
    });
}

function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: number | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`${label} did not settle within 2s`)),
            2000,
        );
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

Deno.test("checkYouTubeBlock settles on a multi-chunk body and leaves the original readable", async () => {
    const res = lazyResponse([CHUNK, CHUNK, CHUNK]);

    const blocked = await withDeadline(checkYouTubeBlock(res), "detection");
    const text = await withDeadline(res.text(), "original body read");

    assertEquals(blocked, false);
    assertEquals(text.length, 3 * 4096);
});

Deno.test("checkYouTubeBlock still detects a block phrase in the first chunk of a multi-chunk body", async () => {
    const first = new TextEncoder().encode(
        "<html>Our systems have detected unusual traffic from your network",
    );
    const res = lazyResponse([first, CHUNK, CHUNK]);

    const blocked = await withDeadline(checkYouTubeBlock(res), "detection");
    await withDeadline(res.body!.cancel(), "original body cancel");

    assertEquals(blocked, true);
});
