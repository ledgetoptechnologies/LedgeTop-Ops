import { expect, test, type Page } from "@playwright/test";
import type { DeliveryLocationCollection } from "@ltds/shared";
import type { PortalServiceRequest } from "../../src/client/portal-api";

const account = { id: "account-a", displayName: "Acme Surveying" };
const projects = [{ id: "project-a", externalRef: "ALPHA-1", clientName: "Acme", projectName: "North Site", canRequestService: true, status: "in_progress", summary: "Aerial progress documentation", siteAddress: null, serviceAddress: "100 Main St", projectContactName: "LTDS Operations", projectContactEmail: "ops@example.com", projectContactPhone: null, nextMilestone: "Spring progress imagery", lastUpdateAt: "2026-08-01T12:00:00.000Z" }];
const filePage = { files: [{ id: "file-a", key: "Jobs/Clients/acme/north/final.pdf", name: "final.pdf", size: 2048, uploadedAt: "2026-08-01T12:00:00.000Z", contentType: "application/pdf", previewPath: "/api/client/files/file-a/preview?projectId=project-a", downloadPath: "/api/client/files/file-a/download?projectId=project-a" }], prefix: "", cursor: null };
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
  questions: [{ id: "resolution", label: "Preferred resolution", type: "select", required: true, helpText: "Choose the best fit; LTDS will confirm feasibility.", options: [{ value: "standard", label: "Standard" }, { value: "survey", label: "Survey detail" }] }],
}];

async function mockAuthorizedPortal(
  page: Page,
  mapboxPublicToken: string | null = null,
  fixtureRequests = requests,
  workflowEvents?: { edited?: boolean; changeRequested?: boolean; estimateAccepted?: boolean },
  locationFixtures: { project: DeliveryLocationCollection; past: DeliveryLocationCollection } = {
    project: { points: [], imageCount: 0, truncated: false },
    past: { points: [], imageCount: 0, truncated: false },
  },
  requestV2 = true,
  requestAttachments = false,
  attachmentEvents?: { workerBinaryBytes: number; directBytes: number; completed: boolean; scanAccepted: boolean },
) {
  let draftVersion = 1;
  let draftBody: Record<string, unknown> | null = null;
  await page.route("**/api/client/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/client/session") {
      await route.fulfill({ json: { account, capabilities: { manageTeam: true, viewBilling: false, requestV2, requestAttachments } } });
    } else if (request.method() === "GET" && path === "/api/client/map-config") {
      await route.fulfill({ json: { mapboxPublicToken } });
    } else if (request.method() === "GET" && path === "/api/client/projects") {
      await route.fulfill({ json: { projects } });
    } else if (request.method() === "GET" && path === "/api/client/service-requests") {
      await route.fulfill({ json: { requests: fixtureRequests } });
    } else if (request.method() === "GET" && path === "/api/client/service-catalog") {
      await route.fulfill({ json: { services: serviceCatalog } });
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
      await route.fulfill({ json: { attachmentId: "attachment-a", id: "attachment-a", name: "authorization.pdf", contentType: "application/pdf", size: 18, status: attachmentEvents?.scanAccepted ? "accepted" : "scanning", partSize: 8 * 1024 * 1024, completedParts: [] } });
    } else if (request.method() === "GET" && path === "/api/client/notifications") {
      await route.fulfill({ json: { notifications: [{ id: "notice-a", eventType: "files_added", title: "New files available", body: "Files were added to your LTDS client workspace.", actionPath: "/portal/deliveries", readAt: null, createdAt: "2026-08-13T12:00:00.000Z" }], unreadCount: 1, cursor: null } });
    } else if (request.method() === "PATCH" && path === "/api/client/notifications/notice-a") {
      expect(request.postDataJSON()).toMatchObject({ action: expect.stringMatching(/read|dismiss/) });
      await route.fulfill({ json: { success: true } });
    } else if (request.method() === "GET" && path === "/api/client/projects/project-a/files") {
      await route.fulfill({ json: filePage });
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
    } else {
      await route.fulfill({ status: 404, json: { error: "Not found" } });
    }
  });
}

