import { expect, test } from "@playwright/test";

const requestRecord = {
  id: "request-a",
  account_name: "Acme Surveying",
  project_name: "North Site",
  client_name: "Acme",
  parent_request_id: null,
  request_type: "service",
  title: "North site mapping",
  details: "Capture the approved work area.",
  location_text: "100 Main St",
  preferred_start_at: null,
  service_category: "Mapping",
  deliverables_text: "Orthomosaic",
  site_contact_name: "Alex Client",
  site_contact_email: "alex@example.com",
  site_contact_phone: null,
  desired_completion_at: null,
  latitude: null,
  longitude: null,
  area_geojson: null,
  poi_points_json: "[]",
  status: "submitted",
  created_at: "2026-08-01T12:00:00.000Z",
  updated_at: "2026-08-01T12:00:00.000Z",
};

test("staff can review and download accepted supporting files on desktop and mobile", async ({ page }) => {
  await page.route("**/api/**", async route => {
    const incoming = route.request(), path = new URL(incoming.url()).pathname;
    if (path === "/api/session") {
      await route.fulfill({ json: {
        user: {
          id: "staff-a",
          email: "staff@example.com",
          displayName: "Staff Reviewer",
          status: "Active",
          profileType: "Administrator",
          isAdministrator: true,
          permissions: ["dashboard.view", "operations.view", "operations.manage"],
          divisions: [],
        },
        csrfToken: "csrf-test",
        timezone: "America/Chicago",
        mapStyleUrl: null,
        mapboxPublicToken: null,
        capabilities: {},
      } });
    } else if (path === "/api/client-service-requests") {
      await route.fulfill({ json: { requests: [requestRecord] } });
    } else if (path === "/api/client-service-requests/request-a") {
      await route.fulfill({ json: {
        request: requestRecord,
        revisions: [],
        estimates: [],
        history: [],
        children: [],
        areaRevisions: [],
        effectiveWorkArea: {
          revisionNumber: 0,
          areaGeoJson: null,
          poiPointsJson: "[]",
          reason: null,
          changeSummary: null,
          createdBy: null,
          createdAt: null,
        },
      } });
    } else if (path === "/api/client-service-requests/request-a/attachments") {
      await route.fulfill({ json: { attachments: [{
        id: "attachment-a",
        name: "work authorization.pdf",
        contentType: "application/pdf",
        size: 2048,
        downloadPath: "/api/client-service-requests/request-a/attachments/attachment-a/download",
      }] } });
    } else if (path === "/api/client-service-requests/request-a/attachments/attachment-a/download") {
      await route.fulfill({
        body: "authorized attachment",
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="work authorization.pdf"',
        },
      });
    } else {
      await route.fulfill({ status: 404, json: { error: "Not found" } });
    }
  });

  await page.goto("/operations/client-requests/request-a");
  await expect(page.getByRole("heading", { name: "North site mapping" })).toBeVisible();
  await expect(page.getByText("Supporting files", { exact: true })).toBeVisible();
  await expect(page.getByText("PDF · 2.0 KB")).toBeVisible();
  const supportingCard = page.getByText("Supporting files", { exact: true }).locator("..");
  await expect(supportingCard.getByRole("button", { name: /delete|edit/i })).toHaveCount(0);
  const link = page.getByRole("link", { name: "Download work authorization.pdf" });
  await expect(link).toHaveAttribute(
    "href",
    "/api/client-service-requests/request-a/attachments/attachment-a/download",
  );
  await expect(link).toHaveAttribute("download", "");
  await expect(page.getByText(/quarantine\/request-attachments/i)).toHaveCount(0);

  await Promise.all([page.waitForEvent("download"), link.click()]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
