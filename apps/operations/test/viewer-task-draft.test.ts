import { describe, expect, it, vi } from "vitest";
import {
  TASK_DRAFT_CHECKPOINT_KEY,
  clearViewerTaskDraftCheckpoint,
  parseViewerTaskDraftCheckpoint,
  readViewerTaskDraftCheckpoint,
  resumeViewerTaskDraft,
  writeViewerTaskDraftCheckpoint,
  type ViewerTaskDraftCheckpoint,
} from "../src/client/viewer-task-draft";

function checkpoint(): ViewerTaskDraftCheckpoint {
  return {
    version: 1,
    submissionId: "11111111-1111-4111-8111-111111111111",
    projectId: "project-one",
    datasetId: "dataset-one",
    displayName: "GCP survey draft",
    createdAt: new Date().toISOString(),
  };
}

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe("GCP task-draft recovery", () => {
  it("persists only the credential-free normalized request", () => {
    const target = storage(), value = checkpoint();
    expect(writeViewerTaskDraftCheckpoint(value, target)).toBe(true);
    expect(readViewerTaskDraftCheckpoint(target)).toEqual(value);
    expect(target.getItem(TASK_DRAFT_CHECKPOINT_KEY)).toBe(JSON.stringify(value));
    expect(parseViewerTaskDraftCheckpoint(JSON.stringify({ ...value, accessToken: "secret" }))).toBeNull();
    expect(parseViewerTaskDraftCheckpoint(JSON.stringify({ ...value, displayName: " draft " }))).toBeNull();
    expect(parseViewerTaskDraftCheckpoint(JSON.stringify({ ...value, submissionId: "11111111-1111-8111-8111-111111111111" }))).toBeNull();
    clearViewerTaskDraftCheckpoint(target);
    expect(readViewerTaskDraftCheckpoint(target)).toBeNull();
  });

  it("replays one subject-scoped submission across reload and renewal", async () => {
    const request = vi.fn().mockResolvedValue({ task: { id: "task-one" }, replayed: true });
    await resumeViewerTaskDraft({ request } as never, checkpoint());
    expect(request).toHaveBeenCalledWith("/api/v1/tasks", {
      method: "POST",
      headers: { "Idempotency-Key": "11111111-1111-4111-8111-111111111111" },
      body: JSON.stringify({ submissionId: "11111111-1111-4111-8111-111111111111", projectId: "project-one", datasetId: "dataset-one", displayName: "GCP survey draft" }),
    });
  });
});