async function openRequestWorkArea(page: Page) {
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
  await openRequestWorkArea(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Project context").selectOption("project-a");
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
  await page.getByRole("button", { name: "Open account" }).click();
  await expect(page).toHaveURL(/\/portal\/account$/);
});

test("workspace team UI defaults to project access and gates workspace-wide invitations", async ({ page }) => {
  await mockAuthorizedPortal(page);
  const invitations: Array<Record<string, unknown>> = [];
  await page.route("**/api/client/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/client/session") return route.fulfill({ json: { account, capabilities: { manageTeam: true, workspaceHierarchyV2: true, workspaceMembershipManagement: true, viewBilling: false, requestV2: true, requestAttachments: false } } });
    if (path === "/api/client/v2/workspaces") return route.fulfill({ json: { workspaces: [{ id: "workspace-a", rootType: "organization", rootPublicId: "org-a", displayName: "Acme" }] } });
    if (path === "/api/client/v2/workspaces/workspace-a/hierarchy") return route.fulfill({ json: { entries: [{ type: "project", publicId: "pa-project-a", parentPublicId: "org-a", displayName: "North Site", sourceVersion: "1" }] } });
    if (path === "/api/client/v2/workspaces/workspace-a/access") return route.fulfill({ json: { members: [{ identityId: "member-a", email: "manager@example.test", status: "active", manager: true, source: "project_alpha" }], invitations } });
    if (path === "/api/client/v2/workspaces/workspace-a/invitations" && request.method() === "POST") {
      invitations.push({ id: "invite-a", email: request.postDataJSON().email, status: "pending", scope: { type: request.postDataJSON().organizationWide ? "workspace" : "project", publicId: request.postDataJSON().projectPublicId ?? null }, capabilities: request.postDataJSON().capabilities, expiresAt: "2099-01-01T00:00:00Z" });
      return route.fulfill({ status: 201, json: { outcome: "created" } });
    }
    return route.fallback();
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/portal/account");
  await expect(page.getByRole("heading", { name: "Invite a project collaborator" })).toBeVisible();
  await page.getByLabel("Email address").fill("contractor@example.test");
  await expect(page.getByLabel("Project")).toHaveValue("pa-project-a");
  await page.getByLabel("Give access across this entire client workspace").check();
  await expect(page.getByRole("button", { name: "Send invitation" })).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("current and future projects");
  await page.getByLabel("I understand and want to grant workspace-wide access.").check();
  await expect(page.getByRole("button", { name: "Send invitation" })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
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

test("request v2 is fail-closed and preserves legacy creation when the server capability is off", async ({ page }) => {
  await mockAuthorizedPortal(page, null, requests, undefined, undefined, false);
  await page.goto("/portal/requests/new");
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
  const mapBox = await map.boundingBox();
  const mapRegionBox = await page.locator(".portal-request-map").boundingBox();
  const titleBox = await page.getByRole("heading", { name: "Show us the work area" }).boundingBox();
  expect(mapBox).not.toBeNull();
  expect(mapRegionBox).not.toBeNull();
  expect(titleBox).not.toBeNull();
  const mobile = testInfo.project.name.includes("mobile");
  expect(mapRegionBox!.width).toBeGreaterThanOrEqual(page.viewportSize()!.width * (mobile ? 0.7 : 0.6));
  expect(mapBox!.width).toBeGreaterThanOrEqual(mapRegionBox!.width - 40);
  expect(mapBox!.height).toBeGreaterThanOrEqual(mobile ? 430 : 560);
  expect(mapRegionBox!.y).toBeGreaterThan(titleBox!.y);
  expect(mapBox!.x).toBeGreaterThanOrEqual(0);
  expect(mapBox!.x + mapBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);

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
          }, 120);
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
