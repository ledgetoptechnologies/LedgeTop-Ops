import { expect, test } from "@playwright/test";

const project = { id: "project-one", displayName: "North site", description: null, metadata: {}, tags: [], defaultUnits: "imperial", status: "active", createdBy: "ops:staff-one", createdAt: "2026-08-16T00:00:00Z", updatedAt: "2026-08-16T00:00:00Z", archivedAt: null };
const dataset = { id: "dataset-one", projectId: "project-one", displayName: "Flight one", description: null, sourceType: "upload", storageMode: "managed", rootKey: "datasets", relativePath: "flight-one", status: "finalized", manifestSha256: "a".repeat(64), fileCount: 1, byteSize: 10, metadata: {}, tags: [], createdBy: "ops:staff-one", createdAt: "2026-08-16T00:00:00Z", updatedAt: "2026-08-16T00:00:00Z", finalizedAt: "2026-08-16T00:00:00Z", archivedAt: null, trashedAt: null };
const task = { id: "task-one", projectId: "project-one", datasetId: "dataset-one", displayName: "Map flight one", description: null, status: "draft", activeAttemptId: null, publishedModelId: null, metadata: {}, createdBy: "ops:staff-one", createdAt: "2026-08-16T00:00:00Z", updatedAt: "2026-08-16T00:00:00Z", archivedAt: null, latestAttempt: null };
const point = { id: "gcp-point-one", setId: "gcp-set-one", externalId: "A", label: "Target A", latitude: 44.5, longitude: -88.1, elevationM: 243.84, description: null, createdAt: "2026-08-16T00:00:00Z", updatedAt: "2026-08-16T00:00:00Z" };
const set = { id: "gcp-set-one", datasetId: "dataset-one", displayName: "Control", sourceFormat: "generic-csv-v1", sourceFileId: null, sourceFilename: "control.csv", sourceSha256: "b".repeat(64), crs: "EPSG:4326", elevationUnits: "m", pointCount: 1, createdBy: "ops:staff-one", createdAt: "2026-08-16T00:00:00Z", updatedAt: "2026-08-16T00:00:00Z" };

