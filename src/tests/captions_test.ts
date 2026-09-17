import { assert, assertEquals } from "./deps.ts";

interface CaptionsListResponse {
    captions: Array<{ label: string; languageCode: string; url: string }>;
}

export async function captionsList(baseUrl: string) {
    const listRes = await fetch(`${baseUrl}/api/v1/captions/jNQXAC9IVRw`);
    assertEquals(listRes.status, 200, "captions list status is not 200");
    const body = await listRes.json() as CaptionsListResponse;
    assert(Array.isArray(body.captions), "captions list is not an array");

    // The list may legitimately be empty for a video without tracks; only
    // exercise the track path when YouTube advertises at least one.
    if (body.captions.length === 0) return;

    const first = body.captions[0];
    assert(
        first.url.includes(`/api/v1/captions/jNQXAC9IVRw?label=`),
        "caption url is not self-referential",
    );
    // `first.url` already starts with base_path; strip it because baseUrl
    // ends with base_path too.
    const basePathEnd = first.url.indexOf("/api/v1/captions");
    const trackRes = await fetch(`${baseUrl}${first.url.slice(basePathEnd)}`);
    assertEquals(trackRes.status, 200, "caption track status is not 200");
    assertEquals(
        trackRes.headers.get("content-type"),
        "text/vtt; charset=UTF-8",
    );
    const vtt = await trackRes.text();
    assert(vtt.startsWith("WEBVTT"), "caption body is not WebVTT");
}
