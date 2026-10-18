import { expect, test, type Page } from "@playwright/test";

const absence = { error: "Client access is not provisioned", code: "no_authorized_operations_home" };
const authorizedHome = { resourceMode: "operations_home", homes: [{
  authorityId: "12345678-1234-4123-8123-123456789abc", workspaceId: "ops-only-workspace",
  ownershipEpoch: 1, grantRevision: 1,
  services: [{ serviceId: "one", providerId: "ltds", displayLabel: "Previously authorized private service", revision: 1 }],
}] };

async function intercept(page: Page, operations: (read: number) => { status: number; body: unknown }, paAllowed = true) {
  const calls: string[] = [];
  let reads = 0;
  await page.route("**/api/client/**", route => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    if (path === "/api/client/v2/operations/home") {
      const result = operations(reads++);
      return route.fulfill({ status: result.status, json: result.body });
    }
    if (path === "/api/client/session") return paAllowed ? route.fulfill({ json: {
      account: { id: "pa-account", displayName: "Independent PA client" }, capabilities: {},
    } }) : route.fulfill({ status: 403, json: { error: "Client access is not provisioned" } });
    if (path === "/api/client/projects") return route.fulfill({ json: { projects: [] } });
    if (path === "/api/client/service-requests") return route.fulfill({ json: { requests: [] } });
    if (path === "/api/client/map-config") return route.fulfill({ json: { mapboxPublicToken: null } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return calls;
}

test("root admits a PA-only client through its independent session after authenticated Operations absence", async ({ page }) => {
  const calls = await intercept(page, () => ({ status: 403, body: absence }));
  await page.goto("/portal");
  await expect(page.getByRole("heading", { name: "Independent PA client", exact: true })).toBeVisible();
  expect(calls.slice(0, 2)).toEqual(["/api/client/v2/operations/home", "/api/client/session"]);
  expect(calls.some(path => path.includes("/home/") || path.includes("/operations/data/"))).toBe(false);
  await expect(page.getByText("Previously authorized private service", { exact: true })).toHaveCount(0);
});

for (const [name, status, body] of [
  ["authentication failure", 401, absence],
  ["generic permission denial", 403, { error: "Client access is not provisioned" }],
  ["revocation during discovery", 403, { error: "revoked" }],
  ["malformed absence", 403, { ...absence, subject: "untrusted" }],
  ["transport failure", 503, absence],
] as const) test(`root keeps ${name} terminal without probing PA`, async ({ page }) => {
  const calls = await intercept(page, () => ({ status, body }));
  await page.goto("/portal");
  await expect(page.getByRole("alert")).toBeVisible();
  expect(calls).toEqual(["/api/client/v2/operations/home"]);
  await expect(page.getByText("Independent PA client", { exact: true })).toHaveCount(0);
});

test("authenticated Operations absence does not admit an independently denied PA client", async ({ page }) => {
  const calls = await intercept(page, () => ({ status: 403, body: absence }), false);
  await page.goto("/portal");
  await expect(page.getByRole("button", { name: "Retry portal", exact: true })).toBeVisible();
  expect(calls.slice(0, 2)).toEqual(["/api/client/v2/operations/home", "/api/client/session"]);
  await expect(page.getByText("Independent PA client", { exact: true })).toHaveCount(0);
  expect(calls.some(path => path === "/api/client/projects")).toBe(false);
});

test("loss of all authorized Operations contexts clears the previous private service summary and files", async ({ page }) => {
  const calls = await intercept(page, read => read === 0
    ? { status: 200, body: authorizedHome } : { status: 403, body: absence });
  await page.route("**/api/client/operations/data/deliveries", route => route.fulfill({ json: {
    resourceMode: "operations_native_delivery", items: [{ id: "ond1_delivery_alpha", displayName: "Previously authorized private delivery" }], page: { nextCursor: null },
  } }));
  await page.goto("/portal");
  await expect(page.getByText("Previously authorized private service", { exact: true })).toBeVisible();
  const browser = page.getByRole("region", { name: "Shared deliveries" });
  await browser.getByRole("button", { name: "Browse shared deliveries" }).click();
  await expect(browser.getByText("Previously authorized private delivery", { exact: true })).toBeVisible();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByText("Previously authorized private service", { exact: true })).toHaveCount(0);
  await expect.poll(() => calls.filter(path => path === "/api/client/v2/operations/home").length).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("region", { name: "Shared deliveries" })).toHaveCount(0);
  await expect(page.getByText("Previously authorized private delivery", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Independent PA client", exact: true })).toBeVisible();
  await expect(page.getByText("Previously authorized private service", { exact: true })).toHaveCount(0);
});
