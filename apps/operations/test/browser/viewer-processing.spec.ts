import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

test("processing controls remain usable at 320/390px and send metadata directly to Viewer", async ({ page }, testInfo) => {
  let operationsMetadata = 0, viewerMetadata = 0;
  let projectPatch: Record<string, unknown> | null = null, datasetPatch: Record<string, unknown> | null = null, outputTrash = false, importAdopt = false;
  let catalogScan = false, catalogMap: Record<string, unknown> | null = null, presetCreate: Record<string, unknown> | null = null;
  let previewStarts = 0, previewCancelled = false, allowPreviewCompletion = false;
  let reviewSessions = 0, reviewEmbedLoads = 0, reviewRevoked = false;
  const interruptedKey = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const interruptedOperationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const consoleErrors: string[] = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.route("https://viewer.ledgetopdroneservices.com/session/*", async route => {
    reviewEmbedLoads += 1;
    await route.fulfill({ contentType: "text/html", body: `<!doctype html><body><div id="review-camera">camera-review-42</div><script>
      const expiresAt = new Date(Date.now() + 10000).toISOString();
      addEventListener("message", event => {
        if (event.data?.type !== "ltds-viewer:renew-session") return;
        document.body.dataset.renewedGrant = event.data.grant;
        parent.postMessage({version:1,type:"ltds-viewer:session-renewed",modelId:"model-one",expiresAt:new Date(Date.now()+60000).toISOString()}, "*");
      });
      setTimeout(() => parent.postMessage({version:1,type:"ltds-viewer:ready",modelId:"model-one",expiresAt}, "*"), 50);
      setTimeout(() => parent.postMessage({version:1,type:"ltds-viewer:session-expiring",modelId:"model-one",expiresAt}, "*"), 100);
    </script></body>` });
  });
  await page.addInitScript(({ key, createdAt }) => localStorage.setItem("ltds.viewer.pending-operation-requests.v1", JSON.stringify([{
    version: 1, key, method: "POST", path: "/api/v1/processing/catalog-imports/scans", type: "catalog_scan",
    datasetId: null, uploadId: null, createdAt,
  }])), { key: interruptedKey, createdAt: new Date().toISOString() });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === "viewer.ledgetopdroneservices.com") {
      viewerMetadata += 1;
      if (url.pathname === "/api/v1/admin-sessions/redeem") return route.fulfill({ json: {
        accessToken: "a".repeat(43), session: { id: "session-one", subject: "ops:staff-one",
          permissions: ["viewer.projects.read","viewer.datasets.read","viewer.datasets.import","viewer.processing.read","viewer.providers.read"],
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() },
        units: { default: "imperial", resolved: "imperial" },
      } });
      const key = url.pathname.split("/").at(-1);
      const interruptedOperation = { id: interruptedOperationId, type: "catalog_scan", subject: "ops:staff-one", datasetId: null, uploadId: null, status: "queued", progress: 0, result: null, errorCode: null, errorMessage: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null };
      if (url.pathname === "/api/v1/attempts/attempt-one/review-sessions" && request.method() === "POST") {
        reviewSessions += 1;
        if (reviewSessions === 2) return route.fulfill({ status: 503, json: { error: "temporary review authorization failure" } });
        const grant = reviewSessions === 1 ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222";
        return route.fulfill({ status: 201, json: {
          grant, grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800,
          sessionMode: "review", attemptId: "attempt-one", modelId: "model-one", modelVersionId: "version-one", assetKinds: ["glb","tiles","ept"],
          redeemUrl: "https://viewer.ledgetopdroneservices.com/api/v1/sessions/redeem", embedUrl: `https://viewer.ledgetopdroneservices.com/session/${grant}`,
        } });
      }
      if (url.pathname === "/api/v1/attempts/attempt-one/review-sessions" && request.method() === "DELETE") { reviewRevoked = true; return route.fulfill({ json: { attemptId: "attempt-one", revokedGrants: 1, revokedSessions: 1 } }); }
      if (url.pathname === `/api/v1/operation-receipts/${interruptedKey}`) return route.fulfill({ json: { receipt: {
        subject: "ops:staff-one", key: interruptedKey, method: "POST", path: "/api/v1/processing/catalog-imports/scans",
        requestHash: "e".repeat(64), responseStatus: null, response: null, operationId: interruptedOperationId,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }, operation: interruptedOperation } });
      if (url.pathname === `/api/v1/operations/${interruptedOperationId}`) return route.fulfill({ json: { operation: {
        ...interruptedOperation, status: "succeeded", progress: 1,
        result: { scan: { id: "recovered-scan", provider: "webodm", generation: 1, candidateCount: 1, seenAt: new Date().toISOString() }, candidatesSeen: 1 },
        updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      } } });
      const candidate = { id: "candidate-one", provider: "webodm", externalProjectId: "34", externalTaskId: "abc-123", sourceRootKey: "webodm", sourceRelativePath: "project/34/task/abc-123", sourceFingerprint: "d".repeat(64), suggestedProjectName: "Wrightstown", suggestedTaskName: "August 2026 Survey", assetKinds: ["tiles","pointCloud"], state: catalogMap ? "mapped" : "unmapped", staleReason: null, scanGeneration: 1, lastSeenAt: "2026-08-16T00:00:00Z", mapping: catalogMap ? { projectId: "project-one", taskId: "imported-task", datasetId: "imported-dataset", attemptId: "imported-attempt", modelId: "imported-model", modelVersionId: "imported-version", mappedAt: "2026-08-16T00:00:00Z" } : null };
      if (url.pathname === "/api/v1/processing/catalog-imports/candidates") return route.fulfill({ json: { candidates: url.searchParams.get("state") === candidate.state ? [candidate] : [], nextCursor: null } });
      if (url.pathname === "/api/v1/processing/catalog-imports/scans" && request.method() === "POST") { catalogScan = true; return route.fulfill({ status: 202, headers: { Location: "/api/v1/operations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Retry-After": "2" }, json: { operation: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", type: "catalog_scan", subject: "ops:staff-one", datasetId: null, uploadId: null, status: "queued", progress: 0, result: null, errorCode: null, errorMessage: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null } } }); }
      if (url.pathname === "/api/v1/operations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb") return route.fulfill({ json: { operation: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", type: "catalog_scan", subject: "ops:staff-one", datasetId: null, uploadId: null, status: "succeeded", progress: 1, result: { scan: { id: "scan-one", provider: "webodm", generation: 1, candidateCount: 1, seenAt: new Date().toISOString() }, candidatesSeen: 1 }, errorCode: null, errorMessage: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: new Date().toISOString() } } });
      if (url.pathname === "/api/v1/processing/catalog-imports/candidates/candidate-one/map" && request.method() === "POST") { catalogMap = request.postDataJSON(); return route.fulfill({ status: 202, headers: { Location: "/api/v1/operations/cccccccc-cccc-4ccc-8ccc-cccccccccccc", "Retry-After": "2" }, json: { operation: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", type: "catalog_map", subject: "ops:staff-one", datasetId: null, uploadId: null, status: "queued", progress: 0, result: null, errorCode: null, errorMessage: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null } } }); }
      if (url.pathname === "/api/v1/operations/cccccccc-cccc-4ccc-8ccc-cccccccccccc") return route.fulfill({ json: { operation: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", type: "catalog_map", subject: "ops:staff-one", datasetId: null, uploadId: null, status: "succeeded", progress: 1, result: { project: { id: "project-one", displayName: "North site" }, task: { id: "imported-task", displayName: "August 2026 Survey" }, attempt: { id: "imported-attempt" }, model: { id: "imported-model" }, candidate: { ...candidate, state: "mapped", mapping: { projectId: "project-one", taskId: "imported-task", datasetId: "imported-dataset", attemptId: "imported-attempt", modelId: "imported-model", modelVersionId: "imported-version", mappedAt: new Date().toISOString() } } }, errorCode: null, errorMessage: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: new Date().toISOString() } } });
      if (url.pathname === "/api/v1/processing/presets" && request.method() === "POST") { presetCreate = request.postDataJSON(); return route.fulfill({ status: 201, json: { preset: { id: "preset-custom", ...presetCreate, description: null, builtIn: false, providerType: "clusterodm", capabilityFingerprint: "f".repeat(64), enabled: true } } }); }
      if (url.pathname === "/api/v1/projects/project-one" && request.method() === "PATCH") { projectPatch = request.postDataJSON(); return route.fulfill({ json: { project: { id: "project-one" } } }); }
      if (url.pathname === "/api/v1/projects/project-one/storage") return route.fulfill({ json: { project: { projectId: "project-one", datasetBytes: 10, outputBytes: 20, totalBytes: 30 }, tasks: [{ taskId: "task-one", projectId: "project-one", datasetBytes: 10, outputBytes: 20, totalBytes: 30 }], nextCursor: null } });
      if (url.pathname === "/api/v1/tasks/task-one/storage") return route.fulfill({ json: { task: { taskId: "task-one", projectId: "project-one", datasetBytes: 10, outputBytes: 20, totalBytes: 30 }, outputs: [{ id: "version-one", modelId: "model-one", taskId: "task-one", attemptId: "attempt-one", projectId: "project-one", displayName: "Map flight one", status: "archived", byteSize: 20, assetCount: 2, createdAt: "2026-08-16T00:00:00Z", updatedAt: "2026-08-16T00:00:00Z", archivedAt: "2026-08-16T00:00:00Z", trashedAt: null }], nextCursor: null } });
      if (url.pathname === "/api/v1/datasets/dataset-one" && request.method() === "PATCH") { datasetPatch = request.postDataJSON(); return route.fulfill({ json: { dataset: { id: "dataset-one" } } }); }
      if (url.pathname === "/api/v1/processing/outputs/version-one/archive" && request.method() === "DELETE") { outputTrash = true; return route.fulfill({ json: { output: { id: "version-one", status: "trashed" }, trash: { id: "trash-output" } } }); }
      if (url.pathname === "/api/v1/dataset-imports/preview" && request.method() === "POST") {
        previewStarts += 1;
        expect(request.postDataJSON()).toEqual({ rootKey: "dataset_import", relativePath: "north/import-flight" });
        const id = previewStarts === 1 ? "88888888-8888-4888-8888-888888888888" :
          previewStarts === 2 ? "99999999-9999-4999-8999-999999999999" : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        return route.fulfill({ status: 202, headers: { Location: `/api/v1/operations/${id}`, "Retry-After": "2", "Access-Control-Expose-Headers": "Location, Retry-After" }, json: { operation: {
          id, type: "import_preview", subject: "ops:staff-one", datasetId: null, uploadId: null,
          status: "queued", progress: 0, result: null, errorCode: null, errorMessage: null,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null,
        } } });
      }
      if (url.pathname === "/api/v1/operations/88888888-8888-4888-8888-888888888888/cancel" && request.method() === "POST") {
        previewCancelled = true;
        return route.fulfill({ json: { operation: {
          id: "88888888-8888-4888-8888-888888888888", type: "import_preview", subject: "ops:staff-one", datasetId: null, uploadId: null,
          status: "cancelled", progress: 0, result: null, errorCode: null, errorMessage: null,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        } } });
      }
      if (url.pathname === "/api/v1/operations/88888888-8888-4888-8888-888888888888") return route.fulfill({ json: { operation: {
        id: "88888888-8888-4888-8888-888888888888", type: "import_preview", subject: "ops:staff-one", datasetId: null, uploadId: null,
        status: "leased", progress: 0.25, result: null, errorCode: null, errorMessage: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null,
      } } });
      if (url.pathname === "/api/v1/operations/99999999-9999-4999-8999-999999999999" && !allowPreviewCompletion) return route.fulfill({ json: { operation: {
        id: "99999999-9999-4999-8999-999999999999", type: "import_preview", subject: "ops:staff-one", datasetId: null, uploadId: null,
        status: "leased", progress: 0.5, result: null, errorCode: null, errorMessage: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null,
      } } });
      if (url.pathname === "/api/v1/operations/99999999-9999-4999-8999-999999999999") return route.fulfill({ json: { operation: {
        id: "99999999-9999-4999-8999-999999999999", type: "import_preview", subject: "ops:staff-one", datasetId: null, uploadId: null,
        status: "succeeded", progress: 1, errorCode: null, errorMessage: null,
        result: {
          preview: { rootKey: "dataset_import", relativePath: "north/import-flight", fileCount: 3, byteSize: 30,
            treeFingerprint: "c".repeat(64),
            files: [{ relativePath: "IMG_0001.JPG", byteSize: 10, mtimeMs: 1799999000000, ctimeMs: 1799999000000 }], truncated: false, sameFilesystem: true,
            destinationSpace: { availableBytes: 1000, totalBytes: 2000, reserveBytes: 100, requiredBytes: 30, sufficient: true } },
          id: "77777777-7777-4777-8777-777777777777", previewToken: "p".repeat(43), expiresAt: new Date(Date.now() - 1_000).toISOString(),
        },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      } } });
      if (url.pathname === "/api/v1/operations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") return route.fulfill({ json: { operation: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", type: "import_preview", subject: "ops:staff-one", datasetId: null, uploadId: null,
        status: "succeeded", progress: 1, errorCode: null, errorMessage: null,
        result: {
          preview: { rootKey: "dataset_import", relativePath: "north/import-flight", fileCount: 3, byteSize: 30,
            treeFingerprint: "c".repeat(64),
            files: [{ relativePath: "IMG_0001.JPG", byteSize: 10, mtimeMs: 1799999000000, ctimeMs: 1799999000000 }], truncated: false, sameFilesystem: true,
            destinationSpace: { availableBytes: 1000, totalBytes: 2000, reserveBytes: 100, requiredBytes: 30, sufficient: true } },
          id: "77777777-7777-4777-8777-777777777777", previewToken: "q".repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      } } });
      if (url.pathname === "/api/v1/dataset-imports/adopt" && request.method() === "POST") { importAdopt = true; return route.fulfill({ status: 202, headers: { Location: "/api/v1/operations/44444444-4444-4444-8444-444444444444", "Retry-After": "2", "Access-Control-Expose-Headers": "Location, Retry-After" }, json: { operation: {
        id: "44444444-4444-4444-8444-444444444444", type: "import_adopt", subject: "ops:staff-one", datasetId: "55555555-5555-4555-8555-555555555555", uploadId: null,
        status: "queued", progress: 0, result: null, errorCode: null, errorMessage: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null,
      } } }); }
      if (url.pathname === "/api/v1/operations/44444444-4444-4444-8444-444444444444") return route.fulfill({ json: { operation: {
        id: "44444444-4444-4444-8444-444444444444", type: "import_adopt", subject: "ops:staff-one", datasetId: "55555555-5555-4555-8555-555555555555", uploadId: null,
        status: "succeeded", progress: 1, result: { dataset: {
          id: "55555555-5555-4555-8555-555555555555", projectId: "project-one", displayName: "import-flight", description: null,
          sourceType: "server_import", storageMode: "adopted", rootKey: "dataset_import", relativePath: "north/import-flight",
          status: "finalized", manifestSha256: "c".repeat(64), fileCount: 3, byteSize: 30, metadata: {}, tags: [],
          createdBy: "ops:staff-one", createdAt: "2026-08-16T00:00:00Z", updatedAt: "2026-08-16T00:00:00Z",
          finalizedAt: "2026-08-16T00:00:00Z", archivedAt: null, trashedAt: null,
        } },
        errorCode: null, errorMessage: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      } } });
      if (url.pathname === "/api/v1/datasets" && request.method() === "POST") return route.fulfill({ status: 201, json: { dataset: { id: "22222222-2222-4222-8222-222222222222", projectId: "project-one" } } });
      if (url.pathname.endsWith("/uploads") && request.method() === "POST") {
        const manifest = request.postDataJSON().files as Array<{ id: string; relativePath: string; byteSize: number; sha256: string }>;
        return route.fulfill({ status: 201, json: { upload: { id: "33333333-3333-4333-8333-333333333333", datasetId: "22222222-2222-4222-8222-222222222222", status: "open", chunkSize: 1024, expiresAt: new Date(Date.now() + 60_000).toISOString(), files: manifest.map(file => ({ ...file, chunkCount: 1, completedChunks: [], missingChunks: [0] })) }, uploadToken: "upload-token" } });
      }
      if (url.pathname.includes("/chunks/") && request.method() === "PUT") return route.fulfill({ status: 201, json: { chunk: { index: 0, byteSize: 10, sha256: "hash", replayed: false } } });
      if (url.pathname.endsWith("/finalize") && request.method() === "POST") return route.fulfill({ status: 202, headers: { Location: "/api/v1/operations/11111111-1111-4111-8111-111111111111", "Retry-After": "2", "Access-Control-Expose-Headers": "Location, Retry-After" }, json: { operation: {
        id: "11111111-1111-4111-8111-111111111111", type: "upload_finalize", subject: "ops:staff-one",
        datasetId: "22222222-2222-4222-8222-222222222222", uploadId: "33333333-3333-4333-8333-333333333333",
        status: "queued", progress: 0, result: null, errorCode: null, errorMessage: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null,
      } } });
      if (url.pathname === "/api/v1/operations/11111111-1111-4111-8111-111111111111") return route.fulfill({ json: { operation: {
        id: "11111111-1111-4111-8111-111111111111", type: "upload_finalize", subject: "ops:staff-one",
        datasetId: "22222222-2222-4222-8222-222222222222", uploadId: "33333333-3333-4333-8333-333333333333",
        status: "succeeded", progress: 1, result: { dataset: {
          id: "22222222-2222-4222-8222-222222222222", projectId: "66666666-6666-4666-8666-666666666666",
          displayName: "Worker hash smoke test", description: null, sourceType: "upload", storageMode: "managed",
          rootKey: "datasets", relativePath: "flight", status: "finalized", manifestSha256: "a".repeat(64),
          fileCount: 1, byteSize: 10, metadata: {}, tags: [], createdBy: "ops:staff-one",
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finalizedAt: new Date().toISOString(),
          archivedAt: null, trashedAt: null,
        } },
        errorCode: null, errorMessage: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      } } });
      if (key === "projects") return route.fulfill({ json: { projects: [{ id: url.searchParams.has("cursor") ? "project-two" : "project-one", displayName: url.searchParams.has("cursor") ? "South site" : "North site", description: null, metadata: {}, tags: [], defaultUnits: "imperial", status: "active", createdBy: "ops:staff-one", createdAt: "2026-08-16T00:00:00Z", updatedAt: "2026-08-16T00:00:00Z", archivedAt: null }], nextCursor: url.searchParams.has("cursor") ? null : "opaque-next" } });
      if (key === "datasets") return route.fulfill({ json: { datasets: [{ id: "dataset-one", projectId: "project-one", displayName: "Flight one", description: null, sourceType: "upload", storageMode: "managed", rootKey: "datasets", relativePath: "flight-one", status: "finalized", manifestSha256: "a".repeat(64), fileCount: 1, byteSize: 10, metadata: {}, tags: [], createdBy: "ops:staff-one", createdAt: "2026-08-16T00:00:00Z", updatedAt: "2026-08-16T00:00:00Z", finalizedAt: "2026-08-16T00:00:00Z", archivedAt: null, trashedAt: null }], nextCursor: null } });
      if (key === "tasks") return route.fulfill({ json: { tasks: [{ id: "task-one", projectId: "project-one", datasetId: "dataset-one", displayName: "Map flight one", description: null, status: "ready_for_review", activeAttemptId: "attempt-one", publishedModelId: null, metadata: {}, createdBy: "ops:staff-one", createdAt: "2026-08-16T00:00:00Z", updatedAt: "2026-08-16T00:00:00Z", archivedAt: null, latestAttempt: { id: "attempt-one", taskId: "task-one", datasetId: "dataset-one", attemptNumber: 1, providerId: "provider-one", providerTaskId: null, presetId: null, options: {}, status: "ready_for_review", progress: 1, providerOutputCursor: 0, capabilityFingerprint: null, errorCode: null, errorMessage: null, resultModelId: "model-one", resultModelVersionId: "version-one", createdBy: "ops:staff-one", createdAt: "2026-08-16T00:00:00Z", updatedAt: "2026-08-16T00:00:00Z", startedAt: null, upstreamCompletedAt: null, ingestedAt: null, completedAt: null } }], nextCursor: null } });
      if (key === "outputs") return route.fulfill({ json: { outputs: [{ id: "version-one", modelId: "model-one", taskId: "task-one", attemptId: "attempt-one", projectId: "project-one", displayName: "Map flight one", status: "archived", byteSize: 20, assetCount: 2, createdAt: "2026-08-16T00:00:00Z", updatedAt: "2026-08-16T00:00:00Z", archivedAt: "2026-08-16T00:00:00Z", trashedAt: null }], nextCursor: null, totalCount: 1, totalBytes: 20 } });
      if (key === "providers") return route.fulfill({ json: { providers: [{ id: "provider-one", displayName: "Cluster", type: "clusterodm", endpoint: "http://nodeodm:3000", enabled: true, admissionLimit: 4, activeAttempts: 0, credential: { configured: true, updatedAt: "2026-08-16T00:00:00Z" }, capabilities: { apiVersion: "1", engine: "ODM", engineVersion: "2.2.3", maxImages: null, maxParallelTasks: null, taskQueueCount: 0, totalMemory: null, availableMemory: null, cpuCores: null, providerType: "clusterodm", testedBaseline: "1.5.5", compatibilityWarning: null, options: [{ name: "dsm", type: "bool", domain: [true,false], help: "Generate DSM", value: false }, { name: "orthophoto-resolution", type: "float", domain: { min: 1, max: 20 }, help: "Orthophoto resolution", value: 5 }] }, capabilityFingerprint: "f".repeat(64), lastHealth: "healthy", lastHealthAt: "2026-08-16T00:00:00Z", createdAt: "2026-08-16T00:00:00Z", updatedAt: "2026-08-16T00:00:00Z" }], nextCursor: null } });
      if (key === "presets") return route.fulfill({ json: { presets: [] } });
      if (key === "attempt-one") return route.fulfill({ json: { attempt: { id: "attempt-one", taskId: "task-one", datasetId: "dataset-one", attemptNumber: 1, providerId: "provider-one", providerTaskId: null, presetId: null, options: {}, status: "ready_for_review", progress: 1, providerOutputCursor: 0, errorCode: null, errorMessage: null, resultModelId: "model-one", resultModelVersionId: "version-one", createdBy: "ops:staff-one", createdAt: "2026-08-16T00:00:00Z", updatedAt: "2026-08-16T00:00:00Z", startedAt: null, upstreamCompletedAt: null, ingestedAt: null, completedAt: null }, logs: [] } });
      if (key === "storage") return route.fulfill({ json: { storage: {
        datasets: { available: 900, total: 1000, reserve: 100, required: 0, ok: true },
        models: { available: 900, total: 1000, reserve: 100, required: 0, ok: true },
        cache: { available: 900, total: 1000, reserve: 100, required: 0, ok: true },
        trash: { available: 900, total: 1000, reserve: 100, required: 0, ok: true },
      }, trash: { items: [], nextCursor: null, totalCount: 0, totalBytes: 0 } } });
      return route.fulfill({ status: 404, json: { error: "Not found" } });
    }
    operationsMetadata += 1;
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: {
      id: "staff-one", email: "staff@example.test", displayName: "Staff", status: "Active",
      profileType: "Administrator", isAdministrator: true,
      permissions: ["viewer.view","viewer.datasets.manage","viewer.processing.manage","viewer.publish"], divisions: [],
    }, csrfToken: "csrf", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null,
      units: { default: "imperial", resolved: "imperial" }, capabilities: { viewerProcessing: { enabled: true } } } });
    if (url.pathname === "/api/viewer") return route.fulfill({ json: { enabled: true, publicSharesEnabled: false, models: [], projects: [], associations: [] } });
    if (url.pathname === "/api/viewer/processing") return route.fulfill({ json: { enabled: true,
      viewerBaseUrl: "https://viewer.ledgetopdroneservices.com",
      permissions: ["viewer.projects.read","viewer.projects.write","viewer.datasets.read","viewer.datasets.write","viewer.datasets.import","viewer.processing.read","viewer.processing.write","viewer.processing.publish","viewer.providers.read","viewer.providers.write"],
      units: { default: "imperial", resolved: "imperial" }, events: [] } });
    if (url.pathname === "/api/viewer/admin-grant") return route.fulfill({ status: 201, json: {
      grant: "g".repeat(43), grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800,
      redeemUrl: "https://viewer.ledgetopdroneservices.com/api/v1/admin-sessions/redeem",
      units: { default: "imperial", resolved: "imperial" },
    } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/operations/processing?attemptId=attempt-one");
  await expect(page.getByRole("heading", { name: "Processing platform" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Projects" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Requested processing review" })).toBeVisible();
  await page.getByRole("button", { name: "Recover accepted requests" }).click();
  await expect(page.getByText(/1 accepted operation restored/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Recover accepted requests" })).toHaveCount(0);
  await page.getByRole("button", { name: "Resume status" }).click();
  await expect(page.getByText(/Scan 1 found 1 candidate/)).toBeVisible();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Projects" }).click();
  await expect(page.getByText("North site")).toBeVisible();
  await page.getByText("North site").locator("xpath=ancestor::article").getByText("Storage accounting").click();
  await expect(page.getByText("30 B total").first()).toBeVisible();
  await page.getByText("North site").locator("xpath=ancestor::article").getByText("Edit project").click();
  await page.getByText("North site").locator("xpath=ancestor::article").getByLabel("Description").fill("Updated project description");
  await page.getByText("North site").locator("xpath=ancestor::article").getByLabel("Tags (comma or line separated)").fill("survey, priority");
  await page.getByText("North site").locator("xpath=ancestor::article").getByRole("button", { name: "Save project" }).click();
  await expect.poll(() => projectPatch).toMatchObject({ description: "Updated project description", tags: ["survey", "priority"] });
  await expect(page.getByText("Project catalog updated without changing its stable ID.")).toBeVisible();
  await page.getByRole("button", { name: "Load 50 more" }).focus();
  await page.getByRole("button", { name: "Load 50 more" }).press("Enter");
  await expect(page.getByText("South site")).toBeVisible();
  await page.getByRole("button", { name: "Datasets" }).click();
  await expect(page.getByRole("heading", { name: "Datasets" })).toBeVisible();
  await page.getByText("Flight one").locator("xpath=ancestor::article").getByText("Edit dataset catalog").click();
  await page.getByText("Flight one").locator("xpath=ancestor::article").getByLabel("Catalog project").selectOption("project-two");
  page.once("dialog", dialog => dialog.accept());
  await page.getByText("Flight one").locator("xpath=ancestor::article").getByRole("button", { name: "Save dataset" }).click();
  await expect.poll(() => datasetPatch).toMatchObject({ projectId: "project-two" });
  await expect(page.getByText("Dataset catalog reassociated; immutable source storage and manifest are unchanged.")).toBeVisible();
  await page.getByLabel("Dataset name").fill("Worker hash smoke test");
  const datasetDirectory = testInfo.outputPath("drone-dataset");
  await mkdir(datasetDirectory, { recursive: true });
  await writeFile(`${datasetDirectory}/IMG_0001.JPG`, "drone-data");
  await page.getByLabel("Drone dataset folder").setInputFiles(datasetDirectory);
  await page.getByRole("button", { name: "Upload dataset" }).click();
  await expect(page.getByText("Dataset finalized. The source manifest is now immutable.")).toBeVisible();
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "Preview unpublished model" }).click();
  const reviewFrame = page.frameLocator('iframe[title="3D model: Map flight one — unpublished review"]');
  await expect(reviewFrame.locator("#review-camera")).toHaveText("camera-review-42");
  await expect(page.getByText("Viewer renewal is retrying…")).toBeVisible();
  await expect(reviewFrame.locator("#review-camera")).toHaveText("camera-review-42");
  await expect(reviewFrame.locator("body")).toHaveAttribute("data-renewed-grant", "22222222-2222-4222-8222-222222222222", { timeout: 5_000 });
  expect(reviewSessions).toBe(3); expect(reviewEmbedLoads).toBe(1);
  await page.getByRole("button", { name: "Close viewer" }).click();
  await expect.poll(() => reviewRevoked).toBe(true);
  await page.getByText("Map flight one").locator("xpath=ancestor::article").getByText("Task storage & model outputs").click();
  await expect(page.getByText("20 B outputs").first()).toBeVisible();
  await page.getByRole("button", { name: "Outputs" }).click();
  await expect(page.getByText("Map flight one")).toBeVisible();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Trash output" }).click();
  await expect.poll(() => outputTrash).toBe(true);
  await page.getByRole("button", { name: "Imports" }).click();
  await expect(page.getByText("August 2026 Survey")).toBeVisible();
  await page.getByRole("button", { name: "Scan WebODM" }).click();
  await expect.poll(() => catalogScan).toBe(true);
  await page.getByText("August 2026 Survey").locator("xpath=ancestor::article").getByText("Map into LTDS").click();
  await page.getByText("August 2026 Survey").locator("xpath=ancestor::article").getByRole("button", { name: "Map and register model" }).click();
  await expect.poll(() => catalogMap).toMatchObject({ projectId: "project-one", taskDisplayName: "August 2026 Survey", storageMode: "external_reference" });
  await page.getByLabel("Relative path").fill("north/import-flight");
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(page.getByText(/Inspecting source content: 25%/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel preview scan" }).click();
  await expect.poll(() => previewCancelled).toBe(true);
  await expect(page.getByText("Import preview cancelled.")).toBeVisible();
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(page.getByText(/Inspecting source content: 50%/)).toBeVisible();
  await page.getByRole("button", { name: "Projects" }).click();
  await expect(page.getByRole("button", { name: "Load 50 more" })).toBeEnabled();
  allowPreviewCompletion = true;
  await page.reload();
  // The attemptId deep link intentionally selects Tasks after bootstrap; the
  // durable checkpoint must still resume when Imports remounts after reload.
  await page.getByRole("button", { name: "Imports" }).click();
  await expect(page.getByText("Import preview expired. The source must be inspected again before adoption.")).toBeVisible();
  await page.getByRole("button", { name: "Preview again" }).click();
  await expect(page.getByText("Storage reserve passes.")).toBeVisible();
  await expect(page.getByText("30 B required · 1000 B available of 2.0 KB · 100 B reserved")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm import" })).toBeEnabled();
  await page.getByRole("button", { name: "Confirm import" }).click();
  await expect.poll(() => importAdopt).toBe(true);
  await expect(page.getByText("Dataset import completed and indexed.")).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Friendly name").fill("LTDS Standard");
  await page.getByText("Terrain/DEM").click();
  await page.getByLabel(/Generate DSM/).selectOption("false");
  await page.getByRole("button", { name: "Save custom preset" }).click();
  await expect.poll(() => presetCreate).toMatchObject({ displayName: "LTDS Standard", providerId: "provider-one", options: { dsm: false } });
  expect(previewStarts).toBe(3);
  expect(consoleErrors.filter(message => /worker-src|content security policy/i.test(message))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(viewerMetadata).toBeGreaterThanOrEqual(6);
  expect(operationsMetadata).toBeLessThan(viewerMetadata);
});
