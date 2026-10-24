import { describe, expect, it } from "vitest";
import { PORTAL_APP_API, appDownloadSize, appLatestPath, detectAppPlatform, parseAppLatest } from "@ltds/shared";

const windows = {
  available: true,
  platform: "windows",
  channel: "pilot",
  version: "1.0.3",
  size: 83_809_359,
  sha256: "B7C01C87461471DEF1A432B2554C2B734AEB9042A4A5E47E5FD00AB4B7B7E472",
  downloadUrl: "/api/client/app/download/1.0.3?platform=windows&channel=pilot",
  minSupported: "Windows 10 and 11, 64-bit",
};

describe("Get the app releases", () => {
  it("asks the portal's own namespace for one platform", () => {
    expect(appLatestPath(PORTAL_APP_API, "windows")).toBe("/api/client/app/latest?platform=windows");
  });

  it("keeps a well-formed release and normalizes its checksum", () => {
    expect(parseAppLatest(windows, "windows", PORTAL_APP_API)).toEqual({
      platform: "windows", channel: "pilot", version: "1.0.3", sizeBytes: 83_809_359,
      sha256: windows.sha256.toLowerCase(), downloadUrl: windows.downloadUrl,
      minSupported: "Windows 10 and 11, 64-bit", notes: undefined,
    });
  });

  it("treats an unavailable or mismatched answer as nothing to download", () => {
    expect(parseAppLatest({ available: false }, "windows", PORTAL_APP_API)).toBeNull();
    expect(parseAppLatest(windows, "macos", PORTAL_APP_API)).toBeNull();
    expect(parseAppLatest(null, "windows", PORTAL_APP_API)).toBeNull();
  });

  it("never lets a download point anywhere but this site's signed-in download route", () => {
    for (const downloadUrl of [
      "https://example.com/app.msix", "//example.com/app.msix", "/api/client/app/download/../../admin",
      "/api/app/download/1.0.3?platform=windows", "/api/client/files/raw/x", "javascript:alert(1)",
      "/api/client/app/download/a b", "/api/client/app/download/1.0.3?next=https://example.com",
    ]) expect(parseAppLatest({ ...windows, downloadUrl }, "windows", PORTAL_APP_API)).toBeNull();
  });

  it("drops releases with missing or malformed fields", () => {
    for (const bad of [
      { ...windows, channel: "beta" }, { ...windows, version: "latest" }, { ...windows, sha256: "abc" },
      { ...windows, size: 0 }, { ...windows, size: "83 MB" }, { ...windows, available: "yes" },
    ]) expect(parseAppLatest(bad, "windows", PORTAL_APP_API)).toBeNull();
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
