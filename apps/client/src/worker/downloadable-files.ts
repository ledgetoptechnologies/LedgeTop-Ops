import { isMovedSourceMarker } from "@ltds/shared";
import { isHiddenKey, normalizeRoot } from "./files";

export interface DownloadTombstone { physical_key: string; tombstone_kind: "exact" | "prefix"; }
export interface DownloadableObject { key: string; size: number; etag: string; }

export const DOWNLOAD_TOMBSTONES_FOR_SCOPE_SQL = `SELECT physical_key,tombstone_kind FROM delivery_tombstones
  WHERE restored_at IS NULL AND (
    (physical_key>=? AND physical_key<?)
    OR (tombstone_kind='prefix' AND substr(?,1,length(physical_key))=physical_key)
  )`;

export function downloadTombstoneScopeBounds(rootValue: string): { root: string; upperExclusive: string } {
  const root = normalizeRoot(rootValue);
  // The normalized root ends in '/'. Replacing it with its immediate ASCII
  // successor includes every possible UTF-8 suffix, including U+FFFF and
  // supplementary-plane characters, without crossing into a sibling path.
  return { root, upperExclusive: `${root.slice(0, -1)}0` };
}

interface TombstonePrefixNode {
  terminal: boolean;
  children: Map<string, TombstonePrefixNode>;
}

/**
 * Build a request-local tombstone lookup. Exact deletions use a set and prefix
 * deletions use a character trie, so checking a key costs O(key length) rather
 * than scanning every active tombstone for every listed object.
 */
export function createDownloadTombstoneIndex(tombstones: readonly DownloadTombstone[]): (key: string) => boolean {
  const exactKeys = new Set<string>();
  const prefixRoot: TombstonePrefixNode = { terminal: false, children: new Map() };

  for (const tombstone of tombstones) {
    if (tombstone.tombstone_kind === "exact") {
      exactKeys.add(tombstone.physical_key);
      continue;
    }

    let node = prefixRoot;
    for (let index = 0; index < tombstone.physical_key.length; index += 1) {
      const character = tombstone.physical_key[index]!;
      let child = node.children.get(character);
      if (!child) {
        child = { terminal: false, children: new Map() };
        node.children.set(character, child);
      }
      node = child;
    }
    node.terminal = true;
  }

  return key => {
    if (exactKeys.has(key) || prefixRoot.terminal) return true;
    let node = prefixRoot;
    for (let index = 0; index < key.length; index += 1) {
      const child = node.children.get(key[index]!);
      if (!child) return false;
      node = child;
      if (node.terminal) return true;
    }
    return false;
  };
}

export function isDownloadTombstoned(tombstones: readonly DownloadTombstone[], key: string): boolean {
  return tombstones.some(tombstone => tombstone.tombstone_kind === "exact"
    ? tombstone.physical_key === key
    : key.startsWith(tombstone.physical_key));
}

export async function listDownloadableObjects(
  bucket: Pick<R2Bucket, "list">,
  rootValue: string,
  tombstones: readonly DownloadTombstone[],
  isTombstoned = createDownloadTombstoneIndex(tombstones),
): Promise<DownloadableObject[]> {
  const root = normalizeRoot(rootValue);
  const files = new Map<string, DownloadableObject>();
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix: root, limit: 1000, cursor, include: ["customMetadata"] });
    for (const object of listed.objects) {
      if (!object.key.startsWith(root) || object.key === root || object.key.endsWith("/") ||
        isHiddenKey(object.key) || isTombstoned(object.key) || isMovedSourceMarker(object)) continue;
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
