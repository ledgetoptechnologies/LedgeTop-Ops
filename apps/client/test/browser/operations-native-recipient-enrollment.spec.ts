import { expect, test } from "@playwright/test";

const intentId = "00000000-0000-4000-8000-000000000001", targetId = "11111111-1111-4111-8111-111111111111";
const opaqueToken = "ab".repeat(32), csrfToken = `123456.${"cd".repeat(32)}`;
const path = `/portal/operations-recipient-enrollment/${intentId}`;
const nativeOrigin = "https://client-staging.ledgetopdroneservices.com";
const fixtureOrigin = "http://127.0.0.1:4173";
const target = { targetId, targetRevision: 2, clientRecordId: "client:example", displayLabel: "Example Construction LLC" };
const homeAccess = { permissions: ["operations.service_home.read"], permissionSchemaVersion: 3 };
const requestAccess = { permissions: ["operations.request.create", "operations.service_home.read"], permissionSchemaVersion: 4 };

test.beforeEach(async ({ page }) => {
  // Preserve the production origin allowlist in browser coverage while serving
  // only the built local fixture. Per-test API routes are registered later and
  // therefore take precedence over this document/asset fallback.
  await page.route(`${nativeOrigin}/**`, async route => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${fixtureOrigin}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
});

test.afterEach(async ({ page }) => {
  // Finish document/asset route.fetch -> fulfill handlers before Playwright
  // disposes their API responses with the test's browser context.
  await page.unrouteAll({ behavior: "wait" });
});

test("native consent uses only the native API and exact target revision, remaining pending review", async ({ page }) => {
  const calls: Array<{ path: string; body: Record<string, unknown> | null; headers: Record<string, string>; url: string }> = [];
  let legacyCalls = 0;
  await page.route("**/api/client/v2/recipient-enrollment/**", async route => { legacyCalls++; await route.abort(); });
  await page.route("**/api/client/operations/recipient-enrollment/**", async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    calls.push({ path: pathname, body: request.postDataJSON() as Record<string, unknown> | null, headers: request.headers(), url: page.url() });
    if (pathname.endsWith("/session")) return route.fulfill({ json: { csrfToken } });
    if (pathname.endsWith("/inspect")) return route.fulfill({ json: { intentId, revision: 1, state: "issued", target,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), ...homeAccess } });
    return route.fulfill({ json: { intentId, revision: 2, state: "pending" } });
  });
  await page.goto(`${nativeOrigin}${path}#${opaqueToken}`);
  await expect(page).toHaveURL(`${nativeOrigin}${path}`);
  await expect(page.getByText(target.displayLabel, { exact: true })).toBeVisible();
  await expect(page.locator(".client-recipient-access li")).toHaveText(["View your service home"]);
  const submit = page.getByRole("button", { name: "Submit for administrator review" });
  await expect(submit).toBeDisabled();
  await page.getByRole("checkbox", { name: /I confirm this is the client account/ }).check();
  await submit.click();
  await expect(page.getByRole("heading", { name: "Confirmation submitted" })).toBeVisible();
  await expect(page.getByText(/does not activate access by itself/)).toBeVisible();
  expect(legacyCalls).toBe(0);
  expect(calls).toHaveLength(3);
  expect(calls[2]?.body).toMatchObject({ intentId, opaqueToken, acknowledged: true,
    acknowledgedTarget: { targetId, targetRevision: 2, clientRecordId: target.clientRecordId } });
  // Home-only consent keeps the original body exactly.
  expect(Object.keys(calls[2]!.body!).sort()).toEqual(["acknowledged", "acknowledgedTarget", "intentId", "opaqueToken", "operationId"]);

  expect(calls[2]?.body).not.toHaveProperty("principal");
  for (const call of calls) {
    expect(call.url).not.toContain(opaqueToken); expect(call.path).not.toContain(opaqueToken);
    expect(call.headers["x-operations-enrollment-request"]).toBe("1");
    expect(call.headers).not.toHaveProperty("x-recipient-enrollment-request");
  }
});

test("native UI rejects legacy selection responses without falling back", async ({ page }) => {
  let redeemed = false;
  await page.route("**/api/client/operations/recipient-enrollment/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/session")) return route.fulfill({ json: { csrfToken } });
    if (pathname.endsWith("/redeem")) redeemed = true;
    return route.fulfill({ json: { intentId, revision: 1, state: "issued",
      target: { selectionId: targetId, clientRecordId: target.clientRecordId, displayLabel: target.displayLabel },
      expiresAt: new Date(Date.now() + 60_000).toISOString() } });
  });
  await page.goto(`${nativeOrigin}${path}#${opaqueToken}`);
  await expect(page.getByRole("heading", { name: "Portal confirmation unavailable" })).toBeVisible();
  expect(redeemed).toBe(false);
});

