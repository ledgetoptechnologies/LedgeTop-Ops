import { expect, test } from "@playwright/test";

const request = {
  id: "request-pa-draft",
  account_name: "Acme Surveying",
  project_name: "North Site",
  client_name: "Acme",
  parent_request_id: null,
  request_type: "service",
  title: "North site mapping",
  details: "Capture the reviewed work area.",
  location_text: "100 Main St",
  preferred_start_at: null,
  service_category: "Orthomosaic",
  deliverables_text: "Orthomosaic and stills",
  site_contact_name: null,
  site_contact_email: null,
  site_contact_phone: null,
  desired_completion_at: null,
  latitude: null,
  longitude: null,
  area_geojson: null,
  poi_points_json: "[]",
  status: "accepted_pending_pa_linkage",
  created_at: "2026-08-01T12:00:00.000Z",
  updated_at: "2026-08-01T12:00:00.000Z",
};

test("staff explicitly creates a private Project Alpha draft and opens the PA editor", async ({ page }) => {
  let created = false;
  const runtimeErrors: string[] = [];
  page.on("pageerror", error => runtimeErrors.push(error.stack || error.message));
  page.on("console", message => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  await page.route("**/api/**", async route => {
    const incoming = route.request();
    const path = new URL(incoming.url()).pathname;
    if (path === "/api/session") {
      await route.fulfill({ json: {
        user: { id: "staff-a", email: "staff@example.com", displayName: "Staff Reviewer", status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["dashboard.view", "operations.view", "operations.manage"], divisions: [] },
        csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
      } });
    } else if (incoming.method() === "GET" && path === "/api/client-service-requests") {
      await route.fulfill({ json: { requests: [request] } });
    } else if (incoming.method() === "GET" && path === "/api/client-service-requests/request-pa-draft") {
      await route.fulfill({ json: {
        request,
        capabilities: { legacyPaQuoteLinkEnabled: true },
        services: [{
          publicId: "svc-2d-mapping", sourceVersion: "catalog-v3", name: "2D Mapping",
          summary: null, category: "Mapping", geometryRequirement: "required",
          integrity: "verified", answers: [],
        }],
        revisions: [], estimates: [], history: [], children: [], areaRevisions: [],
        effectiveWorkArea: { revisionNumber: 0, areaGeoJson: null, poiPointsJson: "[]", reason: null, changeSummary: null, createdBy: null, createdAt: null },
      } });
    } else if (incoming.method() === "GET" && path === "/api/client-service-requests/request-pa-draft/attachments") {
      await route.fulfill({ json: { attachments: [] } });
    } else if (incoming.method() === "GET" && path === "/api/client-service-requests/request-pa-draft/pa-draft") {
      await route.fulfill({ json: {
        capability: { enabled: true, reason: null },
        receipt: created ? {
          requestRevision: 3, areaRevision: 0, createdAt: "2026-08-13T12:00:00.000Z",
          editorUrl: "https://project-alpha.example/quotes/quote-public-a/edit",
          receiptId: "receipt-public-a",
          draftQuote: { publicId: "quote-public-a", documentNumber: "Q-DRAFT-7", status: "draft", version: 1, editorPath: "/quotes/quote-public-a/edit" },
        } : null,
      } });
    } else if (incoming.method() === "POST" && path === "/api/client-service-requests/request-pa-draft/pa-draft") {
      expect(incoming.postData()).toBeNull();
      expect(incoming.headers()["x-csrf-token"]).toBe("csrf-test");
      created = true;
      await route.fulfill({ status: 201, json: {
        requestRevision: 3, areaRevision: 0, createdAt: "2026-08-13T12:00:00.000Z",
        editorUrl: "https://project-alpha.example/quotes/quote-public-a/edit",
        receiptId: "receipt-public-a", idempotentReplay: false,
        draftQuote: { publicId: "quote-public-a", documentNumber: "Q-DRAFT-7", status: "draft", version: 1, editorPath: "/quotes/quote-public-a/edit" },
      } });
    } else {
      await route.fulfill({ status: 404, json: { error: "Not found" } });
    }
  });

  await page.goto("/clients/requests/request-pa-draft");
  await page.waitForTimeout(250);
  expect(runtimeErrors).toEqual([]);
  const create = page.getByRole("button", { name: "Create Project Alpha draft" });
  await expect(create).toBeVisible();
  await expect(create).toBeEnabled();
  await expect(page.getByRole("button", { name: "Link approved Project Alpha quote manually" })).toHaveCount(0);
  await expect(page.getByText(/Manual fallback verifies an already approved Project Alpha quote/i)).toHaveCount(0);
  await create.click();
  await expect(page.getByText("Private Project Alpha draft Q-DRAFT-7")).toBeVisible();
  await expect(page.getByText(/Project Alpha owns pricing, approval, sending, invoicing, and payment/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open draft in Project Alpha" })).toHaveAttribute(
    "href", "https://project-alpha.example/quotes/quote-public-a/edit",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
