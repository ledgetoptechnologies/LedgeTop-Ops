import { expect, test } from "@playwright/test";

const intentId = "00000000-0000-4000-8000-000000000001";
const selectionId = "11111111-1111-4111-8111-111111111111";
const opaqueToken = "ab".repeat(32);
const path = `/portal/recipient-enrollment/${intentId}`;
const csrfToken = `123456.${"cd".repeat(32)}`;
const target = { clientRecordId: "client:example", selectionId, displayLabel: "Example Construction LLC" };

test("portal enrollment scrubs its token, requires exact target acknowledgement, and remains pending review", async ({ page }) => {
  const calls: Array<{ path: string; method: string; body: Record<string, unknown> | null; visibleUrl: string; headers: Record<string, string> }> = [];
  await page.route("**/api/client/v2/recipient-enrollment/**", async route => {
    const request = route.request(), url = new URL(request.url()), body = request.postDataJSON() as Record<string, unknown> | null;
    calls.push({ path: url.pathname, method: request.method(), body, visibleUrl: page.url(), headers: request.headers() });
    if (url.pathname.endsWith("/session")) return route.fulfill({ json: { csrfToken } });
    if (url.pathname.endsWith("/inspect")) return route.fulfill({ json: { intentId, revision: 1, state: "issued", target,
      expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    return route.fulfill({ json: { intentId, revision: 2, state: "pending" } });
  });
  await page.goto(`${path}#${opaqueToken}`);
  await expect(page).toHaveURL(`http://127.0.0.1:4173${path}`);
  await expect(page.getByRole("heading", { name: "Confirm portal account" })).toBeVisible();
  await expect(page.getByText(target.displayLabel, { exact: true })).toBeVisible();
  const submit = page.getByRole("button", { name: "Submit for administrator review" });
  await expect(submit).toBeDisabled();
  await page.getByRole("checkbox", { name: /I confirm this is the client account/ }).check();
  await submit.click();
  await expect(page.getByRole("heading", { name: "Confirmation submitted" })).toBeVisible();
  await expect(page.getByText(/waiting for administrator review/)).toBeVisible();
  expect(calls.map(call => [call.method, call.path])).toEqual([
    ["GET", "/api/client/v2/recipient-enrollment/session"],
    ["POST", "/api/client/v2/recipient-enrollment/inspect"],
    ["POST", "/api/client/v2/recipient-enrollment/redeem"],
  ]);
  expect(calls[1]?.body).toEqual({ intentId, opaqueToken });
  expect(calls[2]?.body).toMatchObject({ intentId, opaqueToken, acknowledged: true,
    acknowledgedTarget: { clientRecordId: target.clientRecordId, selectionId } });
  expect(calls[2]?.body?.operationId).toMatch(/^[0-9a-f-]{36}$/);
  for (const call of calls) {
    expect(call.visibleUrl).not.toContain(opaqueToken);
    expect(call.path).not.toContain(opaqueToken);
    expect(call.headers["x-recipient-enrollment-request"]).toBe("1");
  }
});

test("an uncertain redeem retries the exact same operation without reissuing identity", async ({ page }) => {
  const redeemBodies: Record<string, unknown>[] = [];
  await page.route("**/api/client/v2/recipient-enrollment/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/session")) return route.fulfill({ json: { csrfToken } });
    if (url.pathname.endsWith("/inspect")) return route.fulfill({ json: { intentId, revision: 1, state: "issued", target,
      expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    redeemBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return redeemBodies.length === 1 ? route.fulfill({ status: 503, json: { error: "Uncertain" } })
      : route.fulfill({ json: { intentId, revision: 2, state: "pending" } });
  });
  await page.goto(`${path}#${opaqueToken}`);
  await page.getByRole("checkbox", { name: /I confirm this is the client account/ }).check();
  await page.getByRole("button", { name: "Submit for administrator review" }).click();
  await expect(page.getByRole("heading", { name: "Confirmation status uncertain" })).toBeVisible();
  await page.getByRole("button", { name: "Retry same confirmation" }).click();
  await expect(page.getByRole("heading", { name: "Confirmation submitted" })).toBeVisible();
  expect(redeemBodies).toHaveLength(2);
  expect(redeemBodies[1]).toEqual(redeemBodies[0]);
});

test("a synthetic enrollment URL without a fragment never calls the enrollment API", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/client/v2/recipient-enrollment/**", async route => { calls += 1; await route.abort(); });
  await page.goto(path);
  await expect(page.getByRole("heading", { name: "Portal confirmation unavailable" })).toBeVisible();
  expect(calls).toBe(0);
});

test("a query-bearing enrollment link is scrubbed and rejected before any API request", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/client/v2/recipient-enrollment/**", async route => { calls += 1; await route.abort(); });
  await page.goto(`${path}?token=${opaqueToken}#${opaqueToken}`);
  await expect(page).toHaveURL(`http://127.0.0.1:4173${path}`);
  await expect(page.getByRole("heading", { name: "Portal confirmation unavailable" })).toBeVisible();
  expect(calls).toBe(0);
});
