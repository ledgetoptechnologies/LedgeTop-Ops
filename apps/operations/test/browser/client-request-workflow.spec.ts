import { expect, test, type Page } from "@playwright/test";

const requestRecord = {
  id: "request-a",
  account_name: "Acme Surveying",
  project_name: "North Site",
  client_name: "Acme",
  parent_request_id: null,
  request_type: "flight",
  title: "North site progress flight",
  details: "Capture progress and review https://example.com/site-notes",
  location_text: "100 Main St",
  preferred_start_at: "2026-08-10T15:00:00.000Z",
  service_category: "Progress mapping",
  deliverables_text: "Orthomosaic and progress photos",
  site_contact_name: "Alex Client",
  site_contact_email: "alex@example.com",
  site_contact_phone: "555-0100",
  desired_completion_at: "2026-08-12T20:00:00.000Z",
  latitude: 44.5,
  longitude: -88.1,
  area_geojson: JSON.stringify({ type: "Polygon", coordinates: [[[-88.2, 44.4], [-88.0, 44.4], [-88.0, 44.6], [-88.2, 44.4]]] }),
  poi_points_json: JSON.stringify([{ longitude: -88.1, latitude: 44.5, label: "Launch point" }]),
  status: "submitted",
  created_at: "2026-08-01T12:00:00.000Z",
  updated_at: "2026-08-01T12:00:00.000Z",
};

