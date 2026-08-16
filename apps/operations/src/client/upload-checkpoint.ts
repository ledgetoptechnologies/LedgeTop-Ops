export interface ViewerUploadCheckpointFile {
  id: string;
  relativePath: string;
  byteSize: number;
  sha256: string;
  contentType?: string;
}

export interface ViewerUploadCheckpoint {
  version: 1;
  signature: string;
  projectId: string;
  displayName: string;
  datasetId: string;
  files: ViewerUploadCheckpointFile[];
  expiresAt: number;
}

export const UPLOAD_CHECKPOINT_KEY = "ltds.viewer.processing-upload.v1";
const MAX_BYTES = 1024 * 1024;

export function parseUploadCheckpoint(raw: string | null, now = Date.now()): ViewerUploadCheckpoint | null {
  try {
    if (!raw || raw.length > MAX_BYTES) return null;
    const value = JSON.parse(raw) as ViewerUploadCheckpoint | null;
    if (!(value?.version === 1 && /^[a-f0-9]{64}$/.test(value.signature) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.projectId) &&
      typeof value.displayName === "string" && value.displayName.trim() === value.displayName && value.displayName.length >= 1 && value.displayName.length <= 160 &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.datasetId) && Number.isFinite(value.expiresAt) &&
      value.expiresAt > now && value.expiresAt <= now + 7 * 24 * 60 * 60 * 1000 && Array.isArray(value.files) && value.files.length >= 1 && value.files.length <= 10_000 &&
      !("uploadToken" in value) && !("accessToken" in value) &&
      value.files.every(file => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(file.id) && typeof file.relativePath === "string" &&
        canonicalUploadPath(file.relativePath) === file.relativePath && Number.isSafeInteger(file.byteSize) && file.byteSize >= 0 &&
        /^[a-f0-9]{64}$/.test(file.sha256) && (file.contentType === undefined || typeof file.contentType === "string" && file.contentType.length <= 255) &&
        !("uploadToken" in file) && !("accessToken" in file)))) return null;
    const ids = new Set<string>(), paths = new Set<string>();
    for (const file of value.files) {
      const path = file.relativePath.toLocaleLowerCase("en-US");
      if (ids.has(file.id) || paths.has(path)) return null;
      ids.add(file.id); paths.add(path);
    }
    return value;
  } catch { return null; }
}

function browserStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  try { return globalThis.localStorage; }
  catch { return null; }
}

export function readUploadCheckpoint(storage?: Storage): ViewerUploadCheckpoint | null {
  const target = browserStorage(storage);
  if (!target) return null;
  try {
    const raw = target.getItem(UPLOAD_CHECKPOINT_KEY), value = parseUploadCheckpoint(raw);
    if (raw && !value) target.removeItem(UPLOAD_CHECKPOINT_KEY);
    return value;
  } catch { return null; }
}

export function writeUploadCheckpoint(value: ViewerUploadCheckpoint, storage?: Storage): boolean {
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_BYTES) throw new Error("This manifest is too large for a safe browser resume checkpoint. Split the dataset or use a server-side import.");
  const target = browserStorage(storage);
  if (!target) return false;
  try { target.setItem(UPLOAD_CHECKPOINT_KEY, serialized); return true; }
  catch { return false; }
}

export function clearUploadCheckpoint(storage?: Storage): void {
  const target = browserStorage(storage);
  if (!target) return;
  try { target.removeItem(UPLOAD_CHECKPOINT_KEY); } catch { /* resume is already unavailable */ }
}

export function canonicalUploadPath(value: string): string {
  const path = value.replace(/\\/g, "/").normalize("NFC").replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.split("/").some(segment => !segment || segment === "." || segment === ".."))
    throw new Error(`Unsafe dataset path: ${value}`);
  return path;
}

export async function uploadManifestSignature(projectId: string, displayName: string, files: Array<Pick<ViewerUploadCheckpointFile, "relativePath" | "byteSize" | "sha256">>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ projectId, displayName, files: files.map(({ relativePath, byteSize, sha256 }) => ({ relativePath, byteSize, sha256 })) }));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
