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

async function mockAuthorizedPortal(
  page: Page,
  mapboxPublicToken: string | null = null,
  fixtureRequests = requests,
  workflowEvents?: { edited?: boolean; changeRequested?: boolean; estimateAccepted?: boolean },
  locationFixtures: { project: DeliveryLocationCollection; past: DeliveryLocationCollection } = {
    project: { points: [], imageCount: 0, truncated: false },
    past: { points: [], imageCount: 0, truncated: false },
  },
) {
  await page.route("**/api/client/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/client/session") {
      await route.fulfill({ json: { account, capabilities: { manageTeam: true, viewBilling: false } } });
    } else if (request.method() === "GET" && path === "/api/client/map-config") {
      await route.fulfill({ json: { mapboxPublicToken } });
    } else if (request.method() === "GET" && path === "/api/client/projects") {
      await route.fulfill({ json: { projects } });
    } else if (request.method() === "GET" && path === "/api/client/service-requests") {
      await route.fulfill({ json: { requests: fixtureRequests } });
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

test("authorized portal supports project, delivery, and request workflows", async ({ page }) => {
  await mockAuthorizedPortal(page);
  await page.goto("/portal");
  await expect(page.getByRole("heading", { name: "Welcome, Acme Surveying" })).toBeVisible();
  await expect(page.getByText("1", { exact: true }).first()).toBeVisible();

  await page.getByRole("link", { name: "Projects" }).click();
  await expect(page.getByRole("heading", { name: "North Site" })).toBeVisible();
  await expect(page.getByText("Aerial progress documentation")).toBeVisible();
  await page.getByRole("button", { name: /North Site/ }).click();
  await expect(page.getByRole("heading", { name: "North Site" })).toBeVisible();
  await page.getByRole("button", { name: "Files" }).click();
  await expect(page.getByText("final.pdf")).toBeVisible();
  await expect(page.getByRole("link", { name: "Download" })).toHaveAttribute("href", "/api/client/files/file-a/download?projectId=project-a");

  await page.getByRole("link", { name: "Past deliveries" }).click();
  await expect(page.getByText("historic-orthomosaic.tif")).toBeVisible();

  await page.getByRole("link", { name: "Service requests" }).click();
  await expect(page.getByRole("heading", { name: "Request history" })).toBeVisible();
  await expect(page.getByText("North Site monthly progress imagery")).toBeVisible();
  await expect(page.getByLabel("Service request title")).toHaveCount(0);
  await page.getByRole("button", { name: "Submit new request" }).click();
  await expect(page).toHaveURL(/\/portal\/requests\/new$/);
  await expect(page.getByText("New or one-off service. LTDS will review and triage this request before any project setup. This screen does not create or change a Project Alpha project.")).toBeVisible();
  await page.getByLabel(/Project/).selectOption("project-a");
  await expect(page.getByText("Existing project: North Site. LTDS will triage this request in that project context. This screen does not create or change a Project Alpha project.")).toBeVisible();
  await page.getByLabel("Service request title").fill("North Site spring imagery");
  await page.getByLabel("What do you need?").fill("Capture the latest grading progress.");
  await page.getByRole("button", { name: "Submit request" }).click();
  await expect(page.getByText("Request submitted. LTDS will review it shortly.")).toBeVisible();
  await expect(page.getByText("North Site spring imagery")).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
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
  await page.getByRole("link", { name: "Projects" }).click();
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
  await page.getByRole("link", { name: "Past deliveries" }).click();
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
  await expect(page.locator(".portal-map-canvas")).toBeVisible();
  await expect(page.locator(".mapboxgl-canvas")).toBeVisible();
  expect(policyErrors).toEqual([]);
});

test("request map is primary, responsive, accessible, and supports targeted POI removal", async ({ page }, testInfo) => {
  await mockMapbox(page);
  await mockAuthorizedPortal(page, "pk.local-browser-test");
  await page.goto("/portal/requests/new");

  const map = page.locator(".portal-map-canvas");
  const canvas = page.locator(".mapboxgl-canvas");
  await expect(map).toBeVisible();
  await expect(canvas).toBeVisible();
  const mapBox = await map.boundingBox();
  const mapRegionBox = await page.locator(".portal-request-map").boundingBox();
  const requestFieldsBox = await page.locator(".portal-request-fields").boundingBox();
  const titleBox = await page.getByLabel("Service request title").boundingBox();
  expect(mapBox).not.toBeNull();
  expect(mapRegionBox).not.toBeNull();
  expect(requestFieldsBox).not.toBeNull();
  expect(titleBox).not.toBeNull();
  const mobile = testInfo.project.name.includes("mobile");
  if (mobile) expect(mapBox!.width).toBeGreaterThanOrEqual(page.viewportSize()!.width * 0.8);
  else expect(mapRegionBox!.width).toBeGreaterThan(requestFieldsBox!.width);
  expect(mapBox!.height).toBeGreaterThanOrEqual(mobile ? 430 : 560);
  expect(mapRegionBox!.y).toBeLessThan(titleBox!.y);
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
  await expect(page.getByLabel(/Location/)).toHaveValue("100 Main Avenue, Green Bay, Wisconsin 54303");

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

  const locate = page.getByRole("button", { name: "Use current location" });
  await locate.click();
  await expect(page.getByRole("button", { name: "Locating…" })).toHaveAttribute("aria-busy", "true");
  await expect(page.getByText("Finding your approximate location… You can keep using the map while this runs.")).toBeVisible();
  await expect(page.getByText("Location permission was declined. You can still search an address or add points on the map.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Use current location" })).toBeEnabled();

  await page.getByRole("button", { name: "Use current location" }).click();
  await expect(page.getByText("Current location found and added as a point of interest.")).toBeVisible();
  await expect(page.getByLabel(/Location/)).toHaveValue("Broadway, Green Bay, Wisconsin");
  await expect(page.getByRole("button", { name: "Current location 44.501000, -88.071000" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove Current location" })).toBeVisible();
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
