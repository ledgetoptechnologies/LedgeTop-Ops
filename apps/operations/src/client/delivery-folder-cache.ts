export interface DeliveryFolderCacheEntry<T> {
  data: T;
  storedAt: number;
}

export const DELIVERY_FOLDER_CACHE_TTL_MS = 15_000;

const entries = new Map<string, DeliveryFolderCacheEntry<unknown>>();
let activeScope = "";

function key(prefix: string): string {
  return `${activeScope}\n${prefix}`;
}

export function activateDeliveryFolderCache(scope: string): void {
  if (!scope || scope === activeScope) return;
  entries.clear();
  activeScope = scope;
}

export function deactivateDeliveryFolderCache(): void {
  entries.clear();
  activeScope = "";
}

export function readDeliveryFolderCache<T>(prefix: string, now = Date.now()): T | null {
  if (!activeScope) return null;
  const cacheKey = key(prefix);
  const entry = entries.get(cacheKey);
  if (!entry) return null;
  if (now - entry.storedAt >= DELIVERY_FOLDER_CACHE_TTL_MS) {
    entries.delete(cacheKey);
    return null;
  }
  return entry.data as T;
}

export function writeDeliveryFolderCache<T>(prefix: string, data: T, now = Date.now()): void {
  if (!activeScope) return;
  entries.set(key(prefix), { data, storedAt: now });
}

export function invalidateDeliveryFolderCache(prefix?: string): void {
  if (!prefix) {
    entries.clear();
    return;
  }
  entries.delete(key(prefix));
}
