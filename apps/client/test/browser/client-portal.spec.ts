import { expect, test, type Page } from "@playwright/test";

const account = { id: "account-a", displayName: "Acme Surveying" };
const projects = [{ id: "project-a", externalRef: "ALPHA-1", clientName: "Acme", projectName: "North Site", canRequestService: true }];
const requests = [{
  id: "request-a",
  projectId: "project-a",
  requestType: "flight",
  title: "Existing flight",
  details: "Existing request",
  location: null,
  preferredStartAt: null,
  status: "submitted",
  createdAt: "2026-07-31T12:00:00.000Z",
  updatedAt: "2026-07-31T12:00:00.000Z",
}];

async function mockAuthorizedPortal(page: Page) {
  await page.route("**/api/client/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/client/session") {
      await route.fulfill({ json: { account, capabilities: { manageTeam: true, viewBilling: false } } });
    } else if (request.method() === "GET" && path === "/api/client/projects") {
      await route.fulfill({ json: { projects } });
    } else if (request.method() === "GET" && path === "/api/client/service-requests") {
      await route.fulfill({ json: { requests } });
    } else if (request.method() === "GET" && path === "/api/client/projects/project-a/deliveries") {
      await route.fulfill({ json: { deliveries: [{ shareId: "share-a", publicId: "public-a", shareVersion: 1, label: "Final deliverables", expiresAt: null, requiresPassword: true, handoffPath: "/api/client/projects/project-a/deliveries/share-a/handoff" }] } });
    } else if (request.method() === "POST" && path === "/api/client/service-requests") {
      expect(request.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(request.postDataJSON()).toMatchObject({ projectId: "project-a", requestType: "flight", title: "Progress flight" });
      await route.fulfill({ status: 201, json: { request: { ...requests[0], id: "request-created", title: "Progress flight" } } });
    } else {
      await route.fulfill({ status: 404, json: { error: "Not found" } });
    }
  });
}

test("authorized portal supports project, delivery, and request workflows", async ({ page }) => {
  await mockAuthorizedPortal(page);
  await page.goto("/portal");
  await expect(page.getByRole("heading", { name: "Welcome, Acme Surveying" })).toBeVisible();
  await expect(page.getByText("1", { exact: true }).first()).toBeVisible();

  await page.getByRole("link", { name: "Projects" }).click();
  await expect(page.getByRole("heading", { name: "North Site" })).toBeVisible();
  await expect(page.getByText("Requests enabled")).toBeVisible();

  await page.getByRole("link", { name: "Deliveries" }).click();
  await expect(page.getByText("Final deliverables")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open delivery" })).toHaveAttribute("href", "/api/client/projects/project-a/deliveries/share-a/handoff");

  await page.getByRole("link", { name: "Requests" }).click();
  await page.getByLabel("Title").fill("Progress flight");
  await page.getByLabel("Details").fill("Capture the latest grading progress.");
  await page.getByRole("button", { name: "Submit request" }).click();
  await expect(page.getByText("Request submitted. LTDS will review it shortly.")).toBeVisible();
  await expect(page.getByText("Progress flight")).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
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
