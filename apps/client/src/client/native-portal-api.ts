import { requestJson } from "./bulk-download";
import type { PortalCapabilities, PortalFile, PortalFilePage, PortalRequest, PortalWorkspace, PortalWorkspaceEntry } from "./portal-api";

export type NativeWorkspaceFeatureKey = "directory" | "deliveries" | "serviceRequests" | "feedback" | "models" | "team" | "billing";
export type NativeWorkspaceFeatureState = "available" | "not_in_access" | "not_supported" | "temporarily_unavailable";
export type NativeWorkspaceFeatureReason = "authorized_capability" | "resource_authorization_required" | "capability_not_granted" | "source_not_supported" | "backend_unavailable";
export interface NativeWorkspaceFeatureStatus { state: NativeWorkspaceFeatureState; reason: NativeWorkspaceFeatureReason }
export type NativeWorkspaceFeatureReadiness = Record<NativeWorkspaceFeatureKey, NativeWorkspaceFeatureStatus>;

export interface NativePortalContext {
  workspace: PortalWorkspace & { resourceMode: "native"; sourceId: string };
  contextVersion: string;
  capabilities: Partial<PortalCapabilities> & { directoryRead: boolean; deliveryView: boolean };
  features: NativeWorkspaceFeatureReadiness;
}
export interface NativePortalBootstrap extends NativePortalContext {
  resourceMode: "native";
  capabilities: PortalCapabilities & { directoryRead: boolean; deliveryView: boolean };
  workspaces: PortalWorkspace[];
  selectedWorkspaceId: string;
}
export interface NativeEnvelope { workspaceId: string; sourceId: string; contextVersion: string }
export interface NativeHierarchy extends NativeEnvelope { entries: Array<PortalWorkspaceEntry & { parentType: string | null }>; page: { nextCursor: string | null } }
export interface NativeDeliveryTarget { id: string; displayName: string; owner: { type: string; publicId: string } }
export interface NativeDeliveries extends NativeEnvelope { items: NativeDeliveryTarget[]; page: { nextCursor: string | null } }

const text = (value: unknown, maximum = 4096): value is string => typeof value === "string" && value.length > 0 && value.length <= maximum;
const nullableText = (value: unknown): value is string | null => value === null || text(value);
const invalid = () => Object.assign(new Error("The workspace response could not be verified. Refresh the portal."), { status: 409 });
const featureKeys: NativeWorkspaceFeatureKey[] = ["directory", "deliveries", "serviceRequests", "feedback", "models", "team", "billing"];
const exactFeature = (value: NativeWorkspaceFeatureStatus | undefined, state: NativeWorkspaceFeatureState, reason: NativeWorkspaceFeatureReason) =>
  !!value && value.state === state && value.reason === reason && Object.keys(value).length === 2;
