export type ClientViewerUnits = "imperial" | "metric";

export const CLIENT_VIEWER_UNITS_KEY = "ltds.viewer.units";

function browserStorage<T>(storage: T | undefined): T | null {
  if (storage) return storage;
  try { return globalThis.localStorage as unknown as T; }
  catch { return null; }
}

export function readClientViewerUnits(storage?: Pick<Storage, "getItem">): ClientViewerUnits {
  const target = browserStorage(storage);
  if (!target) return "imperial";
  try { return target.getItem(CLIENT_VIEWER_UNITS_KEY) === "metric" ? "metric" : "imperial"; }
  catch { return "imperial"; }
}

export function writeClientViewerUnits(units: ClientViewerUnits, storage?: Pick<Storage, "setItem">): boolean {
  const target = browserStorage(storage);
  if (!target) return false;
  try { target.setItem(CLIENT_VIEWER_UNITS_KEY, units); return true; }
  catch { return false; }
}
