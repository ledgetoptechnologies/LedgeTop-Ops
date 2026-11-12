import { expect, test, type Page, type Route } from "@playwright/test";

const session = { user: { id: "staff-a", email: "staff@example.test", displayName: "Staff User", status: "Active", profileType: "Employee", isAdministrator: true, permissions: ["dashboard.view"], divisions: [] },
  csrfToken: "test", timezone: "America/Chicago", capabilities: {} };
const accessDenied = (route: Route) => route.fulfill({ status: 401, contentType: "text/html", body: "<html>Access</html>" });

async function mock(page: Page, status: (route: Route) => Promise<void>) {
  const seen: Record<string, string | undefined> = {};
  await page.route("**/api/**", route => {
    const { pathname } = new URL(route.request().url());
    seen[pathname] = route.request().headers()["x-requested-with"];
    if (pathname === "/api/session") return route.fulfill({ json: session });
    if (pathname === "/api/session/status") return status(route);
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return seen;
}
const openAccount = async (page: Page) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^Account menu for / }).click();
  return page.getByRole("menu", { name: "Account" });
};

test("an Access 401 mid-visit offers Sign in again without leaving the page", async ({ page }) => {
  const seen = await mock(page, accessDenied);
  await page.route("**/cdn-cgi/access/get-identity", route => route.fulfill({ status: 401, body: "" }));
  await openAccount(page);
  const notice = page.getByRole("complementary", { name: "Your sign-in has ended" });
  await expect(notice).toBeVisible();
  expect(seen["/api/session"]).toBe("XMLHttpRequest");
  expect(seen["/api/session/status"]).toBe("XMLHttpRequest");
  const again = notice.getByRole("link", { name: "Sign in again" });
  await expect(again).toHaveAttribute("href", "/cdn-cgi/access/logout");
  await expect(page).toHaveURL(/\/$/);
  const box = await notice.boundingBox(), width = page.viewportSize()!.width;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  let logouts = 0;
  await page.route("**/cdn-cgi/access/logout", route => { logouts += 1; return route.fulfill({ status: 200, body: "" }); });
  await again.click();
  await expect.poll(() => logouts).toBe(1);
});

test("a 403 is a denial, not an ended sign-in", async ({ page }) => {
  await mock(page, route => route.fulfill({ status: 403, contentType: "text/html", body: "Forbidden" }));
  const menu = await openAccount(page);
  await expect(menu.locator(".account-session-status small")).toHaveText("Session time unavailable");
  await expect(page.locator(".session-ended-notice")).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Sign in again" })).toHaveCount(0);
});

test("the app's own 401 keeps the account menu's Sign in again", async ({ page }) => {
  await mock(page, route => route.fulfill({ status: 401, json: { error: "Session expired" } }));
  const menu = await openAccount(page);
  await expect(menu.locator(".account-session-status strong")).toHaveText("Session expired");
  await expect(menu.getByRole("menuitem", { name: "Sign in again" })).toHaveAttribute("href", "/cdn-cgi/access/logout");
  await expect(page.locator(".session-ended-notice")).toHaveCount(0);
});

test("the header stays off paths outside the API", async ({ page }) => {
  await mock(page, route => route.fulfill({ json: {} }));
  let header: string | undefined = "not called";
  await page.route("**/media/clip.mp4", route => {
    header = route.request().headers()["x-requested-with"];
    return route.fulfill({ status: 200, body: "" });
  });
  await page.goto("/");
  await page.evaluate(() => fetch("/media/clip.mp4"));
  expect(header).toBeUndefined();
});

test("a page that never signed in shows only its own recovery screen", async ({ page }) => {
  await page.route("**/api/**", accessDenied);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your sign-in has ended" })).toHaveCount(1);
  await expect(page.locator(".session-ended-notice")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/cdn-cgi/access/logout");
});

for (const status of [403, 503]) {
  test(`initial session ${status} retains another-email sign-in and a working retry`, async ({ page }) => {
    let recovered = false;
    let sessionRequests = 0;
    await page.route("**/cdn-cgi/access/get-identity", route => route.fulfill({ status: 401, body: "" }));
    await page.route("**/api/**", route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/session") {
        sessionRequests++;
        return recovered ? route.fulfill({ json: session }) : route.fulfill({ status,
          json: { error: status === 403 ? "This email is not set up for Ledge Top." : "Temporarily unavailable" } });
      }
      return route.fulfill({ status: 404, json: { error: "Not found" } });
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: /^Account menu for / })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Sign in with a different email" }))
      .toHaveAttribute("href", "/cdn-cgi/access/logout");
    await expect(page.getByText("Still stuck? Ask your Ledge Top contact or administrator for help.")).toBeVisible();
    const beforeRetry = sessionRequests;
    recovered = true;
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByRole("button", { name: "Account menu for Staff User" })).toBeVisible();
    expect(sessionRequests).toBeGreaterThan(beforeRetry);
    await expect(page.getByRole("link", { name: "Sign in with a different email" })).toHaveCount(0);
  });
}
