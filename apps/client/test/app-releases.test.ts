import { describe, expect, it } from "vitest";
import { appDownloadSize, detectAppPlatform, parseAppReleases } from "@ltds/shared";

const windows = {
  platform: "windows",
  version: "1.0.3",
  publishedAt: "2026-10-23T12:00:00Z",
  sizeBytes: 83_809_359,
  sha256: "B7C01C87461471DEF1A432B2554C2B734AEB9042A4A5E47E5FD00AB4B7B7E472",
  downloadPath: "/api/app/download/windows/stable/1.0.3",
  requirements: "Windows 10 and 11, 64-bit",
};

describe("Get the app releases", () => {
  it("keeps a well-formed release and normalizes its checksum", () => {
    expect(parseAppReleases({ releases: [windows] })).toEqual([{ ...windows, sha256: windows.sha256.toLowerCase(), notes: undefined }]);
  });

  it("offers only the newest release per platform, in platform order", () => {
    const older = { ...windows, version: "1.0.2", publishedAt: "2026-10-01T00:00:00Z" };
    const mac = { ...windows, platform: "macos", downloadPath: "/api/app/download/macos/stable/1.0.3" };
    expect(parseAppReleases({ releases: [mac, older, windows] }).map(r => `${r.platform}@${r.version}`))
      .toEqual(["windows@1.0.3", "macos@1.0.3"]);
  });

  it("never lets a download point anywhere but the signed-in app route", () => {
    for (const downloadPath of [
      "https://example.com/app.msix", "//example.com/app.msix", "/api/app/download/../../admin",
      "/api/files/raw/x", "javascript:alert(1)", "/api/app/download/a b",
    ]) expect(parseAppReleases({ releases: [{ ...windows, downloadPath }] })).toEqual([]);
  });

  it("drops releases with missing or malformed fields", () => {
    for (const bad of [
      { ...windows, platform: "android" }, { ...windows, version: "latest" }, { ...windows, sha256: "abc" },
      { ...windows, sizeBytes: 0 }, { ...windows, sizeBytes: "83 MB" }, { ...windows, publishedAt: "soon" },
    ]) expect(parseAppReleases({ releases: [bad] })).toEqual([]);
    expect(parseAppReleases(null)).toEqual([]);
    expect(parseAppReleases({ releases: "windows" })).toEqual([]);
  });

  it("recognizes desktop platforms and leaves phones alone", () => {
    expect(detectAppPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(detectAppPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)")).toBe("macos");
    expect(detectAppPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
    expect(detectAppPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile")).toBeNull();
    expect(detectAppPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBeNull();
  });

  it("describes download sizes plainly", () => {
    expect(appDownloadSize(83_809_359)).toBe("80 MB");
    expect(appDownloadSize(3 * 1024 ** 3)).toBe("3.0 GB");
    expect(appDownloadSize(500)).toBe("1 KB");
  });
});
