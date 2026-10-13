import { expect, test } from "@playwright/test";

const intentId = "00000000-0000-4000-8000-000000000001", targetId = "11111111-1111-4111-8111-111111111111";
const opaqueToken = "ab".repeat(32), csrfToken = `123456.${"cd".repeat(32)}`;
const path = `/portal/operations-recipient-enrollment/${intentId}`;
const nativeOrigin = "https://client-staging.ledgetopdroneservices.com";
const fixtureOrigin = "http://127.0.0.1:4173";
const target = { targetId, targetRevision: 2, clientRecordId: "client:example", displayLabel: "Example Construction LLC" };

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

test("native consent uses only the native API and exact target revision, remaining pending review", async ({ page }) => {
  const calls: Array<{ path: string; body: Record<string, unknown> | null; headers: Record<string, string>; url: string }> = [];
  let legacyCalls = 0;
  await page.route("**/api/client/v2/recipient-enrollment/**", async route => { legacyCalls++; await route.abort(); });
  await page.route("**/api/client/operations/recipient-enrollment/**", async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    calls.push({ path: pathname, body: request.postDataJSON() as Record<string, unknown> | null, headers: request.headers(), url: page.url() });
    if (pathname.endsWith("/session")) return route.fulfill({ json: { csrfToken } });
    if (pathname.endsWith("/inspect")) return route.fulfill({ json: { intentId, revision: 1, state: "issued", target,
      expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    return route.fulfill({ json: { intentId, revision: 2, state: "pending" } });
  });
  await page.goto(`${nativeOrigin}${path}#${opaqueToken}`);
  await expect(page).toHaveURL(`${nativeOrigin}${path}`);
  await expect(page.getByText(target.displayLabel, { exact: true })).toBeVisible();
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
      expiresAt: new Date(Date.now() + 60_000).toISOString() } });
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
