import { expect, test, type Page, type Request } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DeliveryLocationCollection } from "@ltds/shared";
import type { PortalAccount, PortalFilePage, PortalServiceDraft, PortalServiceRequest } from "../../src/client/portal-api";

const account = { id: "account-a", displayName: "Acme Surveying" };
const projects = [{ id: "project-a", externalRef: "ALPHA-1", clientName: "Acme", projectName: "North Site", canRequestService: true, status: "in_progress", summary: "Aerial progress documentation", siteAddress: null, serviceAddress: "100 Main St", projectContactName: "LTDS Operations", projectContactEmail: "ops@example.com", projectContactPhone: null, nextMilestone: "Spring progress imagery", lastUpdateAt: "2026-08-01T12:00:00.000Z" }];
const filePage = { files: [{ id: "file-a", name: "final.pdf", size: 2048, uploadedAt: "2026-08-01T12:00:00.000Z", contentType: "application/pdf", kind: "pdf" as const, previewPath: "/api/client/files/file-a/preview?projectId=project-a", thumbnailPath: "/api/client/files/file-a/thumbnail?projectId=project-a", downloadPath: "/api/client/files/file-a/download?projectId=project-a" }], prefix: "", cursor: null };
const seekableMp4 = readFileSync(fileURLToPath(new URL("../fixtures/client-portal-seek.mp4", import.meta.url)));
const requests: PortalServiceRequest[] = [{
  id: "request-a",
  projectId: "project-a",
  requestType: "flight" as const,
  title: "North Site monthly progress imagery",
  details: "Existing request",
  location: null,
  preferredStartAt: null,
  status: "submitted",
  createdAt: "2026-07-31T12:00:00.000Z",
  updatedAt: "2026-07-31T12:00:00.000Z",
}];
const serviceCatalog = [{
  publicId: "svc-2d-map",
  sourceVersion: "pa-v4",
  name: "2D Mapping",
  summary: "Orthomosaic mapping and site coverage.",
  category: "Mapping",
  displayOrder: 10,
  geometryRequirement: "optional" as const,
  questions: [{ id: "resolution", label: "Preferred resolution", type: "select", required: true, helpText: "Choose the best fit; LTDS will confirm feasibility.", options: [{ value: "standard", label: "Standard" }, { value: "survey", label: "Survey detail" }] }],
}];