test("native uncertain submission retains its operation ID on retry", async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/client/operations/recipient-enrollment/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/session")) return route.fulfill({ json: { csrfToken } });
    if (pathname.endsWith("/inspect")) return route.fulfill({ json: { intentId, revision: 1, state: "issued", target,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), ...homeAccess } });
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return bodies.length === 1 ? route.fulfill({ status: 503, json: { error: "unavailable" } })
      : route.fulfill({ json: { intentId, revision: 2, state: "pending" } });
  });
  await page.goto(`${nativeOrigin}${path}#${opaqueToken}`);
  await page.getByRole("checkbox", { name: /I confirm this is the client account/ }).check();
  await page.getByRole("button", { name: "Submit for administrator review" }).click();
  await expect(page.getByRole("heading", { name: "Confirmation status uncertain" })).toBeVisible();
  await page.getByRole("button", { name: "Retry same confirmation" }).click();
  await expect(page.getByRole("heading", { name: "Confirmation submitted" })).toBeVisible();
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]);
});

async function mockNative(page: import("@playwright/test").Page, access: Record<string, unknown>) {
  const redeems: Record<string, unknown>[] = [];
  await page.route("**/api/client/operations/recipient-enrollment/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/session")) return route.fulfill({ json: { csrfToken } });
    if (pathname.endsWith("/inspect")) return route.fulfill({ json: { intentId, revision: 1, state: "issued", target,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), ...access } });
    redeems.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: { intentId, revision: 2, state: "pending" } });
  });
  return redeems;
}

test("a link that includes service requests says so, and the recipient accepts exactly that access", async ({ page }) => {
  const redeems = await mockNative(page, requestAccess);
  await page.goto(`${nativeOrigin}${path}#${opaqueToken}`);
  await expect(page.locator(".client-recipient-access li")).toHaveText(["View your service home", "Send service requests to Ledge Top"]);
  await page.getByRole("checkbox", { name: /I confirm this is the client account .*with the access listed above/ }).check();
  await page.getByRole("button", { name: "Submit for administrator review" }).click();
  await expect(page.getByRole("heading", { name: "Confirmation submitted" })).toBeVisible();
  expect(redeems).toHaveLength(1);
  expect(redeems[0]).toEqual({ intentId, opaqueToken, operationId: expect.any(String), acknowledged: true,
    acknowledgedTarget: { targetId, targetRevision: 2, clientRecordId: target.clientRecordId },
    acknowledgedPermissionSchemaVersion: 4, acknowledgedPermissions: ["operations.request.create", "operations.service_home.read"] });
});

// Old backends and new ones replying for home-only links send exactly the original five keys.
test("a link with no access metadata is view-only, and its consent keeps the original body exactly", async ({ page }) => {
  const redeems = await mockNative(page, {});
  await page.goto(`${nativeOrigin}${path}#${opaqueToken}`);
  await expect(page.locator(".client-recipient-access li")).toHaveText(["View your service home"]);
  await page.getByRole("checkbox", { name: /I confirm this is the client account/ }).check();
  await page.getByRole("button", { name: "Submit for administrator review" }).click();
  await expect(page.getByRole("heading", { name: "Confirmation submitted" })).toBeVisible();
  expect(redeems).toEqual([{ intentId, opaqueToken, operationId: expect.any(String), acknowledged: true,
    acknowledgedTarget: { targetId, targetRevision: 2, clientRecordId: target.clientRecordId } }]);
});

for (const [name, access] of [
  ["isn't one the portal knows", { permissions: ["operations.request.create"], permissionSchemaVersion: 4 }],
  ["doesn't match its version", { ...requestAccess, permissionSchemaVersion: 3 }],
  ["has an unknown version", { ...homeAccess, permissionSchemaVersion: 5 }],
  ["lists no permissions", { permissions: [], permissionSchemaVersion: 3 }],
  ["isn't a list", { permissions: "operations.service_home.read", permissionSchemaVersion: 3 }],
  ["is null", { permissions: null, permissionSchemaVersion: null }],
  ["has a version but no permissions", { permissionSchemaVersion: 4 }],
  ["has permissions but no version", { permissions: requestAccess.permissions }],
  ["comes with an unexpected field", { ...homeAccess, capabilityStatus: "pending" }],
  ["has only an unexpected field", { capabilityStatus: "pending" }],
] as const)
  test(`a link whose access ${name} can't be confirmed`, async ({ page }) => {
    const redeems = await mockNative(page, access);
    await page.goto(`${nativeOrigin}${path}#${opaqueToken}`);
    await expect(page.getByRole("heading", { name: "Portal confirmation unavailable" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Submit for administrator review" })).toHaveCount(0);
    expect(redeems).toHaveLength(0);
  });
