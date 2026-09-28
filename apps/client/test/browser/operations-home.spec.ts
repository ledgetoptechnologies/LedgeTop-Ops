import { expect, test, type Page } from "@playwright/test";

const response = {
  resourceMode: "operations_home",
  homes: [{
    authorityId: "authority-one",
    workspaceId: "workspace-one",
    ownershipEpoch: 2,
    grantRevision: 4,
    services: [
      { serviceId: "service-one", providerId: "provider-a", displayLabel: "Aerial operations", revision: 3 },
      { serviceId: "service-two", providerId: "provider-b", displayLabel: "Infrastructure review", revision: 1 },
    ],
  }],
};

async function interceptClientApi(page: Page, status: number, body: unknown) {
  const calls: string[] = [];
  await page.route("**/api/client/**", route => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    if (path === "/api/client/v2/operations/home") return route.fulfill({ status, json: body });
    if (path === "/api/client/session") return route.fulfill({ status: 401, json: { error: "Sign in required" } });
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  return calls;
}

test("unified portal shows only verified operations services", async ({ page }) => {
  const calls = await interceptClientApi(page, 200, response);
  await page.goto("/portal");
  await expect(page.getByRole("heading", { name: "Your services" })).toBeVisible();
  await expect(page.getByText("Aerial operations", { exact: true })).toBeVisible();
  await expect(page.getByText("Infrastructure review", { exact: true })).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByText(/projects|files|billing/i)).toHaveCount(0);
  expect(calls).toEqual(["/api/client/v2/operations/home"]);
});

for (const [status, heading] of [[401, "Sign in required"], [403, "Service home access is not enabled"], [503, "Service home unavailable"]] as const) {
  test(`${status} never starts the legacy portal`, async ({ page }) => {
    const calls = await interceptClientApi(page, status, { error: "unavailable" });
    await page.goto("/portal");
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    expect(calls).toEqual(["/api/client/v2/operations/home"]);
  });
}

test("malformed success never starts the legacy portal", async ({ page }) => {
  const calls = await interceptClientApi(page, 200, { resourceMode: "operations_home", homes: response.homes, extra: true });
  await page.goto("/portal");
  await expect(page.getByRole("heading", { name: "Service home unavailable" })).toBeVisible();
  expect(calls).toEqual(["/api/client/v2/operations/home"]);
});

test("network failure never starts the legacy portal", async ({ page }) => {
  const calls: string[] = [];
  await page.route("**/api/client/**", route => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    return path === "/api/client/v2/operations/home"
      ? route.abort("connectionfailed")
      : route.fulfill({ status: 500, json: { error: "unexpected legacy request" } });
  });
  await page.goto("/portal");
  await expect(page.getByRole("heading", { name: "Service home unavailable" })).toBeVisible();
  expect(calls).toEqual(["/api/client/v2/operations/home"]);
});

test("404 is the sole legacy fallback", async ({ page }) => {
  const calls = await interceptClientApi(page, 404, { error: "disabled" });
  await page.goto("/portal");
  await expect(page.getByText(/sign in/i).first()).toBeVisible();
  await expect.poll(() => calls).toContain("/api/client/session");
});

test("legacy subroutes and public routes do not use the operations probe", async ({ page }) => {
  const calls = await interceptClientApi(page, 200, response);
  await page.goto("/portal/projects");
  await expect.poll(() => calls).toContain("/api/client/session");
  expect(calls).not.toContain("/api/client/v2/operations/home");
});