function validFeatureReadiness(value: unknown): value is NativeWorkspaceFeatureReadiness {
  if (!value || typeof value !== "object" || Object.keys(value).length !== featureKeys.length) return false;
  const features = value as Partial<NativeWorkspaceFeatureReadiness>;
  return (exactFeature(features.directory, "available", "authorized_capability") || exactFeature(features.directory, "not_in_access", "capability_not_granted")) &&
    (exactFeature(features.deliveries, "available", "resource_authorization_required") || exactFeature(features.deliveries, "temporarily_unavailable", "backend_unavailable")) &&
    (["serviceRequests", "feedback", "models", "team", "billing"] as const).every(key => exactFeature(features[key], "not_supported", "source_not_supported"));
}
export function nativeWorkspaceBase(workspaceId: string): string { return `/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}`; }
export async function loadNativePortalContext(workspace: PortalWorkspace, request: PortalRequest = requestJson, signal?: AbortSignal): Promise<NativePortalContext> {
  const value = await request<NativePortalContext>(`${nativeWorkspaceBase(workspace.id)}/context`, { signal });
  if (!value || value.workspace?.id !== workspace.id || value.workspace.resourceMode !== "native" || !text(value.workspace.sourceId, 128) ||
      value.workspace.sourceId !== workspace.sourceId || !text(value.workspace.displayName, 4000) || !text(value.workspace.rootPublicId, 256) ||
      value.workspace.rootType !== workspace.rootType || value.workspace.rootPublicId !== workspace.rootPublicId || !text(value.contextVersion) ||
      typeof value.capabilities?.directoryRead !== "boolean" || typeof value.capabilities?.deliveryView !== "boolean" ||
      !validFeatureReadiness(value.features) || (value.features.directory.state === "available") !== value.capabilities.directoryRead ||
      (value.features.deliveries.state === "available") !== value.capabilities.deliveryView) throw invalid();
  return value;
}
function verifyEnvelope(value: NativeEnvelope, context: NativePortalContext): void {
  if (!value || value.workspaceId !== context.workspace.id || value.sourceId !== context.workspace.sourceId || value.contextVersion !== context.contextVersion) throw invalid();
}
function path(context: NativePortalContext, suffix: string, cursor?: string | null): string {
  const params = new URLSearchParams({ expectedContext: context.contextVersion });
  if (cursor) params.set("cursor", cursor);
  return `${nativeWorkspaceBase(context.workspace.id)}/${suffix}?${params}`;
}
export async function loadNativeHierarchy(context: NativePortalContext, signal: AbortSignal, cursor: string | null = null): Promise<NativeHierarchy> {
  const value = await requestJson<NativeHierarchy>(path(context, "hierarchy", cursor), { signal });
  verifyEnvelope(value, context);
  if (!Array.isArray(value.entries) || !value.page || !nullableText(value.page.nextCursor) || (cursor !== null && value.page.nextCursor === cursor) || value.entries.some(entry => !entry || !text(entry.type, 64) || !text(entry.publicId, 256) || !text(entry.displayName, 4000) || !nullableText(entry.parentPublicId) || !nullableText(entry.parentType))) throw invalid();
  return value;
}
export async function loadNativeDeliveries(context: NativePortalContext, cursor: string | null, signal: AbortSignal): Promise<NativeDeliveries> {
  const value = await requestJson<NativeDeliveries>(path(context, "deliveries", cursor), { signal });
  verifyEnvelope(value, context);
  if (!Array.isArray(value.items) || !value.page || !nullableText(value.page.nextCursor) || (cursor !== null && value.page.nextCursor === cursor) || value.items.some(item => !item || !text(item.id) || !text(item.displayName, 4000) || !text(item.owner?.type, 64) || !text(item.owner.publicId, 256))) throw invalid();
  return value;
}
function mediaPath(value: unknown, context: NativePortalContext, fileId: string, suffix: "preview" | "download"): boolean {
  if (!text(value) || /[\\\u0000-\u001f\u007f]/.test(value)) return false;
  // The native API emits one exact encoded handle, with no query or alternate path.
  try { return value === `${nativeWorkspaceBase(context.workspace.id)}/files/${encodeURIComponent(fileId)}/${suffix}`; }
  catch { return false; }
}
function validFile(file: PortalFile, context: NativePortalContext): boolean {
  return !!file && text(file.id) && text(file.name, 4000) && Number.isFinite(file.size) && file.size >= 0 && typeof file.uploadedAt === "string" &&
    (file.contentType === null || typeof file.contentType === "string") && ["image", "video", "audio", "pdf", "text", "other"].includes(file.kind) &&
    (file.previewPath === null || mediaPath(file.previewPath, context, file.id, "preview")) && file.thumbnailPath === null && mediaPath(file.downloadPath, context, file.id, "download");
}
export async function loadNativeFolder(context: NativePortalContext, folderId: string, cursor: string | null, signal: AbortSignal): Promise<PortalFilePage> {
  const value = await requestJson<PortalFilePage & NativeEnvelope>(path(context, `folders/${encodeURIComponent(folderId)}`, cursor), { signal });
  verifyEnvelope(value, context);
  if (!Array.isArray(value.files) || value.files.some(file => !validFile(file, context)) || !nullableText(value.cursor) || (cursor !== null && value.cursor === cursor) || value.folderId !== folderId ||
      !Array.isArray(value.folders) || value.folders.some(folder => !folder || !text(folder.id) || !text(folder.name, 4000)) ||
      !Array.isArray(value.breadcrumbs) || value.breadcrumbs.some(crumb => !crumb || !nullableText(crumb.id) || !text(crumb.name, 4000))) throw invalid();
  return value;
}
export async function loadNativeFile(context: NativePortalContext, fileId: string, signal: AbortSignal): Promise<PortalFile> {
  const value = await requestJson<NativeEnvelope & { file: PortalFile }>(path(context, `files/${encodeURIComponent(fileId)}`), { signal });
  verifyEnvelope(value, context);
  if (!validFile(value.file, context) || value.file.id !== fileId) throw invalid();
  return value.file;
}
