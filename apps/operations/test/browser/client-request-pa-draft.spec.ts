import { expect, test, type Page, type Route } from "@playwright/test";

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

const nativeRequest = {
  ...request,
  catalog_source_id: "project-alpha:secondary",
  portal_workspace_id: "native-workspace-a",
  portal_project_public_id: "native-project-a",
};

test("staff explicitly creates a private Project Alpha draft through a source-backed connection and opens its editor", async ({ page }) => {
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
      await route.fulfill({ json: { requests: [nativeRequest] } });
    } else if (incoming.method() === "GET" && path === "/api/client-service-requests/request-pa-draft") {
      await route.fulfill({ json: {
        request: nativeRequest,
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
          sourceId: "project-alpha:secondary", editorUnavailableReason: null,
          editorUrl: "https://secondary-alpha.example/quotes/quote-public-a/edit",
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
        sourceId: "project-alpha:secondary", editorUnavailableReason: null,
        editorUrl: "https://secondary-alpha.example/quotes/quote-public-a/edit",
        receiptId: "receipt-public-a", idempotentReplay: false,
        draftQuote: { publicId: "quote-public-a", documentNumber: "Q-DRAFT-7", status: "draft", version: 1, editorPath: "/quotes/quote-public-a/edit" },
      } });
    } else {
      await route.fulfill({ status: 404, json: { error: "Not found" } });
    }
  });

  await page.goto("/clients/requests/request-pa-draft");
  await expect(page.getByText("Approved · PA draft pending", { exact: true })).toBeVisible();
  const create = page.getByRole("button", { name: "Create Project Alpha draft" });
  await expect(create).toBeVisible();
  await expect(create).toBeEnabled();
  await expect(page.getByRole("button", { name: "Link Project Alpha draft quote manually" })).toHaveCount(0);
  await expect(page.getByText(/Manual fallback links an existing Project Alpha quote record/i)).toHaveCount(0);
  await create.click();
  await expect(page.getByText("Private Project Alpha draft Q-DRAFT-7")).toBeVisible();
  await expect(page.getByText(/Project Alpha owns pricing, approval, sending, invoicing, and payment/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open draft in Project Alpha" })).toHaveAttribute(
    "href", "https://secondary-alpha.example/quotes/quote-public-a/edit",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(runtimeErrors).toEqual([]);
});

const savedReceipt = {
  requestRevision: 3, areaRevision: 0, createdAt: "2026-08-13T12:00:00.000Z",
  sourceId: "project-alpha:primary", editorUnavailableReason: null as string | null,
  editorUrl: "https://original-alpha.example/quotes/quote-public-a/edit" as string | null,
  receiptId: "receipt-public-a",
  draftQuote: { publicId: "quote-public-a", documentNumber: "Q-ORIGINAL-7", status: "draft", version: 1, editorPath: "/quotes/quote-public-a/edit" },
};
const secondRequest = { ...request, id: "request-b", title: "Second source request" };
const detail = (item = request) => ({
  request: item, capabilities: { legacyPaQuoteLinkEnabled: false },
  services: [{ publicId: "svc-2d-mapping", sourceVersion: "catalog-v3", name: "2D Mapping", summary: null, category: "Mapping", geometryRequirement: "required", integrity: "verified", answers: [] }],
  revisions: [], estimates: [], history: [],
  children: item.id === request.id ? [{ id: secondRequest.id, title: secondRequest.title, status: secondRequest.status, created_at: secondRequest.created_at }] : [],
  areaRevisions: [],
  effectiveWorkArea: { revisionNumber: 0, areaGeoJson: null, poiPointsJson: "[]", reason: null, changeSummary: null, createdBy: null, createdAt: null },
});
async function installFixture(page: Page, draft: (route: Route, id: string) => Promise<void>) {
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const match = path.match(/^\/api\/client-service-requests\/([^/]+)(\/.*)?$/);
    if (path === "/api/session") {
      await route.fulfill({ json: {
        user: { id: "staff-a", email: "staff@example.com", displayName: "Staff Reviewer", status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["dashboard.view", "operations.view", "operations.manage"], divisions: [] },
        csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
      } });
    } else if (path === "/api/client-service-requests") {
      await route.fulfill({ json: { requests: [request, secondRequest] } });
    } else if (match?.[2] === "/pa-draft") {
      await draft(route, match[1]!);
    } else if (match?.[2] === "/attachments") {
      await route.fulfill({ json: { attachments: [] } });
    } else if (match && !match[2]) {
      await route.fulfill({ json: detail(match[1] === request.id ? request : secondRequest) });
    } else {
      await route.fulfill({ status: 404, json: { error: "Not found" } });
    }
  });
}

test("a disabled connection preserves a historical receipt without inventing an editor destination", async ({ page }) => {
  await installFixture(page, async route => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({ json: {
      capability: { enabled: false, reason: "This request's business source has no configured quote connection" },
      receipt: { ...savedReceipt, editorUrl: null, editorUnavailableReason: "legacy_destination_unknown" },
    } });
  });
  await page.goto(`/clients/requests/${request.id}`);
  await expect(page.getByRole("button", { name: "Create Project Alpha draft" })).toBeDisabled();
  await expect(page.getByText("This request's business source has no configured quote connection")).toBeVisible();
  await expect(page.getByText("Private Project Alpha draft Q-ORIGINAL-7")).toBeVisible();
  await expect(page.getByText(/historical receipt does not record its original Project Alpha destination/)).toBeVisible();
  await expect(page.getByText(/Saved for request revision 3 · Work-area revision 0/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open draft in Project Alpha" })).toHaveCount(0);
  await expect(page.locator(".pa-draft-receipt")).toHaveCSS("flex-direction", "column");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("quote-receipt.png"), fullPage: true, scale: "css", animations: "disabled" });
});

