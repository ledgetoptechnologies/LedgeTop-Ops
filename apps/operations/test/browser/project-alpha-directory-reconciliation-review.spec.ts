import { expect, test, type Page } from "@playwright/test";

const root = "/api/admin/project-alpha/private/directory/reconciliation";
const findingA = "10000000-0000-4000-8000-000000000001";
const findingB = "10000000-0000-4000-8000-000000000002";

type SessionOptions = { enabled?: boolean; administrator?: boolean; permission?: boolean };
type Outcome = Record<string, unknown>;

async function fixture(page: Page, session: SessionOptions = {}, outcomes: Outcome[] = []) {
  const requests: Array<{ path: string; method: string; url: URL; body: Record<string, unknown> | null; idempotencyKey: string | null }> = [];
  let findingPage = 0, outcomeIndex = 0;
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path === "/api/session") return route.fulfill({ json: {
      user: { id: "admin", email: "admin@example.test", displayName: "Admin", status: "Active",
        profileType: session.administrator === false ? "Employee" : "Administrator",
        isAdministrator: session.administrator !== false,
        permissions: session.permission === false ? ["administration.view"] : ["administration.view", "integrations.manage"], divisions: [] },
      csrfToken: "csrf", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null,
      capabilities: { projectAlphaPrivateAdminTransport: { enabled: session.enabled !== false } },
    } });
    if (path === "/api/admin/integrations/project-alpha/connectors") return route.fulfill({ json: {
      connectors: [], health: [], legacyPrimary: false, configuredUrl: "https://configured-secret.example.test",
    } });
    if (path === "/api/admin/portal-workflow-readiness") return route.fulfill({ json: { ready: false, workflows: {} } });
    if (path === "/api/admin/audit") return route.fulfill({ json: { events: [], nextCursor: null, highWaterId: "0", filters: {} } });
    if (path === `${root}/findings`) {
      requests.push({ path, method: request.method(), url, body: null, idempotencyKey: null });
      findingPage += 1;
      if (url.searchParams.has("cursor")) return route.fulfill({ json: { items: [{
        findingId: findingB, sourceId: "project-alpha:secondary", classification: "revision_mismatch",
        resourceType: "client", reviewState: "resolved", localRecordId: null, localPublicId: null,
        remotePublicId: "b".repeat(32), remoteRevision: "18", present: false, lastAction: "delete",
        bindingRecordId: null, bindingStatus: null, bindingRevision: null, createdAt: "2026-09-22T13:00:00.000Z",
      }], nextCursor: null } });
      return route.fulfill({ json: { items: [{
        findingId: findingA, sourceId: "project-alpha:primary", classification: "extra_remote",
        resourceType: "organization", reviewState: "open", localRecordId: null, localPublicId: null,
        remotePublicId: "a".repeat(32), remoteRevision: "17", present: true, lastAction: "upsert",
        bindingRecordId: "binding-exact", bindingStatus: "active", bindingRevision: "16",
        createdAt: "2026-09-22T12:00:00.000Z", profileJson: { email: "private@example.test" },
        apiKey: "private-api-key", configuredUrl: "https://private.example.test",
      }], nextCursor: "next-findings" } });
    }
    if (path === `${root}/records`) {
      requests.push({ path, method: request.method(), url, body: null, idempotencyKey: null });
      return route.fulfill({ json: { items: [
        { recordId: "native-organization-1", resourceType: "organization", currentVersion: 4,
          displayName: "Able Survey", contactEmail: null },
        { recordId: "native-organization-2", resourceType: "organization", currentVersion: 7,
          displayName: "Zulu Construction", contactEmail: "ops@zulu.example.test" },
      ], nextCursor: null, profileJson: { name: "Private profile" } } });
    }
    if (path === `${root}/findings/${findingA}/context`) return route.fulfill({ json: {
      findingId: findingA, resourceType: "organization", displayName: "Zulu Construction PA",
      contactEmail: "admin@zulu.example.test", organizationPublicId: null,
      profileJson: { phone: "private-phone" }, apiKey: "private-context-key",
    } });
    if (path === `${root}/acquire`) {
      const body = request.postDataJSON() as Record<string, unknown>;
      requests.push({ path, method: request.method(), url, body, idempotencyKey: request.headers()["idempotency-key"] ?? null });
      return route.fulfill({ json: outcomes[outcomeIndex++] ?? {
        status: "acquired", actionId: "20000000-0000-4000-8000-000000000001", findingId: findingA,
        acquiredReceiptId: "20000000-0000-4000-8000-000000000002", replayed: false,
      } });
    }
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  return { requests, findingPages: () => findingPage };
}

test("is hidden unless the session is administrator, globally authorized, and private transport enabled", async ({ page }) => {
  for (const options of [{ enabled: false }, { administrator: false }, { permission: false }]) {
    await page.unrouteAll({ behavior: "wait" });
    const state = await fixture(page, options);
    await page.goto("/administration");
    await expect(page.locator("#project-alpha-reconciliation-review")).toHaveCount(0);
    expect(state.findingPages()).toBe(0);
  }
});

