import { requestJson } from "./bulk-download";
import type { PortalFile, PortalFilePage, PortalRequest } from "./portal-api";

export interface DirectWorkspaceFolder { id: string; name: string; expiresAt: string | null }
export interface DirectWorkspaceFolderList { resourceMode: "direct_workspace_folders"; items: DirectWorkspaceFolder[] }
export const OPERATIONS_DIRECT_FOLDER_API = "/api/client/operations/direct-folders";
export const OPERATIONS_DIRECT_FOLDER_CAPABILITY_API = "/api/client/operations/direct-folders/capability";

const handle = (value: unknown): value is string => typeof value === "string" && value.length <= 8192 && /^df1_[A-Za-z0-9_-]+$/.test(value);
const validWorkspace = (value: string) => value.length > 0 && value.length <= 200 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const invalid = () => Object.assign(new Error("The shared folder response could not be verified."), { status: 409, responseInvalid: true });
const safeName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4000 && !/[\u0000-\u001f\u007f]/.test(value);
const timestamp = (value: unknown): value is string => typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
const exactKeys = (value: object, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function validFolder(value: unknown): value is DirectWorkspaceFolder {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as DirectWorkspaceFolder;
  return exactKeys(value, ["id", "name", "expiresAt"]) && handle(item.id) && safeName(item.name) &&
    (item.expiresAt === null || timestamp(item.expiresAt));
}
function mediaPath(value: unknown, kind: "preview" | "download", id: string): boolean {
  return value === `${OPERATIONS_DIRECT_FOLDER_API}/${kind}?${new URLSearchParams({ file: id })}`;
}
function validFile(value: unknown): value is PortalFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as PortalFile;
  return exactKeys(value, ["id", "name", "size", "uploadedAt", "contentType", "kind", "previewPath", "thumbnailPath", "downloadPath"]) &&
    handle(file.id) && safeName(file.name) && Number.isSafeInteger(file.size) && file.size >= 0 &&
    timestamp(file.uploadedAt) && (file.contentType === null || typeof file.contentType === "string") &&
    ["image", "video", "audio", "pdf", "text", "other"].includes(file.kind) &&
    (file.previewPath === null || mediaPath(file.previewPath, "preview", file.id)) && file.thumbnailPath === null &&
    mediaPath(file.downloadPath, "download", file.id);
}

export async function loadDirectWorkspaceFolders(
  workspaceId: string,
  signal?: AbortSignal,
  request: PortalRequest = requestJson,
): Promise<DirectWorkspaceFolderList> {
  if (!validWorkspace(workspaceId)) throw invalid();
  const value = await request<DirectWorkspaceFolderList>(OPERATIONS_DIRECT_FOLDER_API, { workspaceId, ...(signal ? { signal } : {}) });
  if (!value || !exactKeys(value, ["resourceMode", "items"]) || value.resourceMode !== "direct_workspace_folders" || !Array.isArray(value.items) || value.items.length > 100 ||
      !value.items.every(validFolder) || new Set(value.items.map(item => item.id)).size !== value.items.length) throw invalid();
  return value;
}

export async function loadDirectWorkspaceFolderFiles(
  workspaceId: string,
  folderId: string,
  cursor: string | null,
  signal: AbortSignal,
  request: PortalRequest = requestJson,
): Promise<PortalFilePage> {
  if (!validWorkspace(workspaceId) || !handle(folderId) || (cursor !== null && !handle(cursor))) throw invalid();
  const params = new URLSearchParams(); if (cursor) params.set("cursor", cursor);
  const suffix = params.size ? `?${params}` : "";
  const page = await request<PortalFilePage>(`${OPERATIONS_DIRECT_FOLDER_API}/${encodeURIComponent(folderId)}/files${suffix}`, { workspaceId, signal });
  if (!page || !exactKeys(page, ["files", "folders", "breadcrumbs", "folderId", "prefix", "cursor"]) || page.prefix !== "" || page.folderId !== folderId || !Array.isArray(page.files) || page.files.length > 25 ||
      !page.files.every(validFile) || !Array.isArray(page.folders) || page.folders.length > 25 ||
      !page.folders.every(item => !!item && exactKeys(item, ["id", "name"]) && handle(item.id) && safeName(item.name)) ||
      !Array.isArray(page.breadcrumbs) || page.breadcrumbs.length > 20 ||
      !page.breadcrumbs.every(item => !!item && exactKeys(item, ["id", "name"]) && (item.id === null || handle(item.id)) && safeName(item.name)) ||
      (page.cursor !== null && !handle(page.cursor))) throw invalid();
  return page;
}

export async function loadDirectWorkspaceFile(
  workspaceId: string,
  fileId: string,
  signal: AbortSignal,
  request: PortalRequest = requestJson,
): Promise<PortalFile> {
  if (!validWorkspace(workspaceId) || !handle(fileId)) throw invalid();
  const value = await request<{ resourceMode: "direct_workspace_folders"; file: PortalFile }>(
    `${OPERATIONS_DIRECT_FOLDER_API}/files/${encodeURIComponent(fileId)}`, { workspaceId, signal });
  if (!value || !exactKeys(value, ["resourceMode", "file"]) || value.resourceMode !== "direct_workspace_folders" || !validFile(value.file) || value.file.id !== fileId) throw invalid();
  return value.file;
}

export function isDirectWorkspaceFolderHandle(value: string | null | undefined): value is string { return handle(value); }

/** Capability is a rollout/readiness signal, not authority to read a folder. */
export async function loadOperationsDirectFolderCapability(
  signal?: AbortSignal,
  request: PortalRequest = requestJson,
): Promise<boolean> {
  let value: unknown;
  try {
    value = await request<unknown>(OPERATIONS_DIRECT_FOLDER_CAPABILITY_API, { omitWorkspace: true, ...(signal ? { signal } : {}) });
  } catch (caught) {
    if ((caught as {status?: unknown})?.status === 404) return false;
    throw caught;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, ["protocolVersion", "enabled"]) ||
      (value as {protocolVersion?: unknown}).protocolVersion !== 1 || typeof (value as {enabled?: unknown}).enabled !== "boolean") throw invalid();
  return (value as {enabled: boolean}).enabled;
}