test("legacy request deep links redirect to canonical review and preserve the full workflow", async ({ page }) => {
  let estimateReady = false;
  const policyErrors: string[] = [];
  page.on("console", message => {
    if (message.type() === "error" && /content security policy|refused to/i.test(message.text())) policyErrors.push(message.text());
  });
  await page.route("https://api.mapbox.com/**", async route => {
    const url = new URL(route.request().url());
    await route.fulfill(url.pathname.includes("/styles/v1/")
      ? { json: { version: 8, name: "LTDS test", sources: {}, layers: [] } }
      : { status: 204, body: "" });
  });
  await page.route("https://events.mapbox.com/**", route => route.fulfill({ status: 204, body: "" }));
  await page.route("**/api/**", async route => {
    const incoming = route.request();
    const path = new URL(incoming.url()).pathname;
    if (path === "/api/session") {
      await route.fulfill({ json: { user: { id: "staff-a", email: "staff@example.com", displayName: "Staff Reviewer", status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["dashboard.view", "operations.view", "operations.manage"], divisions: [] }, csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: "pk.local-browser-test", capabilities: {} } });
    } else if (incoming.method() === "GET" && path === "/api/client-service-requests") {
      await route.fulfill({ json: { requests: [requestRecord] } });
    } else if (incoming.method() === "GET" && ["/api/client-service-requests/request-a/pa-draft", "/api/client-service-requests/request-child/pa-draft"].includes(path)) {
      await route.fulfill({ json: { capability: { enabled: false, reason: "not configured" }, receipt: null } });
    } else if (incoming.method() === "GET" && path === "/api/client-service-requests/request-a") {
      await route.fulfill({ json: { request: requestRecord, capabilities: { legacyPaQuoteLinkEnabled: true }, services: [{ publicId: "svc-2d-mapping", sourceVersion: "catalog-item-v3", name: "2D Mapping", summary: "Orthomosaic mapping for the submitted work area.", category: "Mapping", geometryRequirement: "required", integrity: "verified", answers: [{ questionId: "deliverable_format", label: "Preferred deliverable", displayValue: "Orthomosaic" }, { questionId: "ground_resolution", label: "Target ground resolution", displayValue: "2.5 cm/pixel" }] }], revisions: [{ revision_number: 1, author_type: "client", author_id: "client-a", action: "submitted", snapshot_json: "{}", note: null, created_at: requestRecord.created_at }], estimates: estimateReady ? [{ id: "estimate-a", version: 1, scope_text: "Progress capture and orthomosaic", estimate_amount_minor: 125000, currency: "USD", status: "ready", client_response_note: null, updated_at: requestRecord.updated_at }] : [], history: [{ actor_id: "staff-a", action: "review_opened", details_json: null, created_at: requestRecord.created_at }], children: [{ id: "request-child", title: "Add east parcel", status: "submitted", created_at: requestRecord.created_at }] } });
    } else if (incoming.method() === "POST" && path === "/api/client-service-requests/request-a/estimate") {
      expect(incoming.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(incoming.postDataJSON()).toEqual({
        scope: "Progress capture and orthomosaic",
        proposedFields: null,
        status: "ready",
      });
      estimateReady = true;
      await route.fulfill({ status: 201, json: { id: "estimate-a", version: 1, status: "ready", idempotentReplay: false } });
    } else if (incoming.method() === "GET" && path === "/api/client-service-requests/request-child") {
      await route.fulfill({ json: { request: { ...requestRecord, id: "request-child", parent_request_id: "request-a", title: "Add east parcel" }, revisions: [], estimates: [], history: [], children: [] } });
    } else {
      await route.fulfill({ status: 404, json: { error: "Not found" } });
    }
  });

  await page.goto("/operations/client-requests/request-a");
  await expect(page).toHaveURL(/\/clients\/requests\/request-a$/);
  await expect(page.getByRole("heading", { name: "North site progress flight" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Selected services (1)" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "2D Mapping" })).toBeVisible();
  await expect(page.getByText("Preferred deliverable")).toBeVisible();
  await expect(page.getByText("Orthomosaic", { exact: true })).toBeVisible();
  await expect(page.getByText("Target ground resolution")).toBeVisible();
  await expect(page.getByText("2.5 cm/pixel")).toBeVisible();
  await expect(page.getByText(/unit price|private formula/i)).toHaveCount(0);
  await expect(page.getByText("Orthomosaic and progress photos")).toBeVisible();
  await expect(page.getByText("Alex Client · alex@example.com · 555-0100")).toBeVisible();
  await expect(page.locator(".mapboxgl-canvas")).toBeVisible();
  await expect(page.getByRole("link", { name: "Google Maps" })).toHaveAttribute("href", /^https:\/\/www\.google\.com\/maps\/search/);
  await expect(page.getByRole("link", { name: "Apple Maps" })).toHaveAttribute("href", /^https:\/\/maps\.apple\.com\//);
  await expect(page.getByText(/not a guaranteed road or safe launch location/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "Download original KML" })).toHaveAttribute(
    "href",
    "/api/client-service-requests/request-a/area.kml?revision=original",
  );
  await expect(page.getByRole("link", { name: "Download current KML" })).toHaveAttribute(
    "href",
    "/api/client-service-requests/request-a/area.kml?revision=effective",
  );
  await expect(page.getByText(/Pricing is created and reviewed in Project Alpha/i)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Scope proposal" })).toBeVisible();
  await expect(page.getByLabel("Optional non-binding estimate")).toHaveCount(0);
  await expect(page.getByText("Revision 1 · submitted")).toBeVisible();
  await expect(page.getByText("review opened")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add east parcel" })).toBeVisible();

  await page.getByLabel("Scope proposal").fill("Progress capture and orthomosaic");
  await page.getByRole("button", { name: "Send for client confirmation" }).click();
  await expect(page.getByText("Scope proposal ready")).toBeVisible();
  await expect(page.getByText(/\$1,250(?:\.00)?/)).toHaveCount(0);
  expect(policyErrors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const selectedServices = page.locator(".request-services-card");
  const selectedServicesBox = await selectedServices.boundingBox();
  expect(selectedServicesBox).not.toBeNull();
  expect(selectedServicesBox!.x).toBeGreaterThanOrEqual(0);
  expect(selectedServicesBox!.x + selectedServicesBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
});

test("request queue distinguishes a schema update from an empty queue and recovers on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let attempts = 0;
  await page.route("**/api/**", async route => {
    const incoming = route.request();
    const path = new URL(incoming.url()).pathname;
    if (path === "/api/session") {
      await route.fulfill({ json: { user: { id: "staff-a", email: "staff@example.com", displayName: "Staff Reviewer", status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["dashboard.view", "operations.view", "operations.manage"], divisions: [] }, csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    } else if (incoming.method() === "GET" && path === "/api/client-service-requests") {
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({ status: 503, json: {
          error: "Client request data is temporarily unavailable while its database update finishes.",
          code: "CLIENT_REQUEST_SCHEMA_OUTDATED",
        } });
      } else {
        await route.fulfill({ json: { requests: [requestRecord] } });
      }
    } else {
      await route.fulfill({ status: 404, json: { error: "Not found" } });
    }
  });

  await page.goto("/clients");
  await expect(page.getByText("Request queue unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText(/database update has not finished/i)).toBeVisible();
  await expect(page.getByText("No client requests")).toHaveCount(0);
  await page.getByRole("button", { name: "Retry queue" }).click();
  await expect(page.getByText("North site progress flight")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

async function mockRequestLocation(page: Page, latitude: number | null, longitude: number | null) {
  const request = { ...requestRecord, latitude, longitude, area_geojson: null, poi_points_json: "[]" };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-a", email: "staff@example.com", displayName: "Staff Reviewer", status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["operations.view", "operations.manage"], divisions: [] },
      csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
    } });
    if (path === "/api/client-service-requests") return route.fulfill({ json: { requests: [request] } });
    if (path === "/api/client-service-requests/request-a") return route.fulfill({ json: {
      request, services: [], revisions: [], estimates: [], history: [], children: [], areaRevisions: [],
      effectiveWorkArea: { revisionNumber: 0, areaGeoJson: null, poiPointsJson: "[]", reason: null, changeSummary: null, createdBy: null, createdAt: null },
      capabilities: { legacyPaQuoteLinkEnabled: false },
    } });
    if (path === "/api/client-service-requests/request-a/pa-draft") return route.fulfill({ json: {
      capability: { enabled: false, reason: "not configured" }, receipt: null,
    } });
    if (path === "/api/client-service-requests/request-a/attachments") return route.fulfill({ json: { attachments: [] } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
}

test("a request without geometry or selected coordinates has no external navigation", async ({ page }) => {
  await mockRequestLocation(page, null, null);
  await page.goto("/clients/requests/request-a");
  await expect(page.getByRole("heading", { name: requestRecord.title })).toBeVisible();
  await expect(page.getByRole("region", { name: "External navigation" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Google Maps" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Apple Maps" })).toHaveCount(0);
  await expect(page.getByText("0.000000, 0.000000", { exact: true })).toHaveCount(0);
});

test("a genuine zero-coordinate request keeps usable navigation inside the mobile panel", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockRequestLocation(page, 0, 0);
  await page.goto("/clients/requests/request-a");
  const navigation = page.getByRole("region", { name: "External navigation" });
  await expect(navigation).toBeVisible();
  const google = navigation.getByRole("link", { name: "Google Maps" });
  const apple = navigation.getByRole("link", { name: "Apple Maps" });
  await expect(google).toHaveAttribute("href", "https://www.google.com/maps/search/?api=1&query=0.000000%2C0.000000");
  await expect(apple).toHaveAttribute("href", "https://maps.apple.com/?ll=0.000000%2C0.000000&q=100%20Main%20St");
  await google.focus();
  await expect(google).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(apple).toBeFocused();
  const bounds = await navigation.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
  for (const link of [google, apple]) {
    const box = await link.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x).toBeGreaterThanOrEqual(bounds!.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
  }
  expect(await navigation.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await navigation.screenshot({ path: testInfo.outputPath("request-navigation-zero-375.png") });
});
