import { HttpError } from "./http";

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

export async function listFolder(bucket: R2Bucket, prefixValue: string, cursor?: string) {
  const prefix = normalizeFolderPrefix(prefixValue);
  const listed = await bucket.list({ prefix, delimiter: "/", limit: 500, cursor });
  return {
    prefix,
    folders: listed.delimitedPrefixes.map((folderPrefix) => ({
      prefix: folderPrefix,
      name: folderPrefix.slice(prefix.length).replace(/\/$/, ""),
    })),
    files: listed.objects
      .filter((object) => object.key !== prefix && !object.key.endsWith("/"))
      .map((object) => ({
        key: object.key,
        name: object.key.slice(prefix.length),
        size: object.size,
        uploaded: object.uploaded.toISOString(),
        etag: object.httpEtag,
      })),
    next_cursor: listed.truncated ? listed.cursor : null,
  };
}