test("an unavailable current connector does not replace the original receipt destination", async ({ page }) => {
  await installFixture(page, async route => {
    await route.fulfill({ json: {
      capability: { enabled: false, reason: "The configured quote connection changed." }, receipt: savedReceipt,
    } });
  });
  await page.goto(`/clients/requests/${request.id}`);
  await expect(page.getByRole("button", { name: "Create Project Alpha draft" })).toBeDisabled();
  await expect(page.getByRole("link", { name: "Open draft in Project Alpha" })).toHaveAttribute("href", savedReceipt.editorUrl!);
});

test("draft availability errors disable creation and offer a focused retry", async ({ page }) => {
  let reads = 0;
  await installFixture(page, async route => {
    expect(route.request().method()).toBe("GET");
    reads += 1;
    await route.fulfill(reads === 1
      ? { status: 503, json: { error: "Quote connection status temporarily unavailable" } }
      : { json: { capability: { enabled: true, reason: null }, receipt: null } });
  });
  await page.goto(`/clients/requests/${request.id}`);
  const create = page.getByRole("button", { name: "Create Project Alpha draft" });
  await expect(page.getByRole("alert")).toContainText("Quote connection status temporarily unavailable");
  await expect(create).toBeDisabled();
  await page.getByRole("button", { name: "Retry draft status" }).click();
  await expect(create).toBeEnabled();
  expect(reads).toBe(2);
});

test("a successful quote creation refreshes capability instead of assuming it remains enabled", async ({ page }) => {
  let created = false;
  await installFixture(page, async route => {
    if (route.request().method() === "POST") {
      created = true;
      await route.fulfill({ status: 201, json: { ...savedReceipt, idempotentReplay: false } });
    } else {
      await route.fulfill({ json: {
        capability: { enabled: !created, reason: created ? "Quote connection is no longer available." : null },
        receipt: created ? savedReceipt : null,
      } });
    }
  });
  await page.goto(`/clients/requests/${request.id}`);
  await page.getByRole("button", { name: "Create Project Alpha draft" }).click();
  await expect(page.getByText("Private Project Alpha draft Q-ORIGINAL-7")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create Project Alpha draft" })).toBeDisabled();
  await expect(page.getByText("Quote connection is no longer available.")).toBeVisible();
});

test("late quote availability cannot enable or populate a different request", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let firstStarted = false;
  await installFixture(page, async (route, id) => {
    if (id === request.id) {
      firstStarted = true;
      await pending;
      await route.fulfill({ json: { capability: { enabled: true, reason: null }, receipt: savedReceipt } }).catch(() => {});
    } else {
      await route.fulfill({ json: { capability: { enabled: false, reason: "Second source has no quote connection." }, receipt: null } });
    }
  });
  await page.goto(`/clients/requests/${request.id}`);
  await expect.poll(() => firstStarted).toBe(true);
  await expect(page.getByRole("button", { name: "Create Project Alpha draft" })).toBeDisabled();
  await page.getByRole("button", { name: secondRequest.title, exact: true }).click();
  await expect(page.getByRole("heading", { name: secondRequest.title, exact: true })).toBeVisible();
  release();
  await expect(page.getByText("Second source has no quote connection.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create Project Alpha draft" })).toBeDisabled();
  await expect(page.getByText("Private Project Alpha draft Q-ORIGINAL-7")).toHaveCount(0);
  await expect(page).toHaveURL(/\/clients\/requests\/request-b$/);
});

test("an accepted quote response after navigation does not reload or change the new request", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let posts = 0, firstReads = 0;
  await installFixture(page, async (route, id) => {
    if (route.request().method() === "POST") {
      posts += 1;
      await pending;
      await route.fulfill({ status: 201, json: { ...savedReceipt, idempotentReplay: false } });
    } else {
      if (id === request.id) firstReads += 1;
      await route.fulfill({ json: { capability: { enabled: id === request.id, reason: id === request.id ? null : "Second source has no quote connection." }, receipt: null } });
    }
  });
  await page.goto(`/clients/requests/${request.id}`);
  await page.getByRole("button", { name: "Create Project Alpha draft" }).click();
  await expect.poll(() => posts).toBe(1);
  await page.getByRole("button", { name: secondRequest.title, exact: true }).click();
  await expect(page.getByRole("heading", { name: secondRequest.title, exact: true })).toBeVisible();
  const response = page.waitForResponse(value => value.request().method() === "POST" && value.url().endsWith("/pa-draft"));
  release();
  await response;
  await expect(page.getByText("Second source has no quote connection.")).toBeVisible();
  await expect(page.getByText("Private Project Alpha draft Q-ORIGINAL-7")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create Project Alpha draft" })).toBeDisabled();
  expect(firstReads).toBe(1);
});