test("pages both sources, exposes only reconciliation metadata, and acquires one explicit exact record inactive", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/administration");
  const panel = page.locator("#project-alpha-reconciliation-review");
  await expect(panel.getByRole("heading", { name: "Project Alpha reconciliation review" })).toBeVisible();
  await expect(panel).toContainText("Ledge Top Drone Services Project Alpha");
  await expect(panel).toContainText("Extra Project Alpha record");
  await expect(panel).toContainText("revision 16");
  await expect(panel).toContainText("Present · Last action upsert");
  await expect(panel).not.toContainText(/private@example|private-api-key|private\.example|configured-secret|Private profile/i);
  const firstRequest = state.requests.find(request => request.path.endsWith("/findings"));
  expect(firstRequest?.url.searchParams.getAll("sourceId")).toEqual(["project-alpha:primary", "project-alpha:secondary"]);
  expect(firstRequest?.url.searchParams.get("limit")).toBe("25");

  await panel.getByRole("button", { name: "Load more findings" }).click();
  await expect(panel).toContainText("Ledge Top Technologies Project Alpha");
  await expect(panel).toContainText("Revision mismatch");

  await panel.getByRole("button", { name: "Choose existing organization record" }).click();
  const selector = panel.getByLabel("Exact existing Operations organization record");
  await expect(selector).toHaveValue("");
  await expect(panel).toContainText("Zulu Construction PA · admin@zulu.example.test");
  await expect(selector.locator("option").nth(1)).toContainText("Able Survey · native-organization-1 · version 4");
  await expect(selector.locator("option").nth(2)).toContainText("Zulu Construction · ops@zulu.example.test · native-organization-2 · version 7");
  await expect(panel).not.toContainText(/private-phone|private-context-key/i);
  expect(state.requests.filter(request => request.method === "POST")).toHaveLength(0);
  const recordRequest = state.requests.find(request => request.path.endsWith("/records"));
  expect(recordRequest?.url.searchParams.get("resourceType")).toBe("organization");
  expect(recordRequest?.url.searchParams.has("search")).toBe(false);
  await selector.selectOption("native-organization-2");
  page.once("dialog", dialog => void dialog.accept());
  await panel.getByRole("button", { name: "Acquire as inactive mapping" }).click();
  await expect(panel.getByRole("article", { name: /Ledge Top Drone Services/ }).getByRole("status"))
    .toContainText("mapping is inactive and pending separate activation review");
  await expect(panel.getByRole("button", { name: /activate/i })).toHaveCount(0);
  const post = state.requests.find(request => request.method === "POST");
  expect(post?.body).toMatchObject({ findingId: findingA, recordId: "native-organization-2", expectedRecordVersion: 7 });
  expect(post?.body).not.toHaveProperty("projectAlphaPublicId");
  expect(post?.body?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(post?.idempotencyKey).toBe(post?.body?.idempotencyKey);

  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});

test("retries an uncertain acquisition with the same UUID and reports stale and conflict outcomes honestly", async ({ page }) => {
  const state = await fixture(page, {}, [
    { status: "uncertain", reason: "remote" },
    { status: "blocked", reason: "stale_snapshot" },
  ]);
  await page.goto("/administration");
  const panel = page.locator("#project-alpha-reconciliation-review");
  await panel.getByRole("button", { name: "Choose existing organization record" }).click();
  await panel.getByLabel("Exact existing Operations organization record").selectOption("native-organization-1");
  page.once("dialog", dialog => void dialog.accept());
  await panel.getByRole("button", { name: "Acquire as inactive mapping" }).click();
  await expect(panel.getByRole("alert")).toContainText("outcome is uncertain");
  page.once("dialog", dialog => void dialog.accept());
  await panel.getByRole("button", { name: "Acquire as inactive mapping" }).click();
  await expect(panel.getByRole("alert")).toContainText("snapshot or record version changed");
  const posts = state.requests.filter(request => request.method === "POST");
  expect(posts).toHaveLength(2);
  expect(posts[0]?.idempotencyKey).toBe(posts[1]?.idempotencyKey);

  await page.unrouteAll({ behavior: "wait" });
  await fixture(page, {}, [{ status: "conflict", reason: "reservation" }]);
  await page.goto("/administration");
  const conflictPanel = page.locator("#project-alpha-reconciliation-review");
  await conflictPanel.getByRole("button", { name: "Choose existing organization record" }).click();
  await conflictPanel.getByLabel("Exact existing Operations organization record").selectOption("native-organization-1");
  page.once("dialog", dialog => void dialog.accept());
  await conflictPanel.getByRole("button", { name: "Acquire as inactive mapping" }).click();
  await expect(conflictPanel.getByRole("alert")).toContainText("conflicts with an existing reservation");
});
