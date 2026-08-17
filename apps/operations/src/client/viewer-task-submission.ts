import type { ViewerProcessingTask } from "@ltds/shared";
import { ViewerAdminClient } from "./viewer-admin-client";

export interface ViewerTaskSubmissionCheckpoint {
  version: 1;
  submissionId: string;
  projectId: string;
  datasetId: string;
  taskDisplayName: string;
  providerId: string;
  presetId: string | null;
  options: Record<string, unknown>;
  createdAt: string;
}

export const TASK_SUBMISSION_CHECKPOINT_KEY = "ltds.viewer.task-submission.v1";
const MAX_BYTES = 64 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function storageTarget(storage?: Storage): Storage | null {
  if (storage) return storage;
  try { return typeof localStorage === "undefined" ? null : localStorage; }
  catch { return null; }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function parseViewerTaskSubmissionCheckpoint(raw: string | null, now = Date.now()): ViewerTaskSubmissionCheckpoint | null {
  try {
    if (!raw || raw.length > MAX_BYTES) return null;
    const value = JSON.parse(raw) as ViewerTaskSubmissionCheckpoint;
    const createdAt = Date.parse(value?.createdAt || "");
    if (value?.version !== 1 || !UUID.test(value.submissionId) ||
      !OPAQUE_ID.test(value.projectId) || !OPAQUE_ID.test(value.datasetId) || !OPAQUE_ID.test(value.providerId) ||
      !(value.presetId === null || OPAQUE_ID.test(value.presetId)) ||
      typeof value.taskDisplayName !== "string" || value.taskDisplayName.trim() !== value.taskDisplayName ||
      value.taskDisplayName.length < 1 || value.taskDisplayName.length > 160 || !plainRecord(value.options) ||
      !Number.isFinite(createdAt) || createdAt > now + 5 * 60_000 || now - createdAt > MAX_AGE_MS ||
      "accessToken" in value || "grant" in value || "credential" in value) return null;
    return value;
  } catch { return null; }
}

export function readViewerTaskSubmissionCheckpoint(storage?: Storage): ViewerTaskSubmissionCheckpoint | null {
  const target = storageTarget(storage);
  if (!target) return null;
  try {
    const raw = target.getItem(TASK_SUBMISSION_CHECKPOINT_KEY);
    const value = parseViewerTaskSubmissionCheckpoint(raw);
    if (raw && !value) target.removeItem(TASK_SUBMISSION_CHECKPOINT_KEY);
    return value;
  } catch { return null; }
}

export function writeViewerTaskSubmissionCheckpoint(checkpoint: ViewerTaskSubmissionCheckpoint, storage?: Storage): boolean {
  const serialized = JSON.stringify(checkpoint);
  if (!parseViewerTaskSubmissionCheckpoint(serialized)) throw new Error("Invalid processing-task recovery checkpoint");
  const target = storageTarget(storage);
  if (!target) return false;
  try { target.setItem(TASK_SUBMISSION_CHECKPOINT_KEY, serialized); return true; }
  catch { return false; }
}

export function clearViewerTaskSubmissionCheckpoint(storage?: Storage): void {
  const target = storageTarget(storage);
  if (!target) return;
  try { target.removeItem(TASK_SUBMISSION_CHECKPOINT_KEY); }
  catch { /* recovery was unavailable already */ }
}

export function newViewerTaskSubmissionCheckpoint(input: {
  projectId: string;
  datasetId: string;
  taskDisplayName: string;
  providerId: string;
  presetId?: string | null;
  options: Record<string, unknown>;
}): ViewerTaskSubmissionCheckpoint {
  const checkpoint: ViewerTaskSubmissionCheckpoint = {
    version: 1,
    submissionId: crypto.randomUUID(),
    projectId: input.projectId,
    datasetId: input.datasetId,
    taskDisplayName: input.taskDisplayName.trim(),
    providerId: input.providerId,
    presetId: input.presetId || null,
    options: input.options,
    createdAt: new Date().toISOString(),
  };
  if (!parseViewerTaskSubmissionCheckpoint(JSON.stringify(checkpoint)))
    throw new Error("Processing task details are invalid");
  return checkpoint;
}

export async function resumeViewerTaskSubmission(
  client: ViewerAdminClient,
  checkpoint: ViewerTaskSubmissionCheckpoint,
  onCheckpoint: (value: ViewerTaskSubmissionCheckpoint) => void = () => undefined,
): Promise<unknown> {
  onCheckpoint(checkpoint);
  return client.request<{ task: ViewerProcessingTask; attempt: unknown; replayed: boolean }>("/api/v1/task-submissions", {
    method: "POST",
    headers: { "Idempotency-Key": checkpoint.submissionId },
    body: JSON.stringify({
      submissionId: checkpoint.submissionId,
      projectId: checkpoint.projectId,
      datasetId: checkpoint.datasetId,
      taskDisplayName: checkpoint.taskDisplayName,
      providerId: checkpoint.providerId,
      ...(checkpoint.presetId ? { presetId: checkpoint.presetId } : {}),
      options: checkpoint.options,
    }),
  });
}
