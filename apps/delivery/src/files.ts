import { HttpError } from "./http";

export interface FolderEntry {
  prefix: string;
  name: string;
}

export interface FileEntry {
  key: string;
  name: string;
  size: number;
  uploaded: string;
  etag: string;
  mediaType: "image" | "video" | "pdf" | "text" | "other";
}

export interface FolderListing {
  prefix: string;
  folders: FolderEntry[];
  files: FileEntry[];
  next_cursor: string | null;
}

const MIME_TYPES: Record<string, string> = {
  avif: "image/avif", bmp: "image/bmp", gif: "image/gif", heic: "image/heic", heif: "image/heif",
  jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", svg: "image/svg+xml", tif: "image/tiff",
  tiff: "image/tiff", webp: "image/webp",
  avi: "video/x-msvideo", m4v: "video/x-m4v", mkv: "video/x-matroska", mov: "video/quicktime",
  mp4: "video/mp4", mpeg: "video/mpeg", mpg: "video/mpeg", webm: "video/webm",
  pdf: "application/pdf", csv: "text/csv; charset=utf-8", json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8",
};

function extension(value: string): string {
  const name = value.split("/").pop() || "";
  return name.includes(".") ? (name.split(".").pop() || "").toLowerCase() : "";
}

export function mediaTypeForKey(key: string): FileEntry["mediaType"] {
  const mime = MIME_TYPES[extension(key)] || "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("text/") || mime.startsWith("application/json")) return "text";
  return "other";
}

export function mimeTypeForKey(key: string): string {
  return MIME_TYPES[extension(key)] || "application/octet-stream";
}

export function containsHiddenSegment(value: string): boolean {
  return value.replace(/\\/g, "/").split("/").some((segment) => segment.toLowerCase() === "dump");
}

export function normalizeFolderPrefix(value: string): string {
  const prefix = value.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (!prefix) return "";
  if (prefix.split("/").includes("..")) throw new HttpError(400, "Folder path is invalid");
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

export function normalizeObjectKey(value: string): string {
  const key = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!key || key.endsWith("/") || key.split("/").includes("..")) {
    throw new HttpError(400, "File key is invalid");
  }
  return key;
}

export async function listFolder(bucket: R2Bucket, prefixValue: string, cursor?: string): Promise<FolderListing> {
  const prefix = normalizeFolderPrefix(prefixValue);
  if (containsHiddenSegment(prefix)) throw new HttpError(404, "Folder not found");
  const listed = await bucket.list({ prefix, delimiter: "/", limit: 500, cursor });
  return {
    prefix,
    folders: listed.delimitedPrefixes
      .filter((folderPrefix) => !containsHiddenSegment(folderPrefix))
      .map((folderPrefix) => ({
        prefix: folderPrefix,
        name: folderPrefix.slice(prefix.length).replace(/\/$/, ""),
      })),
    files: listed.objects
      .filter((object) => object.key !== prefix && !object.key.endsWith("/") && !containsHiddenSegment(object.key))
      .map((object) => ({
        key: object.key,
        name: object.key.slice(prefix.length),
        size: object.size,
        uploaded: object.uploaded.toISOString(),
        etag: object.httpEtag,
        mediaType: mediaTypeForKey(object.key),
      })),
    next_cursor: listed.truncated ? listed.cursor : null,
  };
}
