import { expect, test, type Page } from "@playwright/test";

const originalArea = JSON.stringify({
  type: "Polygon",
  coordinates: [[[-88.2, 44.4], [-88.0, 44.4], [-88.0, 44.6], [-88.2, 44.4]]],
});

async function mockMapbox(page: Page) {
  await page.route("https://api.mapbox.com/**", async route => {
    const url = new URL(route.request().url());
    await route.fulfill(url.pathname.includes("/styles/v1/")
      ? { json: { version: 8, name: "LTDS test", sources: {}, layers: [] } }
      : { status: 204, body: "" });
  });
  await page.route("https://events.mapbox.com/**", route => route.fulfill({ status: 204, body: "" }));
}

async function fixture(page: Page) {
  let revised = false;
  let submittedBody: Record<string, unknown> | null = null;
  const baseRequest = {
    id: "request-area",
    account_name: "Acme Surveying",
    project_name: "North Site",
    client_name: "Acme",
    parent_request_id: null,
    request_type: "service",
    title: "North site mapping",
    details: "Capture the approved parcel.",
    location_text: "North parcel",
    preferred_start_at: null,
    service_category: "2D mapping",
    deliverables_text: "Orthomosaic",
    site_contact_name: null,
    site_contact_email: null,
    site_contact_phone: null,
    desired_completion_at: null,
    latitude: 44.5,
    longitude: -88.1,
    area_geojson: originalArea,
    poi_points_json: "[]",
    status: "submitted",
    created_at: "2026-08-01T12:00:00.000Z",
    updated_at: "2026-08-01T12:00:00.000Z",
  };
  await mockMapbox(page);
  await page.route("**/api/**", async route => {
    const incoming = route.request(), path = new URL(incoming.url()).pathname;
    if (path === "/api/session")
      return route.fulfill({ json: { user: { id: "staff-area", email: "staff@example.test", displayName: "Staff Reviewer", status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["operations.view", "operations.manage"], divisions: [] }, csrfToken: "csrf-area", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: "pk.local-browser-test", capabilities: {} } });
    if (incoming.method() === "GET" && path === "/api/client-service-requests")
      return route.fulfill({ json: { requests: [baseRequest] } });
    if (incoming.method() === "GET" && path === "/api/client-service-requests/request-area")
      return route.fulfill({ json: {
        request: { ...baseRequest, status: revised ? "under_review" : "submitted", updated_at: revised ? "2026-08-13 18:00:00.123" : baseRequest.updated_at },
        revisions: [{ revision_number: 1, author_type: "client", action: "submitted", snapshot_json: "{}", note: null, created_at: baseRequest.created_at }],
        estimates: [], history: [], children: [],
        areaRevisions: revised ? [{ id: "revision-1", revision_number: 1, reason: "Exclude the neighboring parcel.", change_summary: "service-area boundary adjusted", created_by: "staff-area", created_at: "2026-08-13T18:00:00.000Z" }] : [],
        effectiveWorkArea: revised
          ? { revisionNumber: 1, areaGeoJson: originalArea, poiPointsJson: "[]", reason: "Exclude the neighboring parcel.", changeSummary: "service-area boundary adjusted", createdBy: "staff-area", createdAt: "2026-08-13T18:00:00.000Z" }
          : { revisionNumber: 0, areaGeoJson: originalArea, poiPointsJson: "[]", reason: null, changeSummary: null, createdBy: null, createdAt: null },
      } });
    if (incoming.method() === "POST" && path === "/api/client-service-requests/request-area/work-area") {
      submittedBody = incoming.postDataJSON() as Record<string, unknown>;
      expect(incoming.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      revised = true;
      return route.fulfill({ status: 201, json: { revision: { id: "revision-1", revisionNumber: 1, changeSummary: "service-area boundary adjusted" }, requestUpdatedAt: "2026-08-13 18:00:00.123", projectAlphaScopeMarkedStale: false, idempotentReplay: false } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return { submittedBody: () => submittedBody };
}

test("staff review is read-only until Edit and saves an explicit immutable work-area revision", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/clients/requests/request-area");
  await expect(page.getByRole("heading", { name: "North site mapping" })).toBeVisible();
  await expect(page.getByLabel("Reason for change")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit work area" })).toBeVisible();

  await page.getByRole("button", { name: "Edit work area" }).click();
  await expect(page.getByLabel("Editable service request work area")).toBeVisible();
  await page.getByLabel("Reason for change").fill("Exclude the neighboring parcel.");
  await page.getByRole("button", { name: "Save work-area revision" }).click();

  await expect(page.getByText("Staff revision 1 is effective")).toBeVisible();
  expect(state.submittedBody()).toMatchObject({
    expectedUpdatedAt: "2026-08-01T12:00:00.000Z",
    expectedRevision: 0,
    reason: "Exclude the neighboring parcel.",
    areaGeoJson: JSON.parse(originalArea),
    poiPoints: [],
  });
  await expect(page.getByRole("link", { name: "Download original KML" })).toHaveAttribute("href", "/api/client-service-requests/request-area/area.kml?revision=original");
  await expect(page.getByRole("link", { name: "Download current KML" })).toHaveAttribute("href", "/api/client-service-requests/request-area/area.kml?revision=effective");
});

test("work-area editor remains usable without horizontal overflow on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await page.goto("/clients/requests/request-area");
  await page.getByRole("button", { name: "Edit work area" }).click();
  await expect(page.getByRole("button", { name: "Draw area" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add point" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save work-area revision" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
