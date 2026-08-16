import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

test("processing controls remain usable at 390px and send metadata directly to Viewer", async ({ page }, testInfo) => {
  let operationsMetadata = 0, viewerMetadata = 0;
  const consoleErrors: string[] = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === "viewer.ledgetopdroneservices.com") {
      viewerMetadata += 1;
      if (url.pathname === "/api/v1/admin-sessions/redeem") return route.fulfill({ json: {
        accessToken: "a".repeat(43), session: { id: "session-one", subject: "ops:staff-one",
          permissions: ["viewer.projects.read","viewer.datasets.read","viewer.processing.read","viewer.providers.read"],
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() },
        units: { default: "imperial", resolved: "imperial" },
      } });
      const key = url.pathname.split("/").at(-1);
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
          fileCount: 1, byteSize: 10, metadata: {}, createdBy: "ops:staff-one",
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finalizedAt: new Date().toISOString(),
          archivedAt: null, trashedAt: null,
        } },
        errorCode: null, errorMessage: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      } } });
      if (key === "projects") return route.fulfill({ json: { projects: [{ id: url.searchParams.has("cursor") ? "project-two" : "project-one", displayName: url.searchParams.has("cursor") ? "South site" : "North site", description: null, metadata: {}, defaultUnits: "imperial", status: "active", createdBy: "ops:staff-one", createdAt: "2026-08-16T00:00:00Z", updatedAt: "2026-08-16T00:00:00Z", archivedAt: null }], nextCursor: url.searchParams.has("cursor") ? null : "opaque-next" } });
      if (key === "datasets") return route.fulfill({ json: { datasets: [], nextCursor: null } });
      if (key === "tasks") return route.fulfill({ json: { tasks: [], nextCursor: null } });
      if (key === "providers") return route.fulfill({ json: { providers: [], nextCursor: null } });
      if (key === "presets") return route.fulfill({ json: { presets: [] } });
      if (key === "attempt-one") return route.fulfill({ json: { attempt: { id: "attempt-one", taskId: "task-one", attemptNumber: 1, providerId: "provider-one", providerTaskId: null, presetId: null, options: {}, status: "ready_for_review", progress: 1, providerOutputCursor: 0, errorCode: null, errorMessage: null, resultModelId: null, resultModelVersionId: null, createdBy: "ops:staff-one", createdAt: "2026-08-16T00:00:00Z", updatedAt: "2026-08-16T00:00:00Z", startedAt: null, upstreamCompletedAt: null, ingestedAt: null, completedAt: null }, logs: [] } });
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
      permissions: ["viewer.projects.read","viewer.projects.write","viewer.datasets.read","viewer.datasets.write","viewer.processing.read","viewer.processing.write","viewer.processing.publish","viewer.providers.read","viewer.providers.write"],
      units: { default: "imperial", resolved: "imperial" }, events: [] } });
    if (url.pathname === "/api/viewer/admin-grant") return route.fulfill({ status: 201, json: {
      grant: "g".repeat(43), grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800,
      redeemUrl: "https://viewer.ledgetopdroneservices.com/api/v1/admin-sessions/redeem",
      units: { default: "imperial", resolved: "imperial" },
    } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/viewer?attempt=attempt-one");
  await expect(page.getByRole("heading", { name: "Processing platform" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Projects" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Requested processing review" })).toBeVisible();
  await page.getByRole("button", { name: "Projects" }).click();
  await expect(page.getByText("North site")).toBeVisible();
  await page.getByRole("button", { name: "Load 50 more" }).focus();
  await page.getByRole("button", { name: "Load 50 more" }).press("Enter");
  await expect(page.getByText("South site")).toBeVisible();
  await page.getByRole("button", { name: "Datasets" }).click();
  await expect(page.getByRole("heading", { name: "Datasets" })).toBeVisible();
  await page.getByLabel("Dataset name").fill("Worker hash smoke test");
  const datasetDirectory = testInfo.outputPath("drone-dataset");
  await mkdir(datasetDirectory, { recursive: true });
  await writeFile(`${datasetDirectory}/IMG_0001.JPG`, "drone-data");
  await page.getByLabel("Drone dataset folder").setInputFiles(datasetDirectory);
  await page.getByRole("button", { name: "Upload dataset" }).click();
  await expect(page.getByText("Dataset finalized. The source manifest is now immutable.")).toBeVisible();
  expect(consoleErrors.filter(message => /worker-src|content security policy/i.test(message))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(viewerMetadata).toBeGreaterThanOrEqual(6);
  expect(operationsMetadata).toBeLessThan(viewerMetadata);
});
