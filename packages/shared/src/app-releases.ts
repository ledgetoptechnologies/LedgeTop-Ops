/**
 * Desktop app releases offered from "Get the app" in Ops and the client portal.
 * Each site serves its own signed-in route; builds live in R2, never on GitHub.
 * The server decides which channel (pilot or stable) a person is eligible for.
 */
export type AppPlatform = "windows" | "macos" | "linux";

export const APP_PLATFORMS: readonly AppPlatform[] = ["windows", "macos", "linux"];

export const APP_PLATFORM_NAMES: Record<AppPlatform, string> = {
  windows: "Windows",
  macos: "Mac",
  linux: "Linux",
};

/** Route base per site: Ops staff use /api/app, portal clients /api/client/app. */
export const OPERATIONS_APP_API = "/api/app";
export const PORTAL_APP_API = "/api/client/app";

export type AppRelease = {
  platform: AppPlatform;
  channel: "pilot" | "stable";
  version: string;
  sizeBytes: number;
  /** Lowercase hex SHA-256 of the downloaded file. */
  sha256: string;
  /** Same-origin, signed-in path under `<base>/download/`, exactly as the server sent it. */
  downloadUrl: string;
  /** e.g. "Windows 10 and 11, 64-bit". */
  minSupported?: string;
  notes?: string;
};

/** `GET <base>/latest?platform=…` answers `{ available: false }` or an available release. */
export function appLatestPath(base: string, platform: AppPlatform): string {
  return `${base}/latest?platform=${platform}`;
}

const VERSION = /^\d+(\.\d+){1,3}$/, SHA256 = /^[0-9a-f]{64}$/, SAFE_PATH = /^[A-Za-z0-9._~/-]+(\?[A-Za-z0-9._~=&-]*)?$/;

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined;
}

/**
 * The release offered for `platform`, or null when none is available or the response
 * is malformed. A download URL that isn't a same-origin `<base>/download/` path is
 * refused, so a bad response can never point the button somewhere else.
 */
export function parseAppLatest(value: unknown, platform: AppPlatform, base: string): AppRelease | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (r.available !== true || r.platform !== platform) return null;
  const channel = r.channel === "pilot" || r.channel === "stable" ? r.channel : null;
  const version = text(r.version, 32), downloadUrl = text(r.downloadUrl, 512);
  const sha256 = typeof r.sha256 === "string" ? r.sha256.toLowerCase() : "";
  const sizeBytes = r.size ?? r.sizeBytes;
  if (!channel || !version || !VERSION.test(version) || !SHA256.test(sha256)) return null;
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return null;
  if (!downloadUrl || !downloadUrl.startsWith(`${base}/download/`) || !SAFE_PATH.test(downloadUrl)
    || downloadUrl.includes("..") || downloadUrl.includes("//")) return null;
  return { platform, channel, version, sizeBytes, sha256, downloadUrl,
    minSupported: text(r.minSupported, 120), notes: text(r.notes, 600) };
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