test("ground control workspace is private, explicit about proximity, and usable on desktop and mobile", async ({ page }) => {
  let saved: Record<string, unknown> | null = null;
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === "viewer.ledgetopdroneservices.com") {
      if (url.pathname === "/api/v1/admin-sessions/redeem") return route.fulfill({ json: { accessToken: "a".repeat(43), session: { id: "session-one", subject: "ops:staff-one", permissions: ["viewer.projects.read","viewer.datasets.read","viewer.processing.read","viewer.providers.read","viewer.gcp.read","viewer.gcp.write"], expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }, units: { default: "imperial", resolved: "imperial" } } });
      if (url.pathname === "/api/v1/projects") return route.fulfill({ json: { projects: [project], nextCursor: null } });
      if (url.pathname === "/api/v1/datasets") return route.fulfill({ json: { datasets: [dataset], nextCursor: null } });
      if (url.pathname === "/api/v1/tasks") return route.fulfill({ json: { tasks: [task], nextCursor: null } });
      if (url.pathname === "/api/v1/processing/outputs") return route.fulfill({ json: { outputs: [], nextCursor: null, totalCount: 0, totalBytes: 0 } });
      if (url.pathname === "/api/v1/processing/providers") return route.fulfill({ json: { providers: [], nextCursor: null } });
      if (url.pathname === "/api/v1/processing/presets") return route.fulfill({ json: { presets: [] } });
      if (url.pathname === "/api/v1/storage") return route.fulfill({ json: { storage: {}, trash: { items: [], nextCursor: null, totalCount: 0, totalBytes: 0 } } });
      if (url.pathname === "/api/v1/datasets/dataset-one/gcp-sets") return route.fulfill({ json: { sets: [set] } });
      if (url.pathname === "/api/v1/gcp-sets/gcp-set-one") return route.fulfill({ json: { set, points: [point] } });
      if (url.pathname === "/api/v1/datasets/dataset-one/gcp-images") return route.fulfill({ json: { images: [{ id: "image-one", datasetId: "dataset-one", relativePath: "IMG_0001.JPG", mimeType: "image/png", capturedAt: "2026-08-16T00:00:00Z", latitude: 44.5001, longitude: -88.1001, altitudeM: 250, width: 1, height: 1, distanceM: 13.7 }], selectedPoint: point, ranking: { basis: "camera_gps_proximity", visibilityConfirmed: false, notice: "Nearby camera positions are suggestions only; proximity does not prove that the GCP is visible." } } });
      if (url.pathname === "/api/v1/tasks/task-one/gcp-correspondences" && request.method() === "GET") return route.fulfill({ json: { taskId: "task-one", datasetId: "dataset-one", correspondences: [] } });
      if (url.pathname === "/api/v1/tasks/task-one/gcp-correspondences" && request.method() === "POST") { const posted=request.postDataJSON() as Record<string,unknown>;saved = posted; return route.fulfill({ status: 201, json: { correspondence: { id: "mark-one", taskId: "task-one", pointId: "gcp-point-one", imageFileId: "image-one", pixelX: posted.pixelX, pixelY: posted.pixelY, createdBy: "ops:staff-one", createdAt: "2026-08-16T00:00:00Z", updatedAt: "2026-08-16T00:00:00Z" } } }); }
      if (url.pathname === "/api/v1/datasets/dataset-one/gcp-images/image-one/content") return route.fulfill({ contentType: "image/png", headers: { "Cache-Control": "private, no-store" }, body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") });
      return route.fulfill({ status: 404, json: { error: "Not found" } });
    }
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: "staff-one", email: "staff@example.test", displayName: "Staff", status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["viewer.view","viewer.datasets.manage","viewer.processing.manage"], divisions: [] }, csrfToken: "csrf", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, units: { default: "imperial", resolved: "imperial" }, capabilities: { viewerProcessing: { enabled: true } } } });
    if (url.pathname === "/api/viewer") return route.fulfill({ json: { enabled: true, publicSharesEnabled: false, models: [], projects: [], associations: [] } });
    if (url.pathname === "/api/viewer/processing") return route.fulfill({ json: { enabled: true, viewerBaseUrl: "https://viewer.ledgetopdroneservices.com", permissions: ["viewer.projects.read","viewer.datasets.read","viewer.processing.read","viewer.providers.read","viewer.gcp.read","viewer.gcp.write"], units: { default: "imperial", resolved: "imperial" }, events: [] } });
    if (url.pathname === "/api/viewer/admin-grant") return route.fulfill({ status: 201, json: { grant: "g".repeat(43), grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800, redeemUrl: "https://viewer.ledgetopdroneservices.com/api/v1/admin-sessions/redeem", units: { default: "imperial", resolved: "imperial" } } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/operations/processing");
  await page.getByRole("button", { name: "Ground control" }).click();
  await expect(page.getByRole("heading", { name: "Ground control workspace" })).toBeVisible();
  await expect(page.getByText("never eligible for client or public shares")).toBeVisible();
  await expect(page.getByText("Suggestion only:")).toBeVisible();
  await expect(page.getByText("proximity does not prove that the GCP is visible")).toBeVisible();
  await expect(page.getByText("800.00 ft")).toBeVisible();
  await expect(page.getByText("45 ft")).toBeVisible();
  await expect(page.getByText("Map unavailable because the Mapbox public token is not configured.")).toBeVisible();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const bounds = await page.getByRole("heading", { name: "Ground control workspace" }).boundingBox();
    expect(bounds && bounds.x + bounds.width <= width).toBe(true);
  }
  await page.getByLabel("Pixel X").fill("0");await page.getByLabel("Pixel Y").fill("0");
  await page.getByRole("button", { name: "Save mark" }).click();
  await expect.poll(() => saved).toMatchObject({ pointId: "gcp-point-one", imageFileId: "image-one", pixelX: 0, pixelY: 0 });
  await expect(page.getByText("Pixel correspondence saved.")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const minimum = await page.locator(".gcp-workspace button").evaluateAll(buttons => Math.min(...buttons.map(button => button.getBoundingClientRect().height)));
  expect(minimum).toBeGreaterThanOrEqual(42);
});
