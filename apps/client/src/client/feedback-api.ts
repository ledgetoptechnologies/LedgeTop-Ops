import type { ClientFeedbackDetail, ClientFeedbackItem, ClientFeedbackPage, ClientFeedbackTargetInput } from "@ltds/shared";
import { requestJson, selectedClientWorkspaceId } from "./bulk-download";
import type { PortalFile } from "./portal-api";

export async function loadFeedbackFile(fileId: string, projectId: string | null, workspaceId: string | null, signal: AbortSignal): Promise<PortalFile> {
  const result = await requestJson<{file: PortalFile; projectId: string | null; workspaceId: string | null}>(`/api/client/files/${encodeURIComponent(fileId)}/metadata${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`, {signal});
  const file = result.file;
  const mediaPath = (value: unknown) => typeof value === "string" && value.startsWith("/api/client/files/") && !value.includes("\\");
  if (result.projectId !== projectId || result.workspaceId !== workspaceId || !file || file.id !== fileId || typeof file.name !== "string"
    || !Number.isFinite(file.size) || file.size < 0 || typeof file.uploadedAt !== "string" || !["image", "video", "audio", "pdf", "text", "other"].includes(file.kind)
    || !mediaPath(file.downloadPath) || !(file.previewPath === null || mediaPath(file.previewPath)) || !(file.thumbnailPath === null || mediaPath(file.thumbnailPath))) throw new Error("The file link could not be verified.");
  return file;
}

export function withPortalWorkspace(path: string): string {
  const url = new URL(path, location.origin), workspace = selectedClientWorkspaceId();
  if (workspace) url.searchParams.set("workspace", workspace);
  return `${url.pathname}${url.search}`;
}
export function feedbackPath(id?: string): string { return withPortalWorkspace(id ? `/portal/feedback/${encodeURIComponent(id)}` : "/portal/feedback"); }
export function safeFeedbackTargetPath(value: string | null): string | null {
  if (!value || !(value === "/portal" || value.startsWith("/portal?") || value.startsWith("/portal/")) || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  try { const url = new URL(value, location.origin); return url.origin === location.origin && (url.pathname === "/portal" || url.pathname.startsWith("/portal/")) && !url.hash ? `${url.pathname}${url.search}` : null; } catch { return null; }
}
export function feedbackItemValid(value: unknown): value is ClientFeedbackItem {
  if (!value || typeof value !== "object") return false;
  const row = value as ClientFeedbackItem;
  return typeof row.id === "string" && row.id.length > 0 && ["new", "in_progress", "done"].includes(row.status)
    && Number.isSafeInteger(row.revision) && row.revision > 0 && typeof row.message === "string"
    && (row.completionNote === null || typeof row.completionNote === "string") && typeof row.createdAt === "string" && typeof row.updatedAt === "string"
    && (row.completedAt === null || typeof row.completedAt === "string") && Boolean(row.target)
    && ["project", "folder", "file"].includes(row.target.kind) && typeof row.target.label === "string"
    && typeof row.target.available === "boolean" && (row.target.actionPath === null || safeFeedbackTargetPath(row.target.actionPath) !== null)
    && (row.target.projectName === null || typeof row.target.projectName === "string") && (row.target.projectId === null || typeof row.target.projectId === "string");
}
export async function loadFeedback(cursor: string | null, signal: AbortSignal): Promise<ClientFeedbackPage> {
  const result = await requestJson<ClientFeedbackPage>(`/api/client/feedback${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { signal });
  if (!Array.isArray(result.items) || !result.items.every(feedbackItemValid) || !(result.nextCursor === null || typeof result.nextCursor === "string" && result.nextCursor)) throw new Error("Feedback records could not be verified.");
  return result;
}
export async function loadFeedbackDetail(id: string, signal: AbortSignal): Promise<ClientFeedbackDetail> {
  const result = await requestJson<ClientFeedbackDetail>(`/api/client/feedback/${encodeURIComponent(id)}`, { signal });
  if (!feedbackItemValid(result.feedback) || result.feedback.id !== id || !Array.isArray(result.events)
    || !result.events.every(event => ["new", "in_progress", "done"].includes(event.status) && ["client", "staff"].includes(event.actor)
      && typeof event.createdAt === "string" && (event.note === null || typeof event.note === "string"))) throw new Error("Feedback records could not be verified.");
  return result;
}
export async function submitFeedback(target: ClientFeedbackTargetInput, message: string, key: string, signal: AbortSignal): Promise<ClientFeedbackItem> {
  const result = await requestJson<{ feedback: ClientFeedbackItem }>("/api/client/feedback", {
    method: "POST", signal, headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ target, message }),
  });
  if (!feedbackItemValid(result.feedback)) throw new Error("The feedback submission could not be confirmed. Retry to check the same submission.");
  return result.feedback;
}
export const feedbackStatusLabel = (status: ClientFeedbackItem["status"]) => status === "in_progress" ? "In Progress" : status === "new" ? "New" : "Done";
