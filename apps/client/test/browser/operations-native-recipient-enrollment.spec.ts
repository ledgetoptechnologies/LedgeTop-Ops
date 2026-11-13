import { expect, test } from "@playwright/test";
import { routeHandlerDrain } from "./route-handler-drain";

const intentId = "00000000-0000-4000-8000-000000000001", targetId = "11111111-1111-4111-8111-111111111111";
const opaqueToken = "ab".repeat(32), csrfToken = `123456.${"cd".repeat(32)}`;
const path = `/portal/operations-recipient-enrollment/${intentId}`;
const nativeOrigin = "https://client-staging.ledgetopdroneservices.com";
const fixtureOrigin = "http://127.0.0.1:4173";
const target = { targetId, targetRevision: 2, clientRecordId: "client:example", displayLabel: "Example Construction LLC" };
const homePermissions = ["operations.service_home.read"] as const;
const requestPermissions = ["operations.request.create", "operations.service_home.read"] as const;
const inspected = (permissionSchemaVersion: 3 | 4 = 3, permissions: readonly string[] = homePermissions) => ({
  intentId, revision: 1, state: "issued", target,
  expiresAt: new Date(Date.now() + 60_000).toISOString(), permissionSchemaVersion, permissions,
});

let fixtureHops = routeHandlerDrain();

test.beforeEach(async ({ page }) => {
  // Preserve the production origin allowlist in browser coverage while serving
  // only the built local fixture. Per-test API routes are registered later and
  // therefore take precedence over this document/asset fallback.
  fixtureHops = routeHandlerDrain();
  await page.route(`${nativeOrigin}/**`, route => fixtureHops.track((async () => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${fixtureOrigin}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  })()));
});

test.afterEach(async ({ page }) => {
  // Finish every document/asset route.fetch -> fulfill hop while the route is
  // still installed (see route-handler-drain.ts), then unroute before
  // Playwright disposes their API responses with the test's browser context.
  await fixtureHops.drain();
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
    if (pathname.endsWith("/inspect")) return route.fulfill({ json: inspected() });
    return route.fulfill({ json: { intentId, revision: 2, state: "pending" } });
  });
  await page.goto(`${nativeOrigin}${path}#${opaqueToken}`);
  await expect(page).toHaveURL(`${nativeOrigin}${path}`);
  await expect(page.getByText(target.displayLabel, { exact: true })).toBeVisible();
  await expect(page.getByText("View your services", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /I agree to the access/ })).toHaveCount(0);
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
  expect(calls[2]?.body).not.toHaveProperty("acknowledgedPermissionSchemaVersion");
  expect(calls[2]?.body).not.toHaveProperty("acknowledgedPermissions");
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
    return route.fulfill({ json: { ...inspected(),
      target: { selectionId: targetId, clientRecordId: target.clientRecordId, displayLabel: target.displayLabel },
    } });
  });
  await page.goto(`${nativeOrigin}${path}#${opaqueToken}`);
  await expect(page.getByRole("heading", { name: "Portal confirmation unavailable" })).toBeVisible();
  expect(redeemed).toBe(false);
});

test("native v4 consent shows the exact request capability and requires its acknowledgment", async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/client/operations/recipient-enrollment/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/session")) return route.fulfill({ json: { csrfToken } });
    if (pathname.endsWith("/inspect")) return route.fulfill({ json: inspected(4, requestPermissions) });
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: { intentId, revision: 2, state: "pending" } });
  });
  await page.goto(`${nativeOrigin}${path}#${opaqueToken}`);
  await expect(page.getByText("Submit service requests", { exact: true })).toBeVisible();
  const submit = page.getByRole("button", { name: "Submit for administrator review" });
  await page.getByRole("checkbox", { name: /I confirm this is the client account/ }).check();
  await expect(submit).toBeDisabled();
  await page.getByRole("checkbox", { name: /I agree to the access/ }).check();
  await submit.click();
  await expect(page.getByRole("heading", { name: "Confirmation submitted" })).toBeVisible();
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({ acknowledged: true, acknowledgedPermissionSchemaVersion: 4,
    acknowledgedPermissions: requestPermissions,
    acknowledgedTarget: { targetId, targetRevision: 2, clientRecordId: target.clientRecordId } });
});

