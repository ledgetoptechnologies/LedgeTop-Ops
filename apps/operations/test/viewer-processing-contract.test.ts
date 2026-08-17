import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { signViewerServiceRequest } from "@ltds/shared";
import type {
  ViewerDatasetImportPreview, ViewerDatasetSummary, ViewerDurableOperationResponse, ViewerProcessingAttemptDetail, ViewerProcessingProject,
  ViewerOutputSummary, ViewerProcessingTask, ViewerProjectStorageResponse, ViewerProviderSummary,
  ViewerReviewSessionGrant, ViewerStorageSummary, ViewerTaskStorageResponse,
} from "@ltds/shared";
import { signViewerProcessingEvent } from "../src/worker/viewer-processing";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL(
  "../../../packages/shared/test-fixtures/viewer-processing-contract-v1.json",
  import.meta.url,
)), "utf8"));
const routeBytes = readFileSync(fileURLToPath(new URL(
  "../../../packages/shared/test-fixtures/viewer-processing-route-responses-v1.json",
  import.meta.url,
)), "utf8");
const routes = JSON.parse(routeBytes);

describe("Viewer processing cross-service contract", () => {
  it("pins the byte-identical cross-repository route fixture", () => {
    expect(createHash("sha256").update(routeBytes).digest("hex").toUpperCase())
      .toBe("26BA67C5ECC3A534E3C067A6B4B0CD80E2D3823D766830EDC3FE77CE71152B5E");
  });
  it("pins the exact admin-grant body and service HMAC", async () => {
    const value = fixture.adminGrant;
    const headers = await signViewerServiceRequest({
      secret: value.secret, keyId: value.keyId, method: value.method,
      pathWithQuery: value.path, body: value.body, timestamp: value.timestamp, nonce: value.nonce,
    });
    expect(headers["X-LTDS-Content-SHA256"]).toBe(value.contentSha256);
    expect(headers["X-LTDS-Signature"]).toBe(value.signature);
    expect(JSON.parse(value.body)).toMatchObject({ displayUnits: "imperial" });
  });

  it("pins the exact reverse event body and callback HMAC", async () => {
    const value = fixture.processingEvent;
    const signed = await signViewerProcessingEvent({
      secret: value.secret, method: value.method, path: value.path,
      body: value.body, timestamp: value.timestamp, nonce: value.nonce,
    });
    expect(signed.contentSha256).toBe(value.contentSha256);
    expect(signed.signature).toBe(value.signature);
    expect(JSON.parse(value.body)).toMatchObject({ requestedBySubject: "ops:staff-one" });
    expect(JSON.parse(value.body)).toEqual(routes.processingEvent);
  });

  it("pins actual Viewer list/detail response names without legacy DTO aliases", () => {
    const project = routes.projects.projects[0] as ViewerProcessingProject;
    const dataset = routes.datasets.datasets[0] as ViewerDatasetSummary;
    const task = routes.taskDetail.task as ViewerProcessingTask;
    const provider = routes.providers.providers[0] as ViewerProviderSummary;
    const attempt = routes.attemptDetail as ViewerProcessingAttemptDetail;
    const storage = routes.storage as ViewerStorageSummary;
    expect(project).toMatchObject({ defaultUnits: "imperial", status: "active", tags: ["survey"] });
    expect(dataset).toMatchObject({ sourceType: "upload", storageMode: "managed", status: "finalized", tags: ["flight-1"] });
    expect(dataset).not.toHaveProperty("state");
    expect(dataset).not.toHaveProperty("ownership");
    expect(task.latestAttempt).toMatchObject({ status: "running", errorCode: null, errorMessage: null });
    expect(task.latestAttempt).not.toHaveProperty("state");
    expect(provider).toMatchObject({
      lastHealth: "healthy", admissionLimit: 4, activeAttempts: 1,
      credential: { configured: true, updatedAt: "2027-01-15T07:30:00.000Z" },
    });
    expect(provider.credential).not.toHaveProperty("token");
    expect(provider.credential).not.toHaveProperty("ciphertext");
    expect(provider).not.toHaveProperty("health");
    expect(attempt.logs[0]).toMatchObject({ level: "info", created_at: expect.any(String) });
    expect(storage.trash.items[0]).toMatchObject({ entityType: "dataset", entityId: "dataset-old" });
    expect(storage.trash).toMatchObject({ totalCount: 1, totalBytes: 99, nextCursor: null });
    expect(Object.keys(routes.presets.presets[0]).sort()).toEqual(["builtIn", "capabilityFingerprint", "createdAt", "description", "displayName", "enabled", "id", "options", "providerType", "updatedAt"]);
    expect(routes.presets.presets[0]).toMatchObject({ providerType: "clusterodm", capabilityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), builtIn: false, enabled: true });
    expect(routes.tasks.tasks[0].latestAttempt).toMatchObject({ status: "running", providerOutputCursor: 0, capabilityFingerprint: null });
    expect(routes.projects.nextCursor).toBeNull();
    expect(routes.taskPatched.task).toMatchObject({
      id: routes.taskDetail.task.id,
      projectId: routes.taskDetail.task.projectId,
      datasetId: routes.taskDetail.task.datasetId,
      displayName: "Renamed map flight",
    });
    expect(routes.projectPatched.project).toMatchObject({
      id: project.id, displayName: "North site renamed", tags: ["survey", "priority"],
    });
    expect(routes.datasetPatched.dataset).toMatchObject({
      id: dataset.id, projectId: "project-two", rootKey: dataset.rootKey,
      relativePath: dataset.relativePath, manifestSha256: dataset.manifestSha256,
    });
  });

  it("pins aggregate storage accounting and managed output lifecycle shapes", () => {
    const projectStorage = routes.projectStorage as ViewerProjectStorageResponse;
    const taskStorage = routes.taskStorage as ViewerTaskStorageResponse;
    const output = routes.outputs.outputs[0] as ViewerOutputSummary;
    expect(projectStorage.project).toEqual({
      projectId: "project-one", datasetBytes: 1048576, outputBytes: 2097152, totalBytes: 3145728,
    });
    expect(projectStorage.tasks[0]).toEqual(taskStorage.task);
    expect(taskStorage.outputs[0]).toEqual(output);
    expect(routes.outputs).toMatchObject({ totalCount: 1, totalBytes: 2097152, nextCursor: null });
    expect(routes.outputArchived.output).toMatchObject({ id: output.id, modelId: output.modelId, status: "archived" });
    expect(routes.outputTrashed).toMatchObject({
      output: { id: output.id, status: "trashed" },
      trash: { entityType: "output", entityId: output.id, permanentlyDeletedAt: null },
    });
  });

  it("pins admin-only unpublished review issue and subject-scoped revoke shapes", () => {
    const created = routes.reviewSessionCreated;
    const grant = created.body as ViewerReviewSessionGrant;
    expect(created).toMatchObject({ status: 201, headers: { "Cache-Control": "no-store" } });
    expect(Object.keys(grant).sort()).toEqual([
      "assetKinds", "attemptId", "embedUrl", "grant", "grantExpiresAt", "modelId",
      "modelVersionId", "redeemUrl", "sessionMode", "sessionTtlSeconds",
    ]);
    expect(grant).toEqual({
      grant: "77777777-7777-4777-8777-777777777777",
      grantExpiresAt: "2027-01-15T08:50:00.000Z",
      sessionTtlSeconds: 900,
      sessionMode: "review",
      attemptId: "attempt-import-two",
      modelId: "model-one",
      modelVersionId: "version-import-two",
      assetKinds: ["ept", "glb"],
      redeemUrl: "https://viewer.example.test/api/v1/sessions/redeem",
      embedUrl: "https://viewer.example.test/session/77777777-7777-4777-8777-777777777777",
    });
    expect(routes.reviewSessionsRevoked).toEqual({
      status: 200,
      headers: { "Cache-Control": "no-store" },
      body: { attemptId: grant.attemptId, revokedGrants: 1, revokedSessions: 1 },
    });
    expect(grant).not.toHaveProperty("shareId");
    expect(grant).not.toHaveProperty("published");
  });

  it("pins durable finalize/import 202, Location, polling, and terminal result shapes", () => {
    const previewAccepted = routes.operations.importPreviewAccepted;
    const previewSucceeded = routes.operations.importPreviewSucceeded as ViewerDurableOperationResponse;
    const finalize = routes.operations.uploadFinalizeAccepted;
    const adopt = routes.operations.importAdoptAccepted;
    const succeeded = routes.operations.uploadFinalizeSucceeded as ViewerDurableOperationResponse;
    expect(previewAccepted).toMatchObject({ status: 202, headers: { "Retry-After": "2" } });
    expect(previewAccepted.headers.Location).toBe(`/api/v1/operations/${previewAccepted.body.operation.id}`);
    expect(previewAccepted.body.operation).toMatchObject({ type: "import_preview", datasetId: null, uploadId: null, status: "queued", result: null });
    expect(previewSucceeded.operation).toMatchObject({ type: "import_preview", status: "succeeded", datasetId: null, uploadId: null, progress: 1 });
    expect(previewSucceeded.operation.result).toEqual(routes.importPreview);
    expect(finalize).toMatchObject({ status: 202, headers: { "Retry-After": "2" } });
    expect(finalize.headers.Location).toBe(`/api/v1/operations/${finalize.body.operation.id}`);
    expect(finalize.body.operation).toMatchObject({ type: "upload_finalize", status: "queued", uploadId: expect.any(String), result: null });
    expect(adopt.headers.Location).toBe(`/api/v1/operations/${adopt.body.operation.id}`);
    expect(adopt.body.operation).toMatchObject({ type: "import_adopt", status: "queued", uploadId: null, result: null });
    expect(succeeded.operation).toMatchObject({ status: "succeeded", progress: 1, completedAt: expect.any(String) });
    expect(succeeded.operation.result && "dataset" in succeeded.operation.result ? succeeded.operation.result.dataset : null)
      .toMatchObject({ id: succeeded.operation.datasetId, status: "finalized" });
  });

  it("pins the normalized import storage preflight DTO without internal storage aliases", () => {
    const response = (routes.operations.importPreviewSucceeded as ViewerDurableOperationResponse).operation.result as ViewerDatasetImportPreview;
    expect(response).toMatchObject({
      id: expect.any(String), previewToken: expect.any(String), expiresAt: expect.any(String),
      preview: {
        treeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), truncated: false, sameFilesystem: true,
        files: [{ relativePath: "photo-001.jpg", byteSize: 1048576, mtimeMs: 1799999000000, ctimeMs: 1799999000000 }],
        destinationSpace: {
          availableBytes: 5368709120, totalBytes: 10737418240, reserveBytes: 1073741824,
          requiredBytes: 1048576, sufficient: true,
        },
      },
    });
    expect(Object.keys(response.preview.destinationSpace).sort()).toEqual([
      "availableBytes", "requiredBytes", "reserveBytes", "sufficient", "totalBytes",
    ]);
    expect(response.preview.destinationSpace).not.toHaveProperty("available");
    expect(response.preview.destinationSpace).not.toHaveProperty("ok");
  });
});
