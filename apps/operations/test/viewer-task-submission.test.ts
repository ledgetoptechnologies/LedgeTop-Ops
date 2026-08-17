import { describe, expect, it, vi } from "vitest";
import {
  TASK_SUBMISSION_CHECKPOINT_KEY,
  clearViewerTaskSubmissionCheckpoint,
  parseViewerTaskSubmissionCheckpoint,
  readViewerTaskSubmissionCheckpoint,
  resumeViewerTaskSubmission,
  writeViewerTaskSubmissionCheckpoint,
  type ViewerTaskSubmissionCheckpoint,
} from "../src/client/viewer-task-submission";

function checkpoint(): ViewerTaskSubmissionCheckpoint {
  return {
    version: 1,
    submissionId: "11111111-1111-4111-8111-111111111111",
    projectId: "project-one",
    datasetId: "dataset-one",
    taskDisplayName: "August survey",
    providerId: "provider-one",
    presetId: "preset-one",
    options: { dsm: true },
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

describe("processing task submission recovery", () => {
  it("persists no credentials and rejects malformed or expired checkpoints", () => {
    const target = storage(), value = checkpoint();
    expect(writeViewerTaskSubmissionCheckpoint(value, target)).toBe(true);
    expect(readViewerTaskSubmissionCheckpoint(target)).toEqual(value);
    expect(target.getItem(TASK_SUBMISSION_CHECKPOINT_KEY)).not.toContain("accessToken");
    expect(parseViewerTaskSubmissionCheckpoint(JSON.stringify({ ...value, credential: "secret" }))).toBeNull();
    expect(parseViewerTaskSubmissionCheckpoint(JSON.stringify({ ...value, createdAt: "2020-01-01T00:00:00Z" }))).toBeNull();
    clearViewerTaskSubmissionCheckpoint(target);
    expect(readViewerTaskSubmissionCheckpoint(target)).toBeNull();
  });

  it("uses one subject-level submission id for atomic cross-session replay", async () => {
    const request = vi.fn().mockResolvedValue({ task: { id: "task-one" }, attempt: { id: "attempt-one" }, replayed: false });
    const updated: ViewerTaskSubmissionCheckpoint[] = [];
    await resumeViewerTaskSubmission({ request } as never, checkpoint(), value => updated.push(value));
    expect(request).toHaveBeenCalledWith("/api/v1/task-submissions", expect.objectContaining({
      headers: { "Idempotency-Key": "11111111-1111-4111-8111-111111111111" },
    }));
    expect(JSON.parse(request.mock.calls[0]![1].body)).toMatchObject({ submissionId: "11111111-1111-4111-8111-111111111111", taskDisplayName: "August survey" });
    expect(updated[0]?.submissionId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("resumes by replaying the same atomic request", async () => {
    const request = vi.fn().mockResolvedValue({ task: { id: "task-one" }, attempt: { id: "attempt-one" }, replayed: true });
    await resumeViewerTaskSubmission({ request } as never, checkpoint());
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/api/v1/task-submissions", expect.anything());
  });
});