async function mockAuthorizedPortal(
  page: Page,
  mapboxPublicToken: string | null = null,
  fixtureRequests = requests,
  workflowEvents?: { edited?: boolean; changeRequested?: boolean; estimateAccepted?: boolean; cancelled?: boolean;
    cancellationKeys?: string[]; failFirstCancellation?: boolean },
  locationFixtures: { project: DeliveryLocationCollection; past: DeliveryLocationCollection } = {
    project: { points: [], imageCount: 0, truncated: false },
    past: { points: [], imageCount: 0, truncated: false },
  },
  requestV2 = true,
  requestAttachments = false,
  attachmentEvents?: { workerBinaryBytes: number; directBytes: number; completed: boolean; scanAccepted: boolean; scanRejected?: boolean; scanExpired?: boolean; removed?: boolean },
  projectFileFixture?: (url: URL) => PortalFilePage | Promise<PortalFilePage>,
  accountFixture: PortalAccount = account,
) {
  let draftVersion = 1;
  let draftBody: Record<string, unknown> | null = null;
  await page.route("**/api/client/**", async route => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const path = requestUrl.pathname;
    if (request.method() === "GET" && path === "/api/client/session") {
      await route.fulfill({ json: { account: accountFixture, capabilities: { manageTeam: true, viewBilling: false, requestV2, requestAttachments, invitationEmailDelivery: true } } });
    } else if (request.method() === "GET" && path === "/api/client/map-config") {
      await route.fulfill({ json: { mapboxPublicToken } });
    } else if (request.method() === "GET" && path === "/api/client/projects") {
      await route.fulfill({ json: { projects } });
    } else if (request.method() === "GET" && path === "/api/client/service-requests") {
      await route.fulfill({ json: { requests: fixtureRequests } });
    } else if (request.method() === "GET" && path === "/api/client/service-catalog") {
      await route.fulfill({ json: { services: serviceCatalog } });
    } else if (request.method() === "GET" && path === "/api/client/service-catalog/page") {
      await route.fulfill({ json: { services: serviceCatalog, nextCursor: null, complete: true, source: { generation: "catalog-test", sequence: 1 } } });
    } else if (request.method() === "GET" && path === "/api/client/request-readiness") {
      const projectId = requestUrl.searchParams.get("projectId");
      await route.fulfill({ json: { mode: requestV2 ? "catalog" : "legacy", workspaceId: null, target: { kind: projectId ? "project" : "root", projectId }, canStartRequest: true, reason: "ready", root: { canStartRequest: true, reason: "ready" }, projectRequestsSupported: true, refreshedAt: "2026-08-25T12:00:00.000Z" } });
    } else if (request.method() === "GET" && path === "/api/client/service-request-drafts") {
      await route.fulfill({ json: { drafts: [] } });
    } else if (request.method() === "POST" && path === "/api/client/service-request-drafts") {
      expect(request.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      draftBody = request.postDataJSON();
      await route.fulfill({ status: 201, json: { draft: { ...draftBody, id: "draft-a", state: "draft", version: draftVersion, areaSquareMeters: draftBody?.areaGeoJson ? 50585.7 : null, areaAcres: draftBody?.areaGeoJson ? 12.5 : null, services: serviceCatalog.filter(service => (draftBody?.services as Array<{ publicId: string }> | undefined)?.some(selected => selected.publicId === service.publicId)).map(service => ({ ...service, answers: (draftBody?.services as Array<{ publicId: string; answers: Record<string, unknown> }>).find(selected => selected.publicId === service.publicId)?.answers ?? {} })), submittedRequestId: null, createdAt: "2026-08-13T12:00:00.000Z", updatedAt: "2026-08-13T12:00:00.000Z" } } });
    } else if (request.method() === "PUT" && path === "/api/client/service-request-drafts/draft-a") {
      expect(request.headers()["if-match"]).toBe(String(draftVersion));
      expect(request.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      draftBody = request.postDataJSON();
      draftVersion += 1;
      await route.fulfill({ json: { draft: { ...draftBody, id: "draft-a", state: "draft", version: draftVersion, areaSquareMeters: draftBody?.areaGeoJson ? 50585.7 : null, areaAcres: draftBody?.areaGeoJson ? 12.5 : null, services: serviceCatalog.filter(service => (draftBody?.services as Array<{ publicId: string }> | undefined)?.some(selected => selected.publicId === service.publicId)).map(service => ({ ...service, answers: (draftBody?.services as Array<{ publicId: string; answers: Record<string, unknown> }>).find(selected => selected.publicId === service.publicId)?.answers ?? {} })), submittedRequestId: null, createdAt: "2026-08-13T12:00:00.000Z", updatedAt: "2026-08-13T12:01:00.000Z" } } });
    } else if (request.method() === "GET" && path === "/api/client/service-request-drafts/draft-a" && draftBody) {
      await route.fulfill({ json: { draft: { ...draftBody, id: "draft-a", state: "draft", version: draftVersion, areaSquareMeters: draftBody.areaGeoJson ? 50585.7 : null, areaAcres: draftBody.areaGeoJson ? 12.5 : null,
        services: serviceCatalog.filter(service => (draftBody!.services as Array<{ publicId: string }>).some(selected => selected.publicId === service.publicId)).map(service => ({ ...service, answers: (draftBody!.services as Array<{ publicId: string; answers: Record<string, unknown> }>).find(selected => selected.publicId === service.publicId)?.answers ?? {} })),
        submittedRequestId: null, createdAt: "2026-08-13T12:00:00.000Z", updatedAt: "2026-08-13T12:01:00.000Z" } } });
    } else if (request.method() === "GET" && path === "/api/client/service-request-drafts/draft-a/pricing-hint") {
      await route.fulfill({ json: { available: false, hint: null } });
    } else if (request.method() === "POST" && path === "/api/client/service-request-drafts/draft-a/submit") {
      expect(request.headers()["if-match"]).toBe(String(draftVersion));
      expect(request.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      await route.fulfill({ status: 201, json: { request: { ...requests[0], id: "request-created", projectId: draftBody?.projectId ?? null, title: draftBody?.title, details: draftBody?.details, requestType: "service" } } });
    } else if (requestAttachments && request.method() === "POST" && path === "/api/client/service-request-drafts/draft-a/attachments") {
      const body = request.postDataJSON();
      if (attachmentEvents && request.headers()["content-type"] !== "application/json") attachmentEvents.workerBinaryBytes += request.postDataBuffer()?.byteLength ?? 0;
      expect(body).toMatchObject({ name: "authorization.pdf", contentType: "application/pdf" });
      await route.fulfill({ status: 201, json: { attachmentId: "attachment-a", name: body.name, contentType: body.contentType, size: body.size, status: "uploading", partSize: 8 * 1024 * 1024, completedParts: [], resumed: false } });
    } else if (requestAttachments && request.method() === "POST" && path === "/api/client/service-request-drafts/draft-a/attachments/attachment-a/part-ticket") {
      await route.fulfill({ json: { url: "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com/client-data/quarantine/object?signature=secret", expiresAt: "2026-08-13T13:00:00.000Z", method: "PUT", partNumber: 1, contentLength: 18, contentType: "application/pdf", headers: { "Content-Type": "application/pdf" } } });
    } else if (requestAttachments && request.method() === "PUT" && path === "/api/client/service-request-drafts/draft-a/attachments/attachment-a/parts/1") {
      expect(request.postDataJSON()).toEqual({ etag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"', size: 18 });
      await route.fulfill({ json: { partNumber: 1, etag: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", size: 18 } });
    } else if (requestAttachments && request.method() === "POST" && path === "/api/client/service-request-drafts/draft-a/attachments/attachment-a/complete") {
      if (attachmentEvents) attachmentEvents.completed = true;
      await route.fulfill({ json: { status: "quarantined", idempotent: false } });
    } else if (requestAttachments && request.method() === "GET" && path === "/api/client/service-request-drafts/draft-a/attachments/attachment-a") {
      await route.fulfill({ json: { attachmentId: "attachment-a", id: "attachment-a", name: "authorization.pdf", contentType: "application/pdf", size: 18, status: attachmentEvents?.scanRejected ? "rejected" : attachmentEvents?.scanExpired ? "expired" : attachmentEvents?.scanAccepted ? "accepted" : "scanning", partSize: 8 * 1024 * 1024, completedParts: [] } });
    } else if (requestAttachments && request.method() === "DELETE" && path === "/api/client/service-request-drafts/draft-a/attachments/attachment-a") {
      if (attachmentEvents) attachmentEvents.removed = true;
      await route.fulfill({ json: { ok: true, status: "aborted", idempotent: false } });
    } else if (request.method() === "GET" && path === "/api/client/notifications") {
      await route.fulfill({ json: { notifications: [{ id: "notice-a", eventType: "files_added", title: "New files available", body: "Files were added to your LTDS client workspace.", actionPath: "/portal/deliveries", readAt: null, createdAt: "2026-08-13T12:00:00.000Z" }], unreadCount: 1, cursor: null } });
    } else if (request.method() === "PATCH" && path === "/api/client/notifications/notice-a") {
      expect(request.postDataJSON()).toMatchObject({ action: expect.stringMatching(/read|dismiss/) });
      await route.fulfill({ json: { success: true } });
    } else if (request.method() === "GET" && path === "/api/client/projects/project-a/files") {
      await route.fulfill({ json: projectFileFixture ? await projectFileFixture(requestUrl) : filePage });
    } else if (request.method() === "GET" && path === "/api/client/projects/project-a/file-locations") {
      await route.fulfill({ json: locationFixtures.project });
    } else if (request.method() === "GET" && path === "/api/client/past-deliveries") {
      await route.fulfill({ json: { ...filePage, files: [{ ...filePage.files[0], id: "file-history", name: "historic-orthomosaic.tif", previewPath: null, downloadPath: "/api/client/files/file-history/download" }] } });
    } else if (request.method() === "GET" && path === "/api/client/past-delivery-locations") {
      await route.fulfill({ json: locationFixtures.past });
    } else if (request.method() === "POST" && path === "/api/client/service-requests") {
      expect(request.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(request.postDataJSON()).toMatchObject({ projectId: "project-a", requestType: "service", title: "North Site spring imagery" });
      await route.fulfill({ status: 201, json: { request: { ...requests[0], id: "request-created", title: "North Site spring imagery", requestType: "service" } } });
    } else if (request.method() === "PATCH" && path === "/api/client/service-requests/request-a") {
      expect(request.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(request.headers()["if-match"]).toBe(fixtureRequests[0]?.updatedAt);
      const body = request.postDataJSON();
      if (workflowEvents) workflowEvents.edited = true;
      await route.fulfill({ json: { request: { ...fixtureRequests[0], ...body, id: "request-a", updatedAt: "2026-08-01T13:00:00.000Z" } } });
    } else if (request.method() === "POST" && path === "/api/client/service-requests/request-b/change-request") {
      expect(request.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      if (workflowEvents) workflowEvents.changeRequested = true;
      await route.fulfill({ status: 201, json: { request: { ...fixtureRequests[1], ...request.postDataJSON(), id: "request-child", parentRequestId: "request-b", status: "submitted" } } });
    } else if (request.method() === "POST" && path === "/api/client/service-requests/request-b/estimate-response") {
      expect(request.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(request.postDataJSON()).toMatchObject({ estimateId: "estimate-b", response: "accept" });
      if (workflowEvents) workflowEvents.estimateAccepted = true;
      await route.fulfill({ json: { request: { ...fixtureRequests[1], operationalEstimate: { ...fixtureRequests[1]?.operationalEstimate, status: "accepted" } } } });
    } else if (request.method() === "POST" && path === "/api/client/service-requests/request-a/cancel") {
      const cancellationKey = request.headers()["idempotency-key"];
      expect(cancellationKey).toMatch(/^[0-9a-f-]{36}$/);
      expect(request.postData()).toBeNull();
      workflowEvents?.cancellationKeys?.push(cancellationKey!);
      if (workflowEvents?.failFirstCancellation && workflowEvents.cancellationKeys?.length === 1)
        return route.fulfill({ status: 503, json: { error: "Cancellation response was interrupted" } });
      if (workflowEvents) workflowEvents.cancelled = true;
      await route.fulfill({ json: { request: { ...fixtureRequests[0], status: "cancelled", updatedAt: "2026-08-01T14:00:00.000Z" } } });
    } else {
      await route.fulfill({ status: 404, json: { error: "Not found" } });
    }
  });
}

async function startNewRequest(page: Page, context = "general") {
  await page.getByLabel("Request context", { exact: true }).selectOption(context);
  await page.getByRole("button", { name: "Start request", exact: true }).click();
}

async function openRequestWorkArea(page: Page, context = "general") {
  await startNewRequest(page, context);
  await page.getByRole("button", { name: "Mapping 1 service", exact: true }).click();
  await page.getByRole("checkbox", { name: /2D Mapping/ }).check();
  await page.getByLabel("Preferred resolution").selectOption("standard");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Show us the work area" })).toBeVisible();
}

async function mockMapbox(page: Page) {
  await page.route("https://api.mapbox.com/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/styles/v1/")) {
      await route.fulfill({ json: { version: 8, name: "LTDS test style", sources: {}, layers: [] } });
    } else if (url.pathname.includes("/search/geocode/v6/forward")) {
      await route.fulfill({ json: { features: [
        { id: "address.1", geometry: { type: "Point", coordinates: [-88.071, 44.501] }, properties: { full_address: "100 Main Street, Green Bay, Wisconsin 54301", place_formatted: "Green Bay, Wisconsin" } },
        { id: "address.2", geometry: { type: "Point", coordinates: [-88.083, 44.513] }, properties: { full_address: "100 Main Avenue, Green Bay, Wisconsin 54303", place_formatted: "Green Bay, Wisconsin" } },
      ] } });
    } else if (url.pathname.includes("/search/geocode/v6/reverse")) {
      await route.fulfill({ json: { features: [
        { id: "street.1", properties: { name: "Broadway", place_formatted: "Green Bay, Wisconsin" } },
      ] } });
    } else {
      await route.fulfill({ status: 204, body: "" });
    }
  });
  await page.route("https://events.mapbox.com/**", route => route.fulfill({ status: 204, body: "" }));
}

async function navigatePortal(page: Page, label: "Projects" | "Deliveries" | "Requests") {
  const trigger = page.getByRole("button", { name: "Open navigation" });
  const desktopNavigation = page.getByRole("navigation", { name: "Client portal" });
  // The application shell is route-split. Wait for one responsive navigation
  // variant to mount before deciding which one is active; a synchronous
  // isVisible() can otherwise observe neither during the lazy-module boundary.
  await expect(trigger.or(desktopNavigation)).toBeVisible();
  if (await trigger.isVisible()) {
    await trigger.click();
    await page.getByRole("dialog", { name: "Navigation" }).getByRole("link", { name: label }).click();
  } else {
    await desktopNavigation.getByRole("link", { name: label }).click();
  }
}

test("portal identifies an unfinished schema update and retries cleanly on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let sessionAttempts = 0;
  await page.route("**/api/client/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/client/session") {
      sessionAttempts += 1;
      if (sessionAttempts === 1) return route.fulfill({ status: 503, json: {
        error: "Client portal data is temporarily unavailable while its database update finishes.",
        code: "CLIENT_PORTAL_SCHEMA_OUTDATED",
      } });
      return route.fulfill({ json: { account, capabilities: {} } });
    }
    if (path === "/api/client/projects") return route.fulfill({ json: { projects } });
    if (path === "/api/client/service-requests") return route.fulfill({ json: { requests } });
    if (path === "/api/client/map-config") return route.fulfill({ json: { mapboxPublicToken: null } });
    if (path === "/api/client/notifications") return route.fulfill({ json: { notifications: [], unreadCount: 0, cursor: null } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/portal");
  await expect(page.getByText("Portal update in progress", { exact: true })).toBeVisible();
  await expect(page.getByText(/access is valid/i)).toBeVisible();
  await page.getByRole("button", { name: "Retry portal" }).click();
  await expect(page.getByRole("heading", { name: "Welcome, Acme Surveying" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("client-created links use opaque authorized targets and remain usable on desktop and mobile", async ({ page }) => {
  let created = false;
  let revoked = false;
  await page.route("**/api/client/**", async route => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const path = requestUrl.pathname;
    if (path === "/api/client/session") return route.fulfill({ json: { account, capabilities: { workspaceHierarchyV2: true, delegatedShares: true } } });
    if (path === "/api/client/v2/workspaces") return route.fulfill({ json: { workspaces: [{ id: "workspace-00000001", rootType: "organization", rootPublicId: "pa-org-one", displayName: "Acme" }] } });
    if (path === "/api/client/projects") return route.fulfill({ json: { projects } });
    if (path === "/api/client/service-requests") return route.fulfill({ json: { requests } });
    if (path === "/api/client/map-config") return route.fulfill({ json: { mapboxPublicToken: null } });
    if (path === "/api/client/notifications") return route.fulfill({ json: { notifications: [], unreadCount: 0, cursor: null } });
    if (path === "/api/client/past-deliveries") return route.fulfill({ json: { files: [], prefix: "", cursor: null } });
    if (path === "/api/client/past-delivery-locations") return route.fulfill({ json: { points: [], imageCount: 0, truncated: false } });
    if (path.endsWith("/delegated-share-targets")) return route.fulfill({ json: { targets: [{
      delegationId: "delegation-0000001", folderTargetId: "target-child-00001",
      displayName: "Client photos", maximumLinkLifetimeSeconds: 604800,
      requirePassword: false, delegationExpiresAt: "2099-01-01T00:00:00.000Z",
    }], creation: { enabled: true } } });
    if (path.endsWith("/delegated-shares") && request.method() === "GET") return route.fulfill({ json: { shares: created && !revoked ? [{
      id: "client-share-000001", publicId: "cs_public_00000000001", path: "/client-share/cs_public_00000000001",
      label: "Subcontractor review", status: "active", expiresAt: "2026-08-15T12:00:00.000Z",
      revokedAt: null, createdAt: "2026-08-13T12:00:00.000Z",
    }] : [], creation: { enabled: true } } });
    if (path.endsWith("/delegated-shares") && request.method() === "POST") {
      const body = request.postDataJSON();
      expect(body).toMatchObject({ delegationId: "delegation-0000001", folderTargetId: "target-child-00001", label: "Subcontractor review" });
      expect(JSON.stringify(body)).not.toContain("clients/");
      expect(request.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      created = true;
      return route.fulfill({ status: 201, json: { share: {
        id: "client-share-000001", publicId: "cs_public_00000000001",
        path: "/client-share/cs_public_00000000001",
        shareUrl: "https://client.example.test/client-share/cs_public_00000000001#private-fragment-00000000000000000000001",
        label: "Subcontractor review", status: "active", passwordProtected: false,
        expiresAt: body.expiresAt, createdAt: "2026-08-13T12:00:00.000Z",
      } } });
    }
    if (path.endsWith("/delegated-shares/client-share-000001") && request.method() === "DELETE") {
      expect(request.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      revoked = true;
      return route.fulfill({ json: { revoked: true, replayed: false } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/portal/deliveries");
  await expect(page.getByRole("heading", { name: "Client-created public links" })).toBeVisible();
  await expect(page.getByLabel("Approved folder")).toHaveValue("delegation-0000001:target-child-00001");
  await page.getByLabel("Link label (optional)").fill("Subcontractor review");
  await page.getByLabel("Expires").fill("2026-08-15T07:00");
  await page.getByRole("button", { name: "Create public link" }).click();
  await expect(page.getByText("Link created — copy it now")).toBeVisible();
  await expect(page.getByLabel("New client public link")).toHaveValue(/\/client-share\/cs_public_.*#private-fragment/);
  await expect(page.locator("body")).not.toContainText("clients/private");

  await page.setViewportSize({ width: 390, height: 844 });
  const form = page.locator(".portal-delegated-share-form");
  await expect(form).toBeVisible();
  expect((await form.boundingBox())!.width).toBeLessThanOrEqual(390);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("No client-created links yet.")).toBeVisible();
  expect(revoked).toBe(true);
});

test("workspace-v2 selection scopes every authenticated resource request and switches without a full refresh", async ({ page }) => {
  const observed: Array<{ path: string; workspace: string | undefined }> = [];
  await page.route("**/api/client/**", async route => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const path = requestUrl.pathname;
    const workspace = request.headers()["x-ltds-workspace-id"];
    observed.push({ path, workspace });
    if (path === "/api/client/session") {
      await route.fulfill({ json: { account: { id: "", displayName: workspace === "workspace-b" ? "Beta" : "Alpha" }, capabilities: { workspaceHierarchyV2: true } } });
    } else if (path === "/api/client/v2/workspaces") {
      expect(workspace).toBeUndefined();
      await route.fulfill({ json: { workspaces: [
        { id: "workspace-a", rootType: "organization", rootPublicId: "pa-org-a", displayName: "Alpha" },
        { id: "workspace-b", rootType: "standalone_client", rootPublicId: "pa-client-b", displayName: "Beta" },
      ] } });
    } else if (path === "/api/client/projects") {
      await route.fulfill({ json: { projects: [{ ...projects[0], id: workspace === "workspace-b" ? "project-b" : "project-a", projectName: workspace === "workspace-b" ? "Beta Site" : "North Site" }] } });
    } else if (path === "/api/client/service-requests") {
      await route.fulfill({ json: { requests: [] } });
    } else if (path === "/api/client/map-config") {
      await route.fulfill({ json: { mapboxPublicToken: null } });
    } else if (path === "/api/client/notifications") {
      await route.fulfill({ json: { notifications: [], unreadCount: 0, cursor: null } });
    } else await route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/portal");
  await expect(page.getByRole("heading", { name: "Welcome, Alpha" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Client workspace" })).toHaveValue("workspace-a");
  expect(observed.filter(item => ["/api/client/projects", "/api/client/service-requests", "/api/client/map-config", "/api/client/notifications"].includes(item.path)).every(item => item.workspace === "workspace-a")).toBe(true);

  await page.getByRole("combobox", { name: "Client workspace" }).selectOption("workspace-b");
  await expect(page.getByRole("heading", { name: "Welcome, Beta" })).toBeVisible();
  await expect(page.getByText("Beta Site")).toBeVisible();
  expect(observed.filter(item => item.path === "/api/client/projects").at(-1)?.workspace).toBe("workspace-b");
  await expect(page).toHaveURL(/\/portal\?workspace=workspace-b$/);
});

test("authorized portal supports project, delivery, and request workflows", async ({ page }) => {
  await mockAuthorizedPortal(page);
  await page.goto("/portal");
  await expect(page.getByRole("heading", { name: "Welcome, Acme Surveying" })).toBeVisible();
  await expect(page.getByText("1", { exact: true }).first()).toBeVisible();

  await navigatePortal(page, "Projects");
  await expect(page.getByRole("heading", { name: "North Site" })).toBeVisible();
  await expect(page.getByText("Aerial progress documentation")).toBeVisible();
  await page.getByRole("button", { name: /North Site/ }).click();
  await expect(page.getByRole("heading", { name: "North Site" })).toBeVisible();
  await page.getByRole("button", { name: "Files" }).click();
  await expect(page.getByText("final.pdf")).toBeVisible();
  await expect(page.getByRole("link", { name: "Download" })).toHaveAttribute("href", "/api/client/files/file-a/download?projectId=project-a");

  await navigatePortal(page, "Deliveries");
  await expect(page.getByText("historic-orthomosaic.tif")).toBeVisible();

  await navigatePortal(page, "Requests");
  await expect(page.getByRole("heading", { name: "Request history" })).toBeVisible();
  await expect(page.getByText("North Site monthly progress imagery")).toBeVisible();
  await expect(page.getByLabel("Service request title")).toHaveCount(0);
  await page.getByRole("button", { name: "Submit new request" }).click();
  await expect(page).toHaveURL(/\/portal\/requests\/new$/);
  await openRequestWorkArea(page, "project:project-a");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Service request title").fill("North Site spring imagery");
  await page.getByLabel("What do you need?").fill("Capture the latest grading progress.");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Supporting files are coming soon")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Review your request" })).toBeVisible();
  await expect(page.getByText("Final quote after review")).toBeVisible();
  await page.getByRole("button", { name: "Submit request" }).click();
  await expect(page).toHaveURL(/\/portal\/requests$/);
  await expect(page.getByText("North Site spring imagery")).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("authenticated video preview uses native controls and supports seeking with range delivery", async ({ page }) => {
  const videoFile = {
    ...filePage.files[0]!,
    id: "video-file-a",
    name: "flight.mp4",
    size: seekableMp4.length,
    contentType: "video/mp4",
    kind: "video" as const,
    previewPath: "/media/client-portal-seek.mp4",
    thumbnailPath: null,
    downloadPath: "/api/client/files/video-file-a/download?projectId=project-a",
  };
  await mockAuthorizedPortal(page, null, requests, undefined, undefined, true, false, undefined,
    () => ({ files: [videoFile], folders: [], prefix: "", cursor: null }));
  const observedRanges: string[] = [];
  await page.route("**/media/client-portal-seek.mp4", async route => {
    const range = route.request().headers().range;
    if (!range) {
      await route.fulfill({ status: 200, contentType: "video/mp4", headers: {
        "Accept-Ranges": "bytes", "Content-Length": String(seekableMp4.length),
      }, body: seekableMp4 });
      return;
    }
    observedRanges.push(range);
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    expect(match).not.toBeNull();
    const start = Number(match![1]);
    const end = match![2] ? Math.min(Number(match![2]), seekableMp4.length - 1) : seekableMp4.length - 1;
    const body = seekableMp4.subarray(start, end + 1);
    await route.fulfill({ status: 206, contentType: "video/mp4", headers: {
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${seekableMp4.length}`,
      "Content-Length": String(body.length),
    }, body });
  });

  await page.goto("/portal/projects/project-a?tab=files");
  await expect(page.getByText("flight.mp4", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Preview" }).click();
  const dialog = page.getByRole("dialog", { name: "Preview flight.mp4" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".portal-file-preview-stage")).toHaveCSS("background-color", "rgb(13, 20, 26)");
  const video = dialog.locator("video");
  await expect(video).toHaveAttribute("controls", "");
  await expect(video).toHaveAttribute("playsinline", "");
  await expect(video).toHaveAttribute("preload", "metadata");
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);
  await video.evaluate(async element => {
    const media = element as HTMLVideoElement;
    await media.play();
    media.pause();
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("seek timed out")), 3_000);
      media.addEventListener("seeked", () => { window.clearTimeout(timer); resolve(); }, { once: true });
      media.currentTime = 1.5;
    });
  });
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(1.25);
  expect(observedRanges.length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Close preview" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
});

test("autosaved service-request drafts resume after navigation and reload", async ({ page }) => {
  await mockAuthorizedPortal(page);
  const draftService: PortalServiceDraft["services"][number] = {
    ...serviceCatalog[0]!,
    questions: serviceCatalog[0]!.questions.map(question => ({ ...question, type: "select" as const })),
    answers: { resolution: "standard" },
  };
  let resumed: PortalServiceDraft = {
    id: "draft-resume",
    state: "draft",
    version: 3,
    projectId: "project-a",
    requestType: "service",
    title: "North Site resumed mapping",
    details: "Resume this saved mapping request after checking the work area.",
    location: "North Site",
    preferredStartAt: "2026-09-01T15:30:00.000Z",
    deliverables: "Orthomosaic and overview imagery",
    siteContactName: "Jordan Client",
    siteContactEmail: "jordan@example.com",
    siteContactPhone: "555-0100",
    desiredCompletionAt: "2026-09-05T20:00:00.000Z",
    latitude: 41.88,
    longitude: -87.63,
    areaGeoJson: null,
    poiPoints: [{ longitude: -87.63, latitude: 41.88, label: "North gate" }],
    areaSquareMeters: null,
    areaAcres: null,
    services: [draftService],
    submittedRequestId: null,
    createdAt: "2026-08-13T12:00:00.000Z",
    updatedAt: "2026-08-14T12:00:00.000Z",
  };
  await page.route("**/api/client/service-request-drafts**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/client/service-request-drafts") {
      return route.fulfill({ json: { drafts: [{ id: resumed.id, projectId: resumed.projectId, title: resumed.title, serviceNames: ["2D Mapping"], areaAcres: resumed.areaAcres, updatedAt: resumed.updatedAt }] } });
    }
    if (request.method() === "GET" && path === `/api/client/service-request-drafts/${resumed.id}`) {
      return route.fulfill({ json: { draft: resumed } });
    }
    if (request.method() === "PUT" && path === `/api/client/service-request-drafts/${resumed.id}`) {
      expect(request.headers()["if-match"]).toBe(String(resumed.version));
      const body = request.postDataJSON();
      resumed = {
        ...resumed,
        ...body,
        version: resumed.version + 1,
        updatedAt: "2026-08-14T12:05:00.000Z",
        services: resumed.services.filter(service => (body.services as Array<{ publicId: string }>).some(selected => selected.publicId === service.publicId)).map(service => ({ ...service, answers: (body.services as Array<{ publicId: string; answers: Record<string, unknown> }>).find(selected => selected.publicId === service.publicId)?.answers ?? {} })),
      };
      return route.fulfill({ json: { draft: resumed } });
    }
    if (request.method() === "GET" && path === `/api/client/service-request-drafts/${resumed.id}/pricing-hint`) {
      return route.fulfill({ json: { available: false, hint: null } });
    }
    return route.fallback();
  });

  await page.goto("/portal/requests");
  await expect(page.getByRole("heading", { name: "Saved drafts" })).toBeVisible();
  await expect(page.getByText("North Site resumed mapping")).toBeVisible();
  await page.getByRole("button", { name: "Continue draft" }).click();
  await expect(page).toHaveURL(/\/portal\/requests\/new\?draft=draft-resume/);
  await expect(page.getByLabel("Preferred resolution")).toHaveValue("standard");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Service request title")).toHaveValue("North Site resumed mapping");
  const saved = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/client/service-request-drafts/draft-resume");
  await page.getByLabel("Service request title").fill("North Site resumed mapping - updated");
  await saved;
  await page.reload();
  await expect(page).toHaveURL(/draft=draft-resume.*step=details|step=details.*draft=draft-resume/);
  await expect(page.getByLabel("Service request title")).toHaveValue("North Site resumed mapping - updated");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("catalog refresh preserves the saved service version until the client explicitly reselects", async ({ page }) => {
  await mockAuthorizedPortal(page);
  const currentService = {
    ...serviceCatalog[0]!,
    sourceVersion: "pa-v5",
    questions: [{ id: "format", label: "Delivery format", type: "select" as const, required: true, helpText: "Choose the current output.", options: [{ value: "geotiff", label: "GeoTIFF" }] }],
  };
  let catalogChanged = false;
  let selectedCurrent = false;
  await page.route("**/api/client/service-catalog/page", route => route.fulfill({ json: { services: catalogChanged ? [currentService] : serviceCatalog, nextCursor: null, complete: true, source: { generation: "catalog-test", sequence: catalogChanged ? 2 : 1 } } }));
  await page.route("**/api/client/service-request-drafts/draft-a", async route => {
    if (route.request().method() !== "PUT" || !catalogChanged) return route.fallback();
    const body = route.request().postDataJSON();
    const selected = (body.services as Array<{ publicId: string; sourceVersion: string; answers: Record<string, unknown> }>)[0]!;
    if (selected.sourceVersion === "pa-v4") return route.fulfill({ status: 409, json: {
      error: "One or more selected services changed in the Project Alpha service library. Review and reselect them before continuing.",
      code: "catalog_changed",
      servicePublicIds: [selected.publicId],
    } });
    selectedCurrent = selected.sourceVersion === "pa-v5";
    return route.fulfill({ json: { draft: {
      ...body, id: "draft-a", state: "draft", version: 50, areaSquareMeters: null, areaAcres: null,
      services: [{ ...currentService, answers: selected.answers }], submittedRequestId: null,
      createdAt: "2026-08-13T12:00:00.000Z", updatedAt: "2026-08-14T12:00:00.000Z",
    } } });
  });

  await page.goto("/portal/requests/new");
  await openRequestWorkArea(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Service request title").fill("Pinned catalog version");
  await page.getByLabel("What do you need?").fill("Keep the approved service snapshot until I review the replacement.");
  await expect(page.getByText("Draft saved")).toBeVisible();

  catalogChanged = true;
  await page.getByLabel("Service request title").fill("Pinned catalog version updated");
  await expect(page.getByText(/service library changed/i)).toBeVisible();
  await page.getByRole("button", { name: "Services" }).click();
  await expect(page.getByText("This service changed in Project Alpha.")).toBeVisible();
  await expect(page.getByLabel("Preferred resolution")).toHaveValue("standard");
  await expect(page.getByLabel("Delivery format")).toHaveCount(0);

  await page.getByRole("button", { name: "Use current service version" }).click();
  await expect(page.getByLabel("Delivery format")).toBeVisible();
  await page.getByLabel("Delivery format").selectOption("geotiff");
  await expect.poll(() => selectedCurrent).toBe(true);
});

test("project folders are keyboard accessible and restore opaque history/deep links", async ({ page }) => {
  const fixture = (url: URL): PortalFilePage => {
    const folder = url.searchParams.get("folder");
    if (folder === "pf1_nested") return {
      files: [{ ...filePage.files[0]!, id: "nested-file", name: "nested.pdf" }], folders: [], prefix: "", cursor: null,
      folderId: folder, breadcrumbs: [{ id: null, name: "Project files" }, { id: "pf1_alpha", name: "Alpha files" }, { id: folder, name: "Nested plans" }],
    };
    if (folder === "pf1_alpha") return {
      files: [{ ...filePage.files[0]!, id: "alpha-file", name: "alpha-summary.pdf" }],
      folders: [{ id: "pf1_nested", name: "Nested plans" }], prefix: "", cursor: null,
      folderId: folder, breadcrumbs: [{ id: null, name: "Project files" }, { id: folder, name: "Alpha files" }],
    };
    return { files: [], folders: [{ id: "pf1_alpha", name: "Alpha files" }, { id: "pf1_beta", name: "Beta files" }],
      breadcrumbs: [{ id: null, name: "Project files" }], folderId: null, prefix: "", cursor: null };
  };
  await mockAuthorizedPortal(page, null, requests, undefined, undefined, true, false, undefined, fixture);
  await page.goto("/portal/projects/project-a?tab=files");
  const alpha = page.getByRole("button", { name: /Alpha files/ });
  await alpha.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/tab=files&folder=pf1_alpha/);
  await expect(page.getByText("alpha-summary.pdf")).toBeVisible();
  await page.getByRole("button", { name: /Nested plans/ }).click();
  await expect(page).toHaveURL(/folder=pf1_nested/);
  await expect(page.getByText("nested.pdf")).toBeVisible();
  await page.goBack();
  await expect(page.getByText("alpha-summary.pdf")).toBeVisible();
  await page.goBack();
  await expect(alpha).toBeVisible();
  await page.goForward();
  await expect(page.getByText("alpha-summary.pdf")).toBeVisible();
  await page.goto("/portal/projects/project-a?tab=files&folder=pf1_nested");
  await expect(page.getByText("nested.pdf")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Project file folders" })).toContainText("Alpha files");
});

test("project files progressively paint 1200 immediate children with one request in flight on mobile", async ({ page }) => {
  let inFlight = 0;
  let maximumInFlight = 0;
  let pageCalls = 0;
  const fixture = async (url: URL): Promise<PortalFilePage> => {
    const folder = url.searchParams.get("folder");
    if (folder !== "pf1_mass") return { files: [], folders: [{ id: "pf1_mass", name: "Large deliverable set" }],
      breadcrumbs: [{ id: null, name: "Project files" }], folderId: null, prefix: "", cursor: null };
    inFlight += 1;
    maximumInFlight = Math.max(maximumInFlight, inFlight);
    pageCalls += 1;
    await new Promise(resolve => setTimeout(resolve, 8));
    const pageIndex = Number(url.searchParams.get("cursor") ?? "0");
    const files = Array.from({ length: 150 }, (_, offset) => {
      const index = pageIndex * 150 + offset;
      return { ...filePage.files[0]!, id: `mass-${index}`, name: `file-${String(index).padStart(4, "0")}.pdf` };
    });
    inFlight -= 1;
    return { files, folders: [], breadcrumbs: [{ id: null, name: "Project files" }, { id: folder, name: "Large deliverable set" }],
      folderId: folder, prefix: "", cursor: pageIndex < 7 ? String(pageIndex + 1) : null };
  };
  await mockAuthorizedPortal(page, null, requests, undefined, undefined, true, false, undefined, fixture);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/portal/projects/project-a?tab=files");
  await page.getByRole("button", { name: /Large deliverable set/ }).click();
  await expect(page.getByText("file-0000.pdf")).toBeVisible();
  await expect(page.locator(".portal-file-row")).toHaveCount(150);
  await expect.poll(() => pageCalls).toBe(2);
  await expect(page.getByText("file-0150.pdf")).toHaveCount(0);
  for (let pageNumber = 2; pageNumber <= 8; pageNumber += 1) {
    const button = page.getByRole("button", { name: "Load more" });
    await expect(button).toBeEnabled();
    await button.evaluate((element: HTMLButtonElement) => element.click());
    await expect(page.getByText(`file-${String(pageNumber * 150 - 1).padStart(4, "0")}.pdf`)).toBeVisible();
  }
  await expect(page.getByText("file-1199.pdf")).toBeVisible();
  await expect(page.locator(".portal-file-row")).toHaveCount(450);
  await expect(page.getByRole("button", { name: "Show earlier files" })).toBeVisible();
  expect({ pageCalls, maximumInFlight }).toEqual({ pageCalls: 8, maximumInFlight: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("leaving a folder aborts a continuation and ignores its stale result", async ({ page }) => {
  let continuationStarted = false;
  const fixture = async (url: URL): Promise<PortalFilePage> => {
    const folder = url.searchParams.get("folder");
    if (folder !== "pf1_long") return { files: [], folders: [{ id: "pf1_long", name: "Long folder" }],
      breadcrumbs: [{ id: null, name: "Project files" }], folderId: null, prefix: "", cursor: null };
    const pageIndex = Number(url.searchParams.get("cursor") ?? "0");
    if (pageIndex === 1) {
      continuationStarted = true;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return {
      files: [{ ...filePage.files[0]!, id: `continuation-${pageIndex}`, name: pageIndex === 1 ? "stale-late.pdf" : `page-${pageIndex}.pdf` }],
      folders: [], breadcrumbs: [{ id: null, name: "Project files" }, { id: folder, name: "Long folder" }],
      folderId: folder, prefix: "", cursor: pageIndex < 2 ? String(pageIndex + 1) : null,
    };
  };
  await mockAuthorizedPortal(page, null, requests, undefined, undefined, true, false, undefined, fixture);
  await page.goto("/portal/projects/project-a?tab=files");
  await page.getByRole("button", { name: /Long folder/ }).click();
  await expect.poll(() => continuationStarted).toBe(true);
  await page.getByRole("button", { name: "Project files" }).click();
  await expect(page.getByRole("button", { name: /Long folder/ })).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.getByText("stale-late.pdf")).toHaveCount(0);
});

test("catalog geometry contract is visible and blocks progress until a required work area is drawn", async ({ page }) => {
  await mockAuthorizedPortal(page);
  await page.route("**/api/client/service-catalog/page", route => route.fulfill({
    json: { services: [{ ...serviceCatalog[0], geometryRequirement: "required" }], nextCursor: null, complete: true, source: { generation: "catalog-test", sequence: 1 } },
  }));
  await page.goto("/portal/requests/new");
  await openRequestWorkArea(page);
  await expect(page.getByText(/One or more selected services require a drawn work area/)).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Draw the required work area on the map before continuing.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Scope and timing" })).toHaveCount(0);
});

test("desktop portal navigation uses the client IA and restores routes with browser history", async ({ page }) => {
  await mockAuthorizedPortal(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/portal");
  const navigation = page.getByRole("navigation", { name: "Client portal" });
  await expect(navigation.getByRole("link")).toHaveText(["Home", "Projects", "Deliveries", "Requests"]);
  await expect(navigation.getByRole("link", { name: "Account" })).toHaveCount(0);
  await navigation.getByRole("link", { name: "Projects" }).click();
  await expect(page).toHaveURL(/\/portal\/projects$/);
  await expect(navigation.getByRole("link", { name: "Projects" })).toHaveAttribute("aria-current", "page");
  await navigation.getByRole("link", { name: "Deliveries" }).click();
  await expect(page).toHaveURL(/\/portal\/deliveries$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/portal\/projects$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/portal\/deliveries$/);
  await page.getByRole("button", { name: "Account menu for Acme Surveying" }).click();
  await page.getByRole("menu", { name: "Account" }).getByRole("menuitem", { name: "Account" }).click();
  await expect(page).toHaveURL(/\/portal\/account$/);
});

test("account identity menu provides same-origin Access logout on desktop and mobile", async ({ page }) => {
  await mockAuthorizedPortal(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/portal");
  const trigger = page.getByRole("button", { name: "Account menu for Acme Surveying" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  let menu = page.getByRole("menu", { name: "Account" });
  await expect(menu.getByRole("menuitem", { name: "Account" })).toBeFocused();
  await expect(menu.getByRole("menuitem", { name: "Logout" })).toHaveAttribute("href", "/cdn-cgi/access/logout");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Space");
  menu = page.getByRole("menu", { name: "Account" });
  await expect(menu).toBeVisible();
  await page.getByRole("navigation", { name: "Client portal" }).getByRole("link", { name: "Home" }).focus();
  await expect(menu).toHaveCount(0);

  await page.setViewportSize({ width: 320, height: 740 });
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveCSS("min-height", "44px");
  await trigger.click();
  menu = page.getByRole("menu", { name: "Account" });
  await expect(menu.getByRole("menuitem", { name: "Logout" })).toHaveCSS("min-height", "44px");
  const bounds = await menu.evaluate(node => ({ right: node.getBoundingClientRect().right, left: node.getBoundingClientRect().left }));
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

for (const width of [1280, 390, 320]) {
  test(`workspace hierarchy invitations are scoped, keyboard accessible, and responsive at ${width}px`, async ({ page }) => {
    await mockAuthorizedPortal(page);
    const invitations: Array<Record<string, unknown>> = [];
    const invitationBodies: Array<Record<string, unknown>> = [];
    await page.route("**/api/client/**", async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/client/session") return route.fulfill({ json: { account, capabilities: { manageTeam: true, workspaceHierarchyV2: true, workspaceMembershipManagement: true, hierarchyScopedInvitations: true, invitationEmailDelivery: true, viewBilling: false, requestV2: true, requestAttachments: false } } });
      if (path === "/api/client/v2/workspaces") return route.fulfill({ json: { workspaces: [{ id: "workspace-a", rootType: "organization", rootPublicId: "org-a", displayName: "Acme" }] } });
      if (path === "/api/client/v2/workspaces/workspace-a/hierarchy") return route.fulfill({ json: { entries: [
        { type: "organization", publicId: "org-a", parentPublicId: null, displayName: "Acme", sourceVersion: "1" },
        { type: "department", publicId: "department-a", parentPublicId: "org-a", displayName: "Survey", sourceVersion: "1" },
        { type: "client", publicId: "client-a", parentPublicId: "department-a", displayName: "North Contact", sourceVersion: "1" },
        { type: "project", publicId: "pa-project-a", parentPublicId: "department-a", displayName: "North Site", sourceVersion: "1" },
        { type: "project", publicId: "pa-project-b", parentPublicId: "department-a", displayName: "South Site", sourceVersion: "1" },
      ] } });
      if (path === "/api/client/v2/workspaces/workspace-a/access") return route.fulfill({ json: { sourceId: "project-alpha:primary", sourceName: "Project Alpha", workspaceName: "Acme", canManageMembers: true, invitationRequestsSupported: false, inviteScopes: [{type: "organization", publicId: "org-a", displayName: "Acme"}, {type: "department", publicId: "department-a", displayName: "Survey"}, {type: "client", publicId: "client-a", displayName: "North Contact"}, {type: "project", publicId: "pa-project-a", displayName: "North Site"}, {type: "project", publicId: "pa-project-b", displayName: "South Site"}].map(scope => ({...scope, capabilities: ["delivery.view", "request.create"], projectEndSupported: scope.type === "project"})), members: [{ identityId: "member-a", email: "manager@example.test", status: "active", manager: true, source: "project_alpha" }], invitations, invitationPolicy: {mode: "allowed", version: 1}, projectAccessTermsSupported: true, projectAccessOptions: [{projectPublicId: "pa-project-a", projectEndSupported: true}, {projectPublicId: "pa-project-b", projectEndSupported: true}] } });
      if (path === "/api/client/v2/workspaces/workspace-a/invitations" && request.method() === "POST") {
        const body = request.postDataJSON() as Record<string, any>;
        invitationBodies.push(body);
        invitations.push({ id: `invite-${invitations.length}`, email: body.email, status: "pending", scope: body.organizationWide ? { type: "workspace", publicId: null } : body.targetScope, capabilities: body.capabilities, expiresAt: "2099-01-01T00:00:00Z", accessTerms: null });
        return route.fulfill({ status: 201, json: { outcome: "created" } });
      }
      return route.fallback();
    });
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
    await page.goto("/portal/account");
    await expect(page.getByRole("heading", { name: "Invite a collaborator" })).toBeVisible();
    const hierarchy = page.getByRole("radiogroup", { name: "Client hierarchy" });
    const defaultProject = hierarchy.getByRole("radio", { name: /North Site/ });
    await expect(defaultProject).toBeChecked();

    await page.getByLabel("Find a scope").fill("South");
    await expect(hierarchy.getByRole("radio", { name: /South Site/ })).toBeVisible();
    await expect(defaultProject).toHaveCount(0);
    await page.getByLabel("Find a scope").fill("");

    const department = hierarchy.getByRole("radio", { name: /Survey/ });
    await department.focus();
    await page.keyboard.press("Space");
    await expect(department).toBeChecked();
    await page.getByLabel("Email address").fill("contractor@example.test");
    await page.getByRole("button", { name: "Review invitation" }).click();
    await page.getByRole("button", { name: "Send invitation" }).click();
    await expect.poll(() => invitationBodies.length).toBe(1);
    expect(invitationBodies[0]).toMatchObject({ email: "contractor@example.test", targetScope: { type: "department", publicId: "department-a" }, capabilities: ["delivery.view"] });
    expect(invitationBodies[0]).not.toHaveProperty("projectPublicId");

    const organization = hierarchy.getByRole("radio", { name: /^Acme/ });
    await organization.check();
    await expect(page.getByRole("button", { name: "Review invitation" })).toBeDisabled();
    await expect(page.getByRole("alert")).toContainText("current and future projects across this organization");
    await page.getByLabel("I understand and want to grant organization-wide access.").check();
    await expect(page.getByRole("button", { name: "Review invitation" })).toBeEnabled();

    await page.getByLabel("Give access across this entire organization workspace").check();
    await expect(page.getByRole("button", { name: "Review invitation" })).toBeDisabled();
    await page.getByLabel("I understand and want to grant workspace-wide access.").check();
    await expect(page.getByRole("button", { name: "Review invitation" })).toBeEnabled();

    if (width <= 390) {
      const overflow = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("body *")]
        .filter(element => { const rect = element.getBoundingClientRect(); return rect.right > window.innerWidth + 1 || rect.left < -1; })
        .map(element => ({ className: element.className, tag: element.tagName, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right })));
      expect(overflow).toEqual([]);
    }
  });
}

test("peer administrators use a reviewed responsive workflow and preserve ordinary access",async({page})=>{
  await mockAuthorizedPortal(page);let targetManager=false,targetVersion=0;const writes:Array<{body:any;key:string|null}>=[];
  await page.route("**/api/client/**",async route=>{const request=route.request(),path=new URL(request.url()).pathname;
    if(path==="/api/client/session")return route.fulfill({json:{account,capabilities:{manageTeam:true,workspaceHierarchyV2:true,workspaceMembershipManagement:true,hierarchyScopedInvitations:true,invitationEmailDelivery:true,viewBilling:false,requestV2:true,requestAttachments:false}}});
    if(path==="/api/client/v2/workspaces")return route.fulfill({json:{workspaces:[{id:"workspace-a",rootType:"organization",rootPublicId:"org-a",displayName:"Acme"}]}});
    if(path==="/api/client/v2/workspaces/workspace-a/access")return route.fulfill({json:{sourceId:"project-alpha:primary",sourceName:"Project Alpha",workspaceName:"Acme",canManageMembers:true,peerAdminManagement:true,invitationRequestsSupported:false,inviteScopes:[],members:[
      {identityId:"manager-a",email:"owner@example.test",status:"active",manager:true,source:"project_alpha",managerVersion:1,canChangeManager:false},
      {identityId:"member-b",email:"peer@example.test",status:"active",manager:targetManager,source:"client_invitation",managerVersion:targetVersion,canChangeManager:true}],
      invitations:[],invitationPolicy:{mode:"allowed",version:1},projectAccessTermsSupported:true,projectAccessOptions:[]}});
    if(path==="/api/client/v2/workspaces/workspace-a/members/member-b/manager"&&request.method()==="PUT"){
      const body=request.postDataJSON() as {manager:boolean;expectedVersion:number};writes.push({body,key:request.headers()["idempotency-key"]??null});
      expect(body.expectedVersion).toBe(targetVersion);targetManager=body.manager;targetVersion++;
      return route.fulfill({json:{outcome:"created",manager:targetManager,version:targetVersion}});
    }
    return route.fallback();
  });
  await page.setViewportSize({width:390,height:844});await page.goto("/portal/account");
  const peerRow=page.locator(".portal-team-row",{hasText:"peer@example.test"});
  const rowButtons=peerRow.locator(".actions button"),rowFirst=await rowButtons.nth(0).boundingBox(),rowSecond=await rowButtons.nth(1).boundingBox();
  expect(rowFirst&&rowSecond&&(rowSecond.x-rowFirst.x-rowFirst.width>=4||rowSecond.y-rowFirst.y-rowFirst.height>=4)).toBeTruthy();
  await peerRow.getByRole("button",{name:"Make administrator"}).click();
  const review=page.getByRole("region",{name:"Review administrator access change"});
  await expect(review).toContainText("invite, suspend, promote, and demote");
  const reviewButtons=review.locator(".actions button"),reviewFirst=await reviewButtons.nth(0).boundingBox(),reviewSecond=await reviewButtons.nth(1).boundingBox();
  expect(reviewFirst&&reviewSecond&&(reviewSecond.x-reviewFirst.x-reviewFirst.width>=4||reviewSecond.y-reviewFirst.y-reviewFirst.height>=4)).toBeTruthy();
  await review.getByRole("button",{name:"Add administrator"}).click();
  await expect(peerRow).toContainText("Administrator · active");expect(writes).toHaveLength(1);expect(writes[0]!.key).toMatch(/^[A-Za-z0-9-]{16,}$/);
  await peerRow.getByRole("button",{name:"Remove administrator"}).click();
  await expect(review).toContainText("ordinary workspace and delivery access stays in place");
  await review.getByRole("button",{name:"Remove administrator"}).click();
  await expect(peerRow).toContainText("Member · active");await expect(peerRow.getByRole("button",{name:"Suspend"})).toBeVisible();
  expect(writes.map(write=>write.body.manager)).toEqual([true,false]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
});

test("an ambiguous peer administrator response retries the identical operation",async({page})=>{
  await mockAuthorizedPortal(page);let targetManager=false,targetVersion=0,attempts=0;
  const writes:Array<{body:{manager:boolean;expectedVersion:number};key:string|null}>=[];
  await page.route("**/api/client/**",async route=>{const request=route.request(),path=new URL(request.url()).pathname;
    if(path==="/api/client/session")return route.fulfill({json:{account,capabilities:{manageTeam:true,workspaceHierarchyV2:true,workspaceMembershipManagement:true,hierarchyScopedInvitations:true,invitationEmailDelivery:true,viewBilling:false,requestV2:true,requestAttachments:false}}});
    if(path==="/api/client/v2/workspaces")return route.fulfill({json:{workspaces:[{id:"workspace-a",rootType:"organization",rootPublicId:"org-a",displayName:"Acme"}]}});
    if(path==="/api/client/v2/workspaces/workspace-a/access")return route.fulfill({json:{sourceId:"project-alpha:primary",sourceName:"Project Alpha",workspaceName:"Acme",canManageMembers:true,peerAdminManagement:true,invitationRequestsSupported:false,inviteScopes:[],members:[
      {identityId:"manager-a",email:"owner@example.test",status:"active",manager:true,source:"project_alpha",managerVersion:1,canChangeManager:false},
      {identityId:"member-b",email:"peer@example.test",status:"active",manager:targetManager,source:"client_invitation",managerVersion:targetVersion,canChangeManager:true}],
      invitations:[],invitationPolicy:{mode:"allowed",version:1},projectAccessTermsSupported:true,projectAccessOptions:[]}});
    if(path==="/api/client/v2/workspaces/workspace-a/members/member-b/manager"&&request.method()==="PUT"){
      const body=request.postDataJSON() as {manager:boolean;expectedVersion:number},key=request.headers()["idempotency-key"]??null;
      writes.push({body,key});attempts++;
      if(attempts===1){targetManager=true;targetVersion=1;return route.abort("failed");}
      expect(key).toBe(writes[0]!.key);expect(body).toEqual(writes[0]!.body);
      return route.fulfill({json:{outcome:"replayed",manager:true,version:1}});
    }
    return route.fallback();
  });
  await page.goto("/portal/account");
  const peerRow=page.locator(".portal-team-row",{hasText:"peer@example.test"});
  await peerRow.getByRole("button",{name:"Make administrator"}).click();
  await page.getByRole("region",{name:"Review administrator access change"}).getByRole("button",{name:"Add administrator"}).click();
  const retry=page.getByRole("button",{name:"Retry same administrator change"});await expect(retry).toBeVisible();await retry.click();
  await expect(peerRow).toContainText("Administrator · active");expect(writes).toHaveLength(2);expect(writes[0]!.key).toMatch(/^[A-Za-z0-9-]{16,}$/);
});

for (const width of [320, 390, 768]) {
  test(`portal mobile drawer is accessible without overflow at ${width}px`, async ({ page }) => {
    await mockAuthorizedPortal(page);
    await page.setViewportSize({ width, height: 740 });
    await page.goto("/portal");
    const trigger = page.getByRole("button", { name: "Open navigation" });
    const bell = page.getByRole("button", { name: /Notifications/ });
    await expect(trigger).toBeVisible();
    expect(await trigger.textContent()).not.toMatch(/[\u00c3\u00c2\u00e2]/);
    await expect(bell).toBeVisible();
    const triggerBox = await trigger.boundingBox();
    const bellBox = await bell.boundingBox();
    expect(triggerBox && bellBox && bellBox.x + bellBox.width <= triggerBox.x).toBeTruthy();

    await bell.click();
    const notificationPanel = page.getByRole("region", { name: "Notifications" });
    await expect(notificationPanel).toBeVisible();
    const panelBox = await notificationPanel.boundingBox();
    expect(panelBox && panelBox.x >= 0 && panelBox.x + panelBox.width <= width).toBeTruthy();
    await page.keyboard.press("Escape");

    await trigger.click();
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer.getByRole("link", { name: "Home" })).toBeFocused();
    await expect(drawer.getByRole("link", { name: "Account" })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Requests" })).toHaveCSS("min-height", "44px");
    await drawer.getByRole("link", { name: "Account" }).focus();
    await page.keyboard.press("Tab");
    await expect(drawer.getByRole("button", { name: "Close navigation" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(drawer.getByRole("link", { name: "Account" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    await page.mouse.click(4, 400);
    await expect(page.getByRole("dialog", { name: "Navigation" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const headerBottom = await page.locator(".client-portal-header").evaluate((node) => node.getBoundingClientRect().bottom);
    const headingTop = await page.getByRole("heading", { name: "Welcome, Acme Surveying" }).evaluate((node) => node.getBoundingClientRect().top);
    expect(headingTop).toBeGreaterThanOrEqual(headerBottom);
  });
}

test("client shell contains very long account text and reflows at a 200% zoom equivalent", async ({ page }) => {
  const longName = `Client${"N".repeat(180)}`;
  const longEmail = `${"e".repeat(180)}@example.test`;
  await mockAuthorizedPortal(
    page,
    null,
    requests,
    undefined,
    undefined,
    true,
    false,
    undefined,
    undefined,
    { id: "account-long", displayName: longName, email: longEmail },
  );

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/portal/account");
  const accountCard = page.locator(".portal-account-card");
  await expect(accountCard.getByText(longName, { exact: true })).toBeVisible();
  await expect(accountCard.getByText(longEmail, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

  // A 640 CSS-pixel viewport is the reflow equivalent of 200% browser zoom
  // on the 1280-pixel desktop canvas above.
  await page.setViewportSize({ width: 640, height: 800 });
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  const cardBounds = await accountCard.boundingBox();
  expect(cardBounds).not.toBeNull();
  expect(cardBounds!.x).toBeGreaterThanOrEqual(0);
  expect(cardBounds!.x + cardBounds!.width).toBeLessThanOrEqual(641);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const headerBottom = await page.locator(".client-portal-header").evaluate(node => node.getBoundingClientRect().bottom);
  const headingTop = await page.getByRole("heading", { name: "Your account" }).evaluate(node => node.getBoundingClientRect().top);
  expect(headingTop).toBeGreaterThanOrEqual(headerBottom);
});

test("request v2 is fail-closed and preserves legacy creation when the server capability is off", async ({ page }) => {
  await mockAuthorizedPortal(page, null, requests, undefined, undefined, false);
  await page.goto("/portal/requests/new");
  await startNewRequest(page);
  await expect(page.getByLabel("Service request title")).toBeVisible();
  await expect(page.getByRole("heading", { name: "What services do you need?" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Service request progress" })).toHaveCount(0);
});

test("request wizard step history restores safely with browser Back and Forward", async ({ page }) => {
  await mockAuthorizedPortal(page);
  await page.goto("/portal/requests/new");
  await openRequestWorkArea(page);
  await expect(page).toHaveURL(/step=location/);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Scope and timing" })).toBeVisible();
  await expect(page).toHaveURL(/step=details/);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Show us the work area" })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Scope and timing" })).toBeVisible();
});

test("request attachment uploads bytes only to signed storage and blocks submit until accepted", async ({ page }) => {
  const attachmentEvents = { workerBinaryBytes: 0, directBytes: 0, completed: false, scanAccepted: false };
  await mockAuthorizedPortal(page, null, requests, undefined, undefined, true, true, attachmentEvents);
  await page.route("https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com/**", async route => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "http://127.0.0.1:4173", "Access-Control-Allow-Methods": "PUT", "Access-Control-Allow-Headers": "content-type" } });
      return;
    }
    expect(request.method()).toBe("PUT");
    expect(request.headers()["content-type"]).toBe("application/pdf");
    expect(request.headers()).not.toHaveProperty("cookie");
    attachmentEvents.directBytes += request.postDataBuffer()?.byteLength ?? 0;
    await route.fulfill({ status: 200, headers: { ETag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"', "Access-Control-Allow-Origin": "http://127.0.0.1:4173", "Access-Control-Expose-Headers": "ETag" } });
  });
  await page.goto("/portal/requests/new");
  await openRequestWorkArea(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Service request title").fill("Authorization-backed mapping");
  await page.getByLabel("What do you need?").fill("Map the approved work area.");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Contact and supporting files" })).toBeVisible();
  const picker = page.locator(".portal-file-picker input");
  await picker.setInputFiles({ name: "blocked.zip", mimeType: "application/zip", buffer: Buffer.from("zip") });
  await expect(page.getByText(/blocked.zip is unsupported/)).toBeVisible();
  await picker.setInputFiles({ name: "authorization.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nreference") });
  await expect(page.getByText(/\/ Scanning$/)).toBeVisible();
  expect(attachmentEvents.directBytes).toBe(18);
  expect(attachmentEvents.workerBinaryBytes).toBe(0);
  expect(attachmentEvents.completed).toBe(true);
  await page.getByRole("button", { name: "Continue" }).click();
  const submit = page.getByRole("button", { name: "Submit request" });
  await expect(submit).toBeDisabled();
  await expect(page.getByText("authorization.pdf")).toBeVisible();
  attachmentEvents.scanAccepted = true;
  await expect(page.getByText("Accepted", { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page).toHaveURL(/\/portal\/requests$/);
});

test("rejected request attachments block submission and provide remove-and-replace recovery", async ({ page }) => {
  const attachmentEvents = { workerBinaryBytes: 0, directBytes: 0, completed: false, scanAccepted: false, scanRejected: true, removed: false };
  await mockAuthorizedPortal(page, null, requests, undefined, undefined, true, true, attachmentEvents);
  await page.route("https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com/**", async route => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "http://127.0.0.1:4173", "Access-Control-Allow-Methods": "PUT", "Access-Control-Allow-Headers": "content-type" } });
    attachmentEvents.directBytes += request.postDataBuffer()?.byteLength ?? 0;
    await route.fulfill({ status: 200, headers: { ETag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"', "Access-Control-Allow-Origin": "http://127.0.0.1:4173", "Access-Control-Expose-Headers": "ETag" } });
  });
  await page.goto("/portal/requests/new");
  await openRequestWorkArea(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Service request title").fill("Replacement attachment test");
  await page.getByLabel("What do you need?").fill("Verify rejected supporting-file recovery.");
  await page.getByRole("button", { name: "Continue" }).click();
  const picker = page.locator(".portal-file-picker input");
  await picker.setInputFiles({ name: "authorization.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nreference") });
  await expect(page.getByText(/\/ Rejected$/)).toBeVisible();
  await expect(page.getByText(/security scan rejected this file/i)).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  const submit = page.getByRole("button", { name: "Submit request" });
  await expect(submit).toBeDisabled();
  await expect(page.getByText(/remove each rejected file/i)).toBeVisible();
  await page.getByRole("button", { name: "Edit files" }).click();
  await page.getByRole("button", { name: "Remove" }).click();
  expect(attachmentEvents.removed).toBe(true);
  attachmentEvents.scanRejected = false;
  attachmentEvents.scanAccepted = true;
  await picker.setInputFiles({ name: "authorization.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nreference") });
  await expect(page.getByText(/\/ Accepted$/)).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("button", { name: "Submit request" })).toBeEnabled();
});

test("expired request attachments stay visible and require explicit removal", async ({ page }) => {
  const attachmentEvents = { workerBinaryBytes: 0, directBytes: 0, completed: false, scanAccepted: false, scanExpired: true, removed: false };
  await mockAuthorizedPortal(page, null, requests, undefined, undefined, true, true, attachmentEvents);
  await page.route("https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com/**", async route => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "http://127.0.0.1:4173", "Access-Control-Allow-Methods": "PUT", "Access-Control-Allow-Headers": "content-type" } });
    await route.fulfill({ status: 200, headers: { ETag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"', "Access-Control-Allow-Origin": "http://127.0.0.1:4173", "Access-Control-Expose-Headers": "ETag" } });
  });
  await page.goto("/portal/requests/new");
  await openRequestWorkArea(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Service request title").fill("Expired attachment recovery");
  await page.getByLabel("What do you need?").fill("Require an explicit decision when an upload expires.");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator(".portal-file-picker input").setInputFiles({ name: "authorization.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nreference") });
  await expect(page.getByText(/\/ Expired$/)).toBeVisible();
  await expect(page.getByText(/upload expired before it was accepted/i)).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("button", { name: "Submit request" })).toBeDisabled();
  await expect(page.getByText(/remove each expired file/i)).toBeVisible();
  await page.getByRole("button", { name: "Edit files" }).click();
  await page.getByRole("button", { name: "Remove" }).click();
  expect(attachmentEvents.removed).toBe(true);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("button", { name: "Submit request" })).toBeEnabled();
});

test("request attachment picker enforces file-count and size bounds before initialization", async ({ page }) => {
  await mockAuthorizedPortal(page, null, requests, undefined, undefined, true, true);
  await page.goto("/portal/requests/new");
  await openRequestWorkArea(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Service request title").fill("Bounds check");
  await page.getByLabel("What do you need?").fill("Validate supporting file limits.");
  await page.getByRole("button", { name: "Continue" }).click();
  const files = Array.from({ length: 11 }, (_, index) => ({ name: `photo-${index}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from("jpeg") }));
  await page.locator(".portal-file-picker input").setInputFiles(files);
  await expect(page.getByText("A request can include at most 10 files.")).toBeVisible();
  await expect(page.locator(".portal-attachment-list article")).toHaveCount(0);
  await page.locator(".portal-file-picker input").setInputFiles({ name: "too-large.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(25 * 1024 * 1024 + 1) });
  await expect(page.getByText(/too-large.pdf is unsupported/)).toBeVisible();
  await expect(page.locator(".portal-attachment-list article")).toHaveCount(0);
});

test("notification bell is keyboard accessible and supports read, dismiss, outside click, and Escape", async ({ page }) => {
  await mockAuthorizedPortal(page);
  await page.goto("/portal");
  const bell = page.getByRole("button", { name: /^Notifications/ });
  await bell.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Notifications" })).toBeVisible();
  await page.getByRole("button", { name: "Mark read" }).click();
  await expect(page.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Notifications" })).toBeHidden();
  await expect(bell).toBeFocused();
  await bell.click(); await page.mouse.click(2, 2);
  await expect(page.getByRole("region", { name: "Notifications" })).toBeHidden();
});

test("authorized photo map supports compact, enlarged, and empty states", async ({ page }) => {
  await mockMapbox(page);
  await mockAuthorizedPortal(page, "pk.local-browser-test", requests, undefined, {
    project: {
      points: [
        { latitude: 44.501, longitude: -88.071, imageCount: 2 },
        { latitude: 44.513, longitude: -88.083, imageCount: 1 },
      ],
      imageCount: 3,
      truncated: false,
    },
    past: { points: [], imageCount: 0, truncated: false },
  });
  await page.goto("/portal");
  await navigatePortal(page, "Projects");
  await page.getByRole("button", { name: /North Site/ }).click();
  await page.getByRole("button", { name: "Files" }).click();
  await expect(page.getByRole("heading", { name: "Image locations from available photo metadata" })).toBeVisible();
  await expect(page.locator(".image-location-map-canvas").first()).toBeVisible();
  await page.getByRole("button", { name: "Enlarge map" }).click();
  const dialog = page.getByRole("dialog", { name: "Image locations from available photo metadata" });
  await expect(dialog).toBeVisible();
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await navigatePortal(page, "Deliveries");
  await expect(page.getByText("No image locations are available for your available delivery files.")).toBeVisible();
});

test("client Viewer sharing is opt-in, owner-scoped, and responsive at 390 and 320", async ({ page }) => {
  let active = false, preferenceUnits: string | null = null, sessionUnits: string | null = null;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/client/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/client/session") return route.fulfill({ json: { account, viewerDisplayUnits: "imperial", capabilities: { viewer: true, viewerShares: true } } });
    if (path === "/api/client/projects") return route.fulfill({ json: { projects } });
    if (path === "/api/client/service-requests") return route.fulfill({ json: { requests } });
    if (path === "/api/client/map-config") return route.fulfill({ json: { mapboxPublicToken: null } });
    if (path === "/api/client/notifications") return route.fulfill({ json: { notifications: [], unreadCount: 0, cursor: null } });
    if (path === "/api/client/projects/project-a/models") return route.fulfill({ json: { models: [{
      associationId: "association-one", title: "North Site point cloud", provider: "WebODM",
      modelId: "model-one", modelVersionId: "version-one", updatedAt: "2026-08-16T12:00:00.000Z", canShare: true,
    }] } });
    if (path === "/api/client/viewer/preferences" && request.method() === "PATCH") { preferenceUnits = String((request.postDataJSON() as { displayUnits?: string }).displayUnits || ""); return route.fulfill({ json: { displayUnits: preferenceUnits } }); }
    if (path === "/api/client/projects/project-a/models/association-one/session" && request.method() === "POST") { sessionUnits = String((request.postDataJSON() as { displayUnits?: string }).displayUnits || ""); return route.fulfill({ status: 201, json: { grant: "11111111-1111-4111-8111-111111111111", grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800, redeemUrl: "https://viewer.example.test/api/v1/sessions/redeem", embedUrl: "https://viewer.example.test/session/11111111-1111-4111-8111-111111111111" } }); }
    if (path === "/api/client/projects/project-a/models/association-one/shares" && request.method() === "GET") return route.fulfill({ json: { shares: [...(active ? [{
      id: "share-one", modelId: "model-one", versionPolicy: "latest", modelVersionId: null, hasPassword: true,
      permissions: { view: true, measure: true, cameras: true, download: false }, label: "Engineer review",
      createdBy: "identity-one", createdAt: "2026-08-17T03:00:00.000Z", updatedAt: "2026-08-17T03:00:00.000Z",
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), revokedAt: null, revokedBy: null, revokeReason: null,
      accessCount: 0, lastAccessedAt: null, shareClass: "client",
      sourceAuthorization: { type: "client_grant", id: "source-one", version: 1, subject: "subject-one", expiresAt: null },
    }] : []), {
      id: "share-expired", modelId: "model-one", versionPolicy: "latest", modelVersionId: null, hasPassword: false,
      permissions: { view: true, measure: true, cameras: true, download: false }, label: "Expired engineer review",
      createdBy: "identity-one", createdAt: "2026-07-01T03:00:00.000Z", updatedAt: "2026-07-01T03:00:00.000Z",
      expiresAt: "2026-07-02T03:00:00.000Z", revokedAt: null, revokedBy: null, revokeReason: null,
      accessCount: 0, lastAccessedAt: null, shareClass: "client",
      sourceAuthorization: { type: "client_grant", id: "source-old", version: 1, subject: "subject-one", expiresAt: null },
    }] } });
    if (path === "/api/client/projects/project-a/models/association-one/shares" && request.method() === "POST") {
      expect(request.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(request.postDataJSON()).toMatchObject({ label: "Engineer review", displayUnits: "metric", password: "model-passcode" });
      active = true;
      return route.fulfill({ status: 201, json: {
        share: { id: "share-one", modelId: "model-one" },
        viewUrl: "https://viewer.example.test/view/one-time-client-token", embedUrl: "https://viewer.example.test/embed/one-time-client-token", replayed: false,
      } });
    }
    if (path.endsWith("/shares/share-one") && request.method() === "DELETE") {
      expect(request.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      active = false;
      return route.fulfill({ json: { share: { id: "share-one", revokedAt: new Date().toISOString() }, replayed: false } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.context().route("https://viewer.example.test/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Viewer</title>" }));
  await page.goto("/portal");
  await navigatePortal(page, "Projects");
  await page.getByRole("button", { name: /North Site/ }).click();
  await page.getByRole("button", { name: "Models" }).click();
  await page.getByLabel("Measurement units").selectOption("metric");
  await expect.poll(() => preferenceUnits).toBe("metric");
  const viewerPopupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Open 3D model" }).click();
  const viewerPopup = await viewerPopupPromise;
  await expect.poll(() => sessionUnits).toBe("metric");
  await expect(viewerPopup).toHaveURL("https://viewer.example.test/session/11111111-1111-4111-8111-111111111111");
  await viewerPopup.close();
  await page.getByRole("button", { name: "Share public link" }).click();
  await expect(page.getByText("Expired engineer review")).toHaveCount(0);
  await page.getByLabel("Link label").fill("Engineer review");
  await page.getByLabel("Access code").fill("model-passcode");
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.getByLabel("New public 3D model link")).toHaveValue(/one-time-client-token/);
  await expect(page.getByText("Engineer review · expires")).toBeVisible();
  await page.getByRole("button", { name: "Share public link" }).click();
  await expect(page.getByLabel("New public 3D model link")).toHaveCount(0);
  await page.getByRole("button", { name: "Share public link" }).click();
  await expect(page.getByLabel("Access code")).toHaveValue("");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("No active links.")).toBeVisible();
});

test("Viewer renewal keeps the dedicated tab and camera state mounted across a transient authorization failure", async ({ page }) => {
  let sessionRequests = 0, viewerLoads = 0;
  const sessionDisplayUnits: string[] = [];
  const viewerOrigin = "https://viewer.ledgetopdroneservices.com";
  await page.context().route(`${viewerOrigin}/**`, async route => {
    if (!new URL(route.request().url()).pathname.startsWith("/session/"))
      return route.fulfill({ status: 404, body: "not found" });
    viewerLoads += 1;
    await route.fulfill({ contentType: "text/html", body: `<!doctype html><body><div id="camera-state">camera-position-42</div><script>
      const expiresAt = new Date(Date.now() + 10000).toISOString();
      addEventListener("message", event => {
        if (event.data?.type !== "ltds-viewer:renew-session") return;
        document.body.dataset.renewedGrant = event.data.grant;
        opener.postMessage({version:1,type:"ltds-viewer:session-renewed",modelId:"model-one",expiresAt:new Date(Date.now()+60000).toISOString()}, "*");
      });
      setTimeout(() => opener.postMessage({version:1,type:"ltds-viewer:ready",modelId:"model-one",expiresAt}, "*"), 50);
      setTimeout(() => opener.postMessage({version:1,type:"ltds-viewer:session-expiring",modelId:"model-one",expiresAt}, "*"), 100);
    </script></body>` });
  });
  await page.route("**/api/client/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/client/session") return route.fulfill({ json: { account, viewerDisplayUnits: "metric", capabilities: { viewer: true } } });
    if (path === "/api/client/projects") return route.fulfill({ json: { projects } });
    if (path === "/api/client/service-requests") return route.fulfill({ json: { requests } });
    if (path === "/api/client/map-config") return route.fulfill({ json: { mapboxPublicToken: null } });
    if (path === "/api/client/notifications") return route.fulfill({ json: { notifications: [], unreadCount: 0, cursor: null } });
    if (path === "/api/client/projects/project-a/models") return route.fulfill({ json: { models: [{
      associationId: "association-one", title: "North Site point cloud", provider: "WebODM",
      modelId: "model-one", modelVersionId: "version-one", updatedAt: "2026-08-16T12:00:00.000Z", canShare: false,
    }] } });
    if (path === "/api/client/projects/project-a/models/association-one/session" && request.method() === "POST") {
      sessionRequests += 1;
      sessionDisplayUnits.push(String((request.postDataJSON() as { displayUnits?: string }).displayUnits || ""));
      if (sessionRequests === 2) return route.fulfill({ status: 503, json: { error: "temporary authorization failure" } });
      return route.fulfill({ status: 201, json: {
        grant: sessionRequests === 1 ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222",
        grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800,
        redeemUrl: `${viewerOrigin}/api/v1/sessions/redeem`, embedUrl: `${viewerOrigin}/session/${sessionRequests === 1 ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222"}`,
      } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/portal");
  await navigatePortal(page, "Projects");
  await page.getByRole("button", { name: /North Site/ }).click();
  await page.getByRole("button", { name: "Models" }).click();
  const viewerPopupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Open 3D model" }).click();
  const viewerPopup = await viewerPopupPromise;
  await expect.poll(() => viewerLoads).toBe(1);
  await expect(viewerPopup.locator("#camera-state")).toHaveText("camera-position-42");
  await expect(viewerPopup.locator("body")).toHaveAttribute("data-renewed-grant", "22222222-2222-4222-8222-222222222222", { timeout: 5_000 });
  await expect(viewerPopup.locator("#camera-state")).toHaveText("camera-position-42");
  expect(sessionRequests).toBe(3);
  expect(sessionDisplayUnits).toEqual(["metric", "metric", "metric"]);
  expect(viewerLoads).toBe(1);
  await viewerPopup.close();
});

test("disabled or unavailable session stops before account data requests", async ({ page }) => {
  const requestedPaths: string[] = [];
  await page.route("**/api/client/**", async route => {
    const path = new URL(route.request().url()).pathname;
    requestedPaths.push(path);
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/portal");
  await expect(page.getByText("Portal unavailable", { exact: true })).toBeVisible();
  expect(requestedPaths).toEqual(["/api/client/session"]);
});

test("map starts under the production CSP contract without policy errors", async ({ page }) => {
  const policyErrors: string[] = [];
  page.on("console", message => {
    if (message.type() === "error" && /content security policy|refused to (?:connect|create a worker|load)/i.test(message.text())) policyErrors.push(message.text());
  });
  await mockMapbox(page);
  await mockAuthorizedPortal(page, "pk.local-browser-test");
  await page.goto("/portal/requests/new");
  await openRequestWorkArea(page);
  await expect(page.locator(".portal-map-canvas")).toBeVisible();
  await expect(page.locator(".mapboxgl-canvas")).toBeVisible();
  expect(policyErrors).toEqual([]);
});

test("request map is primary, responsive, accessible, and supports targeted POI removal", async ({ page }, testInfo) => {
  await mockMapbox(page);
  await mockAuthorizedPortal(page, "pk.local-browser-test");
  await page.goto("/portal/requests/new");
  await openRequestWorkArea(page);

  const map = page.locator(".portal-map-canvas");
  const canvas = page.locator(".mapboxgl-canvas");
  await expect(map).toBeVisible();
  await expect(canvas).toBeVisible();
  // Read all geometry in one animation frame. Mapbox can update its canvas and
  // scroll position while it finishes initializing; separate boundingBox()
  // calls can otherwise compare coordinates from different viewport states.
  const geometry = await map.evaluate(element => {
    const region = element.closest(".portal-request-map");
    const title = document.querySelector("#request-location-title");
    if (!(region instanceof HTMLElement) || !(title instanceof HTMLElement)) return null;
    const box = (target: Element) => {
      const rect = target.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    return { map: box(element), region: box(region), title: box(title) };
  });
  expect(geometry).not.toBeNull();
  const mapBox = geometry!.map;
  const mapRegionBox = geometry!.region;
  const titleBox = geometry!.title;
  const mobile = testInfo.project.name.includes("mobile");
  expect(mapRegionBox.width).toBeGreaterThanOrEqual(page.viewportSize()!.width * (mobile ? 0.7 : 0.6));
  expect(mapBox.width).toBeGreaterThanOrEqual(mapRegionBox.width - 40);
  expect(mapBox.height).toBeGreaterThanOrEqual(mobile ? 430 : 560);
  expect(mapRegionBox.y).toBeGreaterThan(titleBox.y);
  expect(mapBox.x).toBeGreaterThanOrEqual(0);
  expect(mapBox.x + mapBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);

  const drawArea = page.getByRole("button", { name: "Draw area" });
  const streets = page.getByRole("button", { name: "Streets" });
  await expect(drawArea).toHaveAttribute("aria-pressed", "false");
  await expect(streets).toHaveAttribute("aria-pressed", "false");
  for (const control of [drawArea, streets]) {
    const colors = await control.evaluate(element => {
      const style = getComputedStyle(element);
      return { color: style.color, backgroundColor: style.backgroundColor };
    });
    expect(colors.color).toBe("rgb(23, 29, 35)");
    expect(colors.backgroundColor).not.toBe("rgb(23, 29, 35)");
  }

  const addressSearch = page.getByRole("combobox", { name: "Search address or place" });
  await addressSearch.fill("100 Mai");
  await expect(page.getByRole("option")).toHaveCount(2);
  await addressSearch.press("ArrowDown");
  await addressSearch.press("Enter");
  await expect(addressSearch).toHaveValue("100 Main Street, Green Bay, Wisconsin 54301");
  await expect(page.getByRole("listbox", { name: "Address suggestions" })).toHaveCount(0);
  await addressSearch.fill("100 Mai");
  await expect(page.getByRole("option")).toHaveCount(2);
  await page.getByRole("button", { name: /100 Main Avenue/ }).click();
  await expect(addressSearch).toHaveValue("100 Main Avenue, Green Bay, Wisconsin 54303");

  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  await canvas.click({ position: { x: canvasBox!.width * .35, y: canvasBox!.height * .4 } });
  await canvas.click({ position: { x: canvasBox!.width * .65, y: canvasBox!.height * .6 } });
  const poiItems = page.locator(".portal-poi-roster li");
  await expect(poiItems).toHaveCount(2);
  const coordinatesBefore = await page.locator(".portal-poi-focus span").allTextContents();
  await page.getByRole("button", { name: "Remove point 1" }).click();
  await expect(poiItems).toHaveCount(1);
  expect(await page.locator(".portal-poi-focus span").allTextContents()).toEqual([coordinatesBefore[1]]);

  expect(await page.evaluate(() => ({
    documentFits: document.documentElement.scrollWidth <= window.innerWidth,
    bodyFits: document.body.scrollWidth <= window.innerWidth,
  }))).toEqual({ documentFits: true, bodyFits: true });
});

test("current location reports loading, failure, and success without blocking the map", async ({ page }) => {
  await page.addInitScript(() => {
    let calls = 0;
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition(success: PositionCallback, failure: PositionErrorCallback) {
          const call = calls++;
          window.setTimeout(() => {
            if (call === 0) failure({ code: 1, message: "denied", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError);
            else success({ coords: { longitude: -88.071, latitude: 44.501, accuracy: 150, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() } as GeolocationPosition);
          // Keep the asynchronous loading state observable even when the
          // mobile project and assertion scheduler are running concurrently.
          // The test still exercises the real success/error callbacks; it no
          // longer depends on catching a 120 ms transient between assertions.
          }, 750);
        },
      },
    });
  });
  await mockMapbox(page);
  await mockAuthorizedPortal(page, "pk.local-browser-test");
  await page.goto("/portal/requests/new");
  await openRequestWorkArea(page);

  const locate = page.getByRole("button", { name: "Use current location" });
  await locate.click();
  await expect(page.getByRole("button", { name: "Locating…" })).toHaveAttribute("aria-busy", "true");
  await expect(page.getByText("Finding your approximate location… You can keep using the map while this runs.")).toBeVisible();
  await expect(page.getByText("Location permission was declined. You can still search an address or add points on the map.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Use current location" })).toBeEnabled();

  await page.getByRole("button", { name: "Use current location" }).click();
  await expect(page.getByText("Current location found and added as a point of interest.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Current location 44.501000, -88.071000" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove Current location" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel(/Location/)).toHaveValue("Broadway, Green Bay, Wisconsin");
});

test("final review shows timing, POI coordinates, and a responsive read-only boundary preview", async ({ page }) => {
  await mockMapbox(page);
  await mockAuthorizedPortal(page, "pk.local-browser-test");
  await page.route("**/api/client/service-request-drafts/draft-a/pricing-hint", route => route.fulfill({ json: {
    available: true,
    hint: {
      kind: "starting_at",
      currency: "USD",
      startingAtMinor: 125000,
      disclaimer: "Planning guidance only. Final quote after staff review.",
      basisVersion: "pricing-v1",
      validUntil: "2099-01-01T00:00:00.000Z",
    },
  } }));
  await page.goto("/portal/requests/new");
  await openRequestWorkArea(page);
  const canvas = page.locator(".mapboxgl-canvas");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await canvas.click({ position: { x: box!.width * .5, y: box!.height * .5 } });
  await page.getByRole("button", { name: "Draw area" }).click();
  await canvas.click({ position: { x: box!.width * .22, y: box!.height * .28 } });
  await canvas.click({ position: { x: box!.width * .72, y: box!.height * .32 } });
  await canvas.click({ position: { x: box!.width * .58, y: box!.height * .72 } });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Service request title").fill("Review map details");
  await page.getByLabel("What do you need?").fill("Confirm the boundary and timing before submission.");
  await page.getByLabel(/Preferred start/).fill("2026-09-01T09:30");
  await page.getByLabel(/Desired completion/).fill("2026-09-03T16:00");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  const preview = page.getByRole("img", { name: /read-only preview of the requested work boundary/i });
  await expect(preview).toBeVisible();
  await expect(preview.locator(".portal-review-boundary")).toHaveAttribute("d", /^M/);
  await expect(page.getByRole("list", { name: "Points of interest" })).toContainText(/Broadway|Point 1/);
  await expect(page.getByRole("list", { name: "Points of interest" })).toContainText(/-?\d+\.\d{6}, -?\d+\.\d{6}/);
  await expect(page.locator(".portal-review-timing")).toContainText("Preferred start");
  await expect(page.locator(".portal-review-timing")).toContainText("Desired completion");
  await expect(page.locator(".portal-review-timing")).not.toContainText("Not specified");
  const pricing = page.locator(".portal-pricing-hint");
  await expect(pricing).toContainText("Estimated coverage: 12.5 acres");
  await expect(pricing).toContainText("Starting at $1,250");
  await expect(pricing).toContainText("Planning guidance only. Final quote after staff review.");

  for (const viewport of [{ width: 844, height: 390 }, { width: 640, height: 900 }]) {
    await page.setViewportSize(viewport);
    await preview.scrollIntoViewIfNeeded();
    const previewBox = await preview.boundingBox();
    expect(previewBox).not.toBeNull();
    expect(previewBox!.x).toBeGreaterThanOrEqual(0);
    expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(viewport.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test("pricing guidance ignores an older response after the service basis changes", async ({ page }) => {
  await mockAuthorizedPortal(page);
  let mode: "initial" | "race" = "initial";
  let raceCalls = 0;
  let oldRequest: Request | undefined, oldHandlerFinished = false;
  const terminalRequests = new Set<Request>();
  page.on("requestfinished", request => terminalRequests.add(request));
  page.on("requestfailed", request => terminalRequests.add(request));
  let releaseOld!: () => void;
  const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
  await page.route("**/api/client/service-request-drafts/draft-a/pricing-hint", async route => {
    if (mode === "initial") return route.fulfill({ json: { available: true, hint: {
      kind: "starting_at", currency: "USD", startingAtMinor: 100000,
      disclaimer: "Planning guidance only. Final quote after staff review.", basisVersion: "initial", validUntil: "2099-01-01T00:00:00.000Z",
    } } });
    const call = ++raceCalls;
    if (call === 1) { oldRequest = route.request(); await oldGate; }
    try {
      await route.fulfill({ json: { available: true, hint: {
        kind: "starting_at", currency: "USD", startingAtMinor: call === 1 ? 100000 : 200000,
        disclaimer: "Planning guidance only. Final quote after staff review.", basisVersion: call === 1 ? "old" : "new", validUntil: "2099-01-01T00:00:00.000Z",
      } } });
    } finally { if (call === 1) oldHandlerFinished = true; }
  });

  await page.goto("/portal/requests/new");
  await openRequestWorkArea(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Service request title").fill("Pricing race check");
  await page.getByLabel("What do you need?").fill("Confirm that changed service scope never shows an older price hint.");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator(".portal-pricing-hint")).toContainText("Starting at $1,000");

  mode = "race";
  await page.getByRole("button", { name: "Edit services" }).click();
  await page.getByLabel("Preferred resolution").selectOption("survey");
  await expect.poll(() => raceCalls).toBe(1);
  await page.getByLabel("Preferred resolution").selectOption("standard");
  await expect.poll(() => raceCalls).toBe(2);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator(".portal-pricing-hint")).toContainText("Starting at $2,000");
  releaseOld();
  await expect.poll(() => oldHandlerFinished && !!oldRequest && terminalRequests.has(oldRequest)).toBe(true);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator(".portal-pricing-hint")).toContainText("Starting at $2,000");
  await expect(page.locator(".portal-pricing-hint")).not.toContainText("Starting at $1,000");
});

test("a server-side attachment scan change returns the client to file recovery", async ({ page }) => {
  await mockAuthorizedPortal(page);
  await page.route("**/api/client/service-request-drafts/draft-a/submit", route => route.fulfill({ status: 422, json: {
    error: "Remove every rejected supporting file and upload a safe replacement before submitting.",
    code: "attachments_rejected",
    attachmentCount: 1,
  } }));
  await page.goto("/portal/requests/new");
  await openRequestWorkArea(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Service request title").fill("Scanner changed state");
  await page.getByLabel("What do you need?").fill("Exercise precise recovery when the scanner changes immediately before submit.");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Submit request" }).click();
  await expect(page.getByRole("heading", { name: "Contact and supporting files" })).toBeVisible();
  await expect(page.getByText("Remove every rejected supporting file and upload a safe replacement before submitting.")).toBeVisible();
});

test("client can edit before review, create a child change, and answer an estimate", async ({ page }) => {
  const baseRequest = requests[0]!;
  const workflowRequests: PortalServiceRequest[] = [
    { ...baseRequest, serviceCategory: null, deliverables: null, siteContactName: null, siteContactEmail: null, siteContactPhone: null, desiredCompletionAt: null, latitude: null, longitude: null, areaGeoJson: null, poiPoints: [] },
    {
      ...baseRequest,
      id: "request-b",
      requestType: "service" as const,
      title: "Reviewed model update",
      details: "Update the reviewed site model.",
      status: "under_review" as const,
      operationalEstimate: { id: "estimate-b", version: 1, scope: "Model update and contours", amount: 1250, currency: "USD", status: "ready" as const, proposedFields: null, clientResponseNote: null, updatedAt: "2026-08-01T12:30:00.000Z" },
    },
  ];
  const workflowEvents: { edited?: boolean; changeRequested?: boolean; estimateAccepted?: boolean } = {};
  await mockAuthorizedPortal(page, null, workflowRequests, workflowEvents);
  await page.goto("/portal/requests");
  await expect(page.getByText("Scope proposal")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("$1,250");

  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Service request title").fill("Edited before review");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => workflowEvents.edited).toBe(true);
  await page.goto("/portal/requests");

  await page.getByRole("button", { name: "Request a change" }).click();
  await page.getByLabel("What do you need?").fill("Add the east parcel to the reviewed scope.");
  await page.getByRole("button", { name: "Submit change request" }).click();
  await expect.poll(() => workflowEvents.changeRequested).toBe(true);
  await page.goto("/portal/requests");

  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Accept estimate" }).click();
  await expect.poll(() => workflowEvents.estimateAccepted).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("client can cancel pre-work requests and sees PA draft creation without an acceptance claim", async ({ page }) => {
  const workflowEvents: { cancelled?: boolean } = {};
  const fixtureRequests: PortalServiceRequest[] = [
    requests[0]!,
    { ...requests[0]!, id: "request-pa-pending", title: "Approved mapping", status: "accepted_pending_pa_linkage" },
    { ...requests[0]!, id: "request-pa-draft", title: "Quoted mapping", status: "accepted_linked" },
  ];
  await mockAuthorizedPortal(page, null, fixtureRequests, workflowEvents);
  await page.goto("/portal/requests");
  await expect(page.getByText("Approved · preparing PA draft quote", { exact: true })).toBeVisible();
  await expect(page.getByText("PA draft quote created", { exact: true })).toBeVisible();
  const submitted = page.locator("article").filter({ hasText: requests[0]!.title });
  page.once("dialog", dialog => {
    expect(dialog.message()).toContain("closes the request before work begins");
    return dialog.accept();
  });
  await submitted.getByRole("button", { name: "Cancel request" }).click();
  await expect.poll(() => workflowEvents.cancelled).toBe(true);
  await expect(submitted.getByText("Cancelled", { exact: true })).toBeVisible();
  await expect(submitted.getByRole("button", { name: "Cancel request" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("client cancellation reuses its idempotency key after an uncertain response", async ({ page }) => {
  const workflowEvents = { cancellationKeys: [] as string[], failFirstCancellation: true, cancelled: false };
  await mockAuthorizedPortal(page, null, requests, workflowEvents);
  await page.goto("/portal/projects/project-a?tab=requests");
  const request = page.locator("article").filter({ hasText: requests[0]!.title });
  page.on("dialog", async dialog => dialog.type() === "confirm" ? dialog.accept() : dialog.dismiss());
  await request.getByRole("button", { name: "Cancel request" }).click();
  await expect(request.getByRole("button", { name: "Retry cancellation" })).toBeVisible();
  await request.getByRole("button", { name: "Retry cancellation" }).click();
  await expect.poll(() => workflowEvents.cancelled).toBe(true);
  expect(workflowEvents.cancellationKeys).toHaveLength(2);
  expect(workflowEvents.cancellationKeys[1]).toBe(workflowEvents.cancellationKeys[0]);
  await expect(request.getByText("Cancelled", { exact: true })).toBeVisible();
});