test("native v4 UI rejects malformed permission metadata before redeem", async ({ page }) => {
  let redeemed = false;
  await page.route("**/api/client/operations/recipient-enrollment/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/session")) return route.fulfill({ json: { csrfToken } });
    if (pathname.endsWith("/redeem")) redeemed = true;
    return route.fulfill({ json: inspected(4, ["operations.service_home.read", "operations.request.create"]) });
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
    if (pathname.endsWith("/inspect")) return route.fulfill({ json: inspected() });
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return bodies.length === 1 ? route.fulfill({ status: 503, json: { error: "unavailable" } })
      : route.fulfill({ json: { intentId, revision: 2, state: "pending" } });
  });
  await page.goto(`${nativeOrigin}${path}#${opaqueToken}`);
  await page.getByRole("checkbox", { name: /I confirm this is the client account/ }).check();
  await page.getByRole("button", { name: "Submit for administrator review" }).click();
  await expect(page.getByRole("heading", { name: "Confirmation status uncertain" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in with a different email" })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry same confirmation" }).click();
  await expect(page.getByRole("heading", { name: "Confirmation submitted" })).toBeVisible();
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0]).not.toHaveProperty("acknowledgedPermissionSchemaVersion");
});

test("native lost redemption acknowledgment retries the exact frozen command", async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  const calls: string[] = [];
  await page.route("**/api/client/operations/recipient-enrollment/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    calls.push(pathname);
    if (pathname.endsWith("/session")) return route.fulfill({ json: { csrfToken } });
    if (pathname.endsWith("/inspect")) return route.fulfill({ json: inspected() });
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    // Model a committed request whose response was lost: the browser observes
    // only a transport failure, and the next request must replay the same ID/body.
    return bodies.length === 1 ? route.abort("failed")
      : route.fulfill({ json: { intentId, revision: 2, state: "pending" } });
  });
  await page.goto(`${nativeOrigin}${path}#${opaqueToken}`);
  await page.getByRole("checkbox", { name: /I confirm this is the client account/ }).check();
  await page.getByRole("button", { name: "Submit for administrator review" }).click();
  await expect(page.getByRole("heading", { name: "Confirmation status uncertain" })).toBeVisible();
  await page.getByRole("button", { name: "Retry same confirmation" }).click();
  await expect(page.getByRole("heading", { name: "Confirmation submitted" })).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0]?.operationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls.filter(call => call.endsWith("/inspect"))).toHaveLength(1);
  expect(calls.filter(call => call.endsWith("/redeem"))).toHaveLength(2);
});

test("native malformed redemption receipt remains uncertain and retries the same command", async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  const calls: string[] = [];
  await page.route("**/api/client/operations/recipient-enrollment/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    calls.push(pathname);
    if (pathname.endsWith("/session")) return route.fulfill({ json: { csrfToken } });
    if (pathname.endsWith("/inspect")) return route.fulfill({ json: inspected() });
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return bodies.length === 1 ? route.fulfill({ json: { intentId, revision: 3, state: "approved" } })
      : route.fulfill({ json: { intentId, revision: 2, state: "pending" } });
  });
  await page.goto(`${nativeOrigin}${path}#${opaqueToken}`);
  await page.getByRole("checkbox", { name: /I confirm this is the client account/ }).check();
  await page.getByRole("button", { name: "Submit for administrator review" }).click();
  await expect(page.getByRole("heading", { name: "Confirmation status uncertain" })).toBeVisible();
  await page.getByRole("button", { name: "Retry same confirmation" }).click();
  await expect(page.getByRole("heading", { name: "Confirmation submitted" })).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(calls.filter(call => call.endsWith("/inspect"))).toHaveLength(1);
  expect(calls.filter(call => call.endsWith("/redeem"))).toHaveLength(2);
});

