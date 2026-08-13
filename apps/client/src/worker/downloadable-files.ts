import { isMovedSourceMarker } from "@ltds/shared";
import { isHiddenKey, normalizeRoot } from "./files";

export interface DownloadTombstone { physical_key: string; tombstone_kind: "exact" | "prefix"; }
export interface DownloadableObject { key: string; size: number; etag: string; }

export function isDownloadTombstoned(tombstones: readonly DownloadTombstone[], key: string): boolean {
  return tombstones.some(tombstone => tombstone.tombstone_kind === "exact"
    ? tombstone.physical_key === key
    : key.startsWith(tombstone.physical_key));
}

export async function listDownloadableObjects(
  bucket: Pick<R2Bucket, "list">,
  rootValue: string,
  tombstones: readonly DownloadTombstone[],
): Promise<DownloadableObject[]> {
  const root = normalizeRoot(rootValue);
  const files = new Map<string, DownloadableObject>();
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix: root, limit: 1000, cursor, include: ["customMetadata"] });
    for (const object of listed.objects) {
      if (!object.key.startsWith(root) || object.key === root || object.key.endsWith("/") ||
        isHiddenKey(object.key) || isDownloadTombstoned(tombstones, object.key) || isMovedSourceMarker(object)) continue;
      files.set(object.key, { key: object.key, size: object.size, etag: object.etag });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return [...files.values()];
}

export interface DownloadSummary {
  fileCount: number;
  totalBytes: number | null;
  knownBytes: number;
  unknownSizeCount: number;
}

export function summarizeDownloadableObjects(objects: readonly Pick<DownloadableObject, "size">[]): DownloadSummary {
  let knownBytes = 0;
  let unknownSizeCount = 0;
  for (const object of objects) {
    if (!Number.isSafeInteger(object.size) || object.size < 0 || !Number.isSafeInteger(knownBytes + object.size)) {
      unknownSizeCount += 1;
      continue;
    }
    knownBytes += object.size;
  }
  return {
    fileCount: objects.length,
    totalBytes: unknownSizeCount ? null : knownBytes,
    knownBytes,
    unknownSizeCount,
  };
}
