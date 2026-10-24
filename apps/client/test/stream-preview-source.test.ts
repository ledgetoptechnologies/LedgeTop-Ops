import { describe, expect, it } from "vitest";
import { streamPreviewSource } from "../src/client/stream-preview-source";

describe("signed Stream preview compatibility", () => {
  it("adds playback options to an older ticket without changing its signed path or other options", () => {
    const result = new URL(streamPreviewSource("https://customer-demo.cloudflarestream.com/synthetic-signed-ticket/iframe?letterboxColor=black"));
    expect(result.pathname).toBe("/synthetic-signed-ticket/iframe");
    expect(Object.fromEntries(result.searchParams)).toEqual({ letterboxColor: "black", controls: "true", autoplay: "true", muted: "true" });
  });
  it("keeps the player controls enabled even if an older ticket disables them", () => {
    expect(new URL(streamPreviewSource("https://customer-demo.cloudflarestream.com/synthetic/iframe?controls=false&autoplay=false")).searchParams.get("controls")).toBe("true");
  });
  it.each(["/media/player.html", "https://example.com/player", "https://cloudflarestream.com.example.com/synthetic/iframe", "https://customer-demo.cloudflarestream.com/synthetic/manifest/video.m3u8"])("leaves other source kinds untouched: %s", value => {
    expect(streamPreviewSource(value)).toBe(value);
  });
});