test("native uncertain redemption survives denied retry session and reuses the same command", async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  const calls: string[] = [];
  let sessions = 0;
  await page.route("**/api/client/operations/recipient-enrollment/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    calls.push(pathname);
    if (pathname.endsWith("/session")) {
      sessions++;
      return sessions === 2 ? route.fulfill({ status: 403, json: { error: "denied" } })
        : route.fulfill({ json: { csrfToken } });
    }
    if (pathname.endsWith("/inspect")) return route.fulfill({ json: inspected() });
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return bodies.length === 1 ? route.abort("failed")
      : route.fulfill({ json: { intentId, revision: 2, state: "pending" } });
  });
  await page.goto(`${nativeOrigin}${path}#${opaqueToken}`);
  await page.getByRole("checkbox", { name: /I confirm this is the client account/ }).check();
  await page.getByRole("button", { name: "Submit for administrator review" }).click();
  await expect(page.getByRole("heading", { name: "Confirmation status uncertain" })).toBeVisible();
  await page.getByRole("button", { name: "Retry same confirmation" }).click();
  await expect(page.getByRole("heading", { name: "Confirmation status uncertain" })).toBeVisible();
  await page.getByRole("button", { name: "Retry same confirmation" }).click();
  await expect(page.getByRole("heading", { name: "Confirmation submitted" })).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(calls.filter(call => call.endsWith("/inspect"))).toHaveLength(1);
  expect(calls.filter(call => call.endsWith("/redeem"))).toHaveLength(2);
});

test("native v4 uncertain retry reuses the frozen permission acknowledgment body", async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/client/operations/recipient-enrollment/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/session")) return route.fulfill({ json: { csrfToken } });
    if (pathname.endsWith("/inspect")) return route.fulfill({ json: inspected(4, requestPermissions) });
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return bodies.length === 1 ? route.fulfill({ status: 503, json: { error: "unavailable" } })
      : route.fulfill({ json: { intentId, revision: 2, state: "pending" } });
  });
  await page.goto(`${nativeOrigin}${path}#${opaqueToken}`);
  await page.getByRole("checkbox", { name: /I confirm this is the client account/ }).check();
  await page.getByRole("checkbox", { name: /I agree to the access/ }).check();
  await page.getByRole("button", { name: "Submit for administrator review" }).click();
  await expect(page.getByRole("heading", { name: "Confirmation status uncertain" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in with a different email" })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry same confirmation" }).click();
  await expect(page.getByRole("heading", { name: "Confirmation submitted" })).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0]).toMatchObject({ acknowledgedPermissionSchemaVersion: 4,
    acknowledgedPermissions: requestPermissions });
});

test("recipient retry reuses its secure link in memory and offers safe email recovery", async ({ page }) => {
  const inspectedBodies: Record<string, unknown>[] = [];
  let sessions = 0;
  await page.route("**/api/client/operations/recipient-enrollment/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/session")) {
      sessions++;
      return sessions === 1 ? route.fulfill({ status: 503, json: { error: "unavailable" } })
        : route.fulfill({ json: { csrfToken } });
    }
    if (pathname.endsWith("/inspect")) {
      inspectedBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({ json: inspected() });
    }
    return route.fulfill({ json: { intentId, revision: 2, state: "pending" } });
  });
  await page.goto(`${nativeOrigin}${path}#${opaqueToken}`);
  await expect(page.getByRole("heading", { name: "Temporarily unavailable" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in with a different email" })).toHaveAttribute("href", "/cdn-cgi/access/logout");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Confirm portal account" })).toBeVisible();
  expect(inspectedBodies).toEqual([{ intentId, opaqueToken }]);
  const browserUrl = await page.evaluate(() => window.location.href);
  expect(browserUrl).not.toContain(opaqueToken);
  expect(new URL(browserUrl).hash).toBe("");
});

test("terminal recipient inspection error offers switch-email recovery without a capability redirect", async ({ page }) => {
  const bodies: unknown[] = [];
  await page.route("**/api/client/operations/recipient-enrollment/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/session")) return route.fulfill({ json: { csrfToken } });
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ status: 404, json: { error: "unavailable" } });
  });
  await page.goto(`${nativeOrigin}${path}#${opaqueToken}`);
  await expect(page.getByRole("heading", { name: "Portal confirmation unavailable" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in with a different email" })).toHaveAttribute("href", "/cdn-cgi/access/logout");
  await expect(page.locator("body")).not.toContainText(opaqueToken);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies).toEqual([{ intentId, opaqueToken }, { intentId, opaqueToken }]);
  expect(await page.evaluate(() => window.location.href)).not.toContain(opaqueToken);
});
