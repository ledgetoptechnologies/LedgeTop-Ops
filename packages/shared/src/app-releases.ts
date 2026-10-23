/**
 * Desktop app releases offered from "Get the app" in Ops and the client portal.
 * Both Workers serve the same signed-in route; builds live in R2, never on GitHub.
 */
export type AppPlatform = "windows" | "macos" | "linux";

export const APP_PLATFORMS: readonly AppPlatform[] = ["windows", "macos", "linux"];

export const APP_PLATFORM_NAMES: Record<AppPlatform, string> = {
  windows: "Windows",
  macos: "Mac",
  linux: "Linux",
};

export type AppRelease = {
  platform: AppPlatform;
  version: string;
  /** ISO 8601 publication time. */
  publishedAt: string;
  sizeBytes: number;
  /** Lowercase hex SHA-256 of the downloaded file. */
  sha256: string;
  /** Same-origin, signed-in download path under /api/app/. */
  downloadPath: string;
  /** e.g. "Windows 10 and 11, 64-bit". */
  requirements?: string;
  notes?: string;
};

export type AppReleasesResponse = { releases: AppRelease[] };

export const APP_RELEASES_PATH = "/api/app/releases";

const VERSION = /^\d+(\.\d+){1,3}$/, SHA256 = /^[0-9a-f]{64}$/, DOWNLOAD = /^\/api\/app\/download\/[A-Za-z0-9._~/-]+$/;

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined;
}

/**
 * Keeps only well-formed releases, at most one per platform (the newest by publishedAt).
 * A release whose download path isn't a same-origin /api/app/download/ path is dropped,
 * so a malformed response can never point the button somewhere else.
 */
export function parseAppReleases(value: unknown): AppRelease[] {
  const raw = value && typeof value === "object" ? (value as { releases?: unknown }).releases : undefined;
  if (!Array.isArray(raw)) return [];
  const newest = new Map<AppPlatform, AppRelease>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const platform = APP_PLATFORMS.find(p => p === r.platform);
    const version = text(r.version, 32), publishedAt = text(r.publishedAt, 40), downloadPath = text(r.downloadPath, 512);
    const sha256 = typeof r.sha256 === "string" ? r.sha256.toLowerCase() : "";
    const sizeBytes = r.sizeBytes;
    if (!platform || !version || !VERSION.test(version) || !publishedAt || Number.isNaN(Date.parse(publishedAt))) continue;
    if (!SHA256.test(sha256) || typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) continue;
    if (!downloadPath || !DOWNLOAD.test(downloadPath) || downloadPath.includes("..") || downloadPath.includes("//")) continue;
    const release: AppRelease = { platform, version, publishedAt, sizeBytes, sha256, downloadPath,
      requirements: text(r.requirements, 120), notes: text(r.notes, 600) };
    const current = newest.get(platform);
    if (!current || Date.parse(release.publishedAt) > Date.parse(current.publishedAt)) newest.set(platform, release);
  }
  return APP_PLATFORMS.flatMap(p => newest.get(p) ?? []);
}

/** Best guess at the viewer's desktop platform; null on phones, tablets and unknown agents. */
export function detectAppPlatform(userAgent: string): AppPlatform | null {
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)) return null;
  if (/Windows/i.test(userAgent)) return "windows";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "macos";
  if (/Linux|X11/i.test(userAgent)) return "linux";
  return null;
}

export function appDownloadSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
