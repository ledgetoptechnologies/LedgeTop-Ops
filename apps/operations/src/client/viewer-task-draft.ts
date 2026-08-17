import type { ViewerProcessingTask } from "@ltds/shared";
import type { ViewerAdminClient } from "./viewer-admin-client";

export interface ViewerTaskDraftCheckpoint {
  version: 1;
  submissionId: string;
  projectId: string;
  datasetId: string;
  displayName: string;
  createdAt: string;
}

export interface ViewerTaskDraftResult {
  task: ViewerProcessingTask;
  replayed: boolean;
}

export const TASK_DRAFT_CHECKPOINT_KEY = "ltds.viewer.task-draft.v1";
const MAX_BYTES = 8 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function target(storage?: Storage): Storage | null {
  if (storage) return storage;
  try { return typeof localStorage === "undefined" ? null : localStorage; }
  catch { return null; }
}

export function parseViewerTaskDraftCheckpoint(raw: string | null, now = Date.now()): ViewerTaskDraftCheckpoint | null {
  try {
    if (!raw || raw.length > MAX_BYTES) return null;
    const value = JSON.parse(raw) as ViewerTaskDraftCheckpoint;
    const createdAt = Date.parse(value?.createdAt || "");
    if (value?.version !== 1 || !UUID.test(value.submissionId) || !OPAQUE_ID.test(value.projectId) ||
      !OPAQUE_ID.test(value.datasetId) || typeof value.displayName !== "string" ||
      value.displayName.trim() !== value.displayName || value.displayName.length < 1 || value.displayName.length > 160 ||
      !Number.isFinite(createdAt) || createdAt > now + 5 * 60_000 || now - createdAt > MAX_AGE_MS ||
      "grant" in value || "accessToken" in value || "credential" in value) return null;
    return value;
  } catch { return null; }
}

export function readViewerTaskDraftCheckpoint(storage?: Storage): ViewerTaskDraftCheckpoint | null {
  const storageTarget = target(storage);
  if (!storageTarget) return null;
  try {
    const raw = storageTarget.getItem(TASK_DRAFT_CHECKPOINT_KEY);
    const parsed = parseViewerTaskDraftCheckpoint(raw);
    if (raw && !parsed) storageTarget.removeItem(TASK_DRAFT_CHECKPOINT_KEY);
    return parsed;
  } catch { return null; }
}

export function writeViewerTaskDraftCheckpoint(checkpoint: ViewerTaskDraftCheckpoint, storage?: Storage): boolean {
  const raw = JSON.stringify(checkpoint);
  if (!parseViewerTaskDraftCheckpoint(raw)) throw new Error("Invalid task-draft recovery checkpoint");
  const storageTarget = target(storage);
  if (!storageTarget) return false;
  try { storageTarget.setItem(TASK_DRAFT_CHECKPOINT_KEY, raw); return true; }
  catch { return false; }
}

export function clearViewerTaskDraftCheckpoint(storage?: Storage): void {
  const storageTarget = target(storage);
  if (!storageTarget) return;
  try { storageTarget.removeItem(TASK_DRAFT_CHECKPOINT_KEY); }
  catch { /* unavailable storage was already reported */ }
}

export function newViewerTaskDraftCheckpoint(input: { projectId: string; datasetId: string; displayName: string }): ViewerTaskDraftCheckpoint {
  const checkpoint: ViewerTaskDraftCheckpoint = {
    version: 1,
    submissionId: crypto.randomUUID(),
    projectId: input.projectId,
    datasetId: input.datasetId,
    displayName: input.displayName.trim(),
    createdAt: new Date().toISOString(),
  };
  if (!parseViewerTaskDraftCheckpoint(JSON.stringify(checkpoint))) throw new Error("Draft task details are invalid");
  return checkpoint;
}

export function resumeViewerTaskDraft(client: ViewerAdminClient, checkpoint: ViewerTaskDraftCheckpoint): Promise<ViewerTaskDraftResult> {
  return client.request<ViewerTaskDraftResult>("/api/v1/tasks", {
    method: "POST",
    headers: { "Idempotency-Key": checkpoint.submissionId },
    body: JSON.stringify({
      submissionId: checkpoint.submissionId,
      projectId: checkpoint.projectId,
      datasetId: checkpoint.datasetId,
      displayName: checkpoint.displayName,
    }),
  });
}
