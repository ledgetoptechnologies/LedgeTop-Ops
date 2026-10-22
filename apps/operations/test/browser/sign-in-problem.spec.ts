import { expect, test, type Page } from "@playwright/test";

const notSetUp = "This email is not set up for Ledge Top. Sign in with your Operations staff email or contact your administrator.";

async function failSession(page: Page, status: number, error: string, identity: unknown = { email: "someone@example.test" }) {
  const calls: string[] = [];
  await page.route("**/cdn-cgi/access/get-identity", route => { calls.push("identity"); return route.fulfill({ json: identity }); });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    return path === "/api/session" ? route.fulfill({ status, json: { error } }) : route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return calls;
}

test("an email that isn't set up shows who is signed in and offers a different sign-in", async ({ page }) => {
  const calls = await failSession(page, 403, notSetUp);
  await page.goto("/");
  const screen = page.getByRole("main", { name: "This email can't open Ledge Top Operations" });
  await expect(screen).toBeVisible();
  await expect(screen.locator(".ltds-brand")).toContainText("Ledge Top");
  await expect(screen.getByRole("alert")).toHaveText(notSetUp);
  await expect(screen).toContainText("Signed in as someone@example.test");
  await expect(screen).not.toContainText("LTDS");
  const switchAccount = screen.getByRole("link", { name: "Sign in with a different email" });
  await expect(switchAccount).toHaveAttribute("href", "/cdn-cgi/access/logout");
  await expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  // Only the session and the Access identity are read: nothing is linked, granted or retried behind the scenes.
  expect(calls.filter(call => call !== "identity")).toEqual(["/api/session"]);
});

test("try again reloads and opens Operations once the right email is used", async ({ page }) => {
  let denied = true;
  await page.route("**/cdn-cgi/access/get-identity", route => route.fulfill({ json: { email: "someone@example.test" } }));
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return denied ? route.fulfill({ status: 403, json: { error: notSetUp } }) : route.fulfill({ json: {
      user: { id: "staff-a", email: "staff@example.test", displayName: "Staff User", status: "Active", profileType: "Employee",
        isAdministrator: false, permissions: ["dashboard.view"], divisions: [] },
      csrfToken: "test", timezone: "America/Chicago", capabilities: {},
    } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "This email can't open Ledge Top Operations" })).toBeVisible();
  denied = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: "Account menu for Staff User" })).toBeVisible();
});

test("an unknown Access identity hides the signed-in line instead of guessing", async ({ page }) => {
  await failSession(page, 403, notSetUp, { error: "no identity" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "This email can't open Ledge Top Operations" })).toBeVisible();
  await expect(page.getByText("Signed in as")).toHaveCount(0);
});

test("an ended sign-in offers to sign in again", async ({ page }) => {
  await failSession(page, 401, "Expired");
  await page.goto("/");
  const screen = page.getByRole("main", { name: "Your sign-in has ended" });
  await expect(screen.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/cdn-cgi/access/logout");
  await expect(screen.getByText("Signed in as")).toHaveCount(0);
});

test("a server problem offers only to try again", async ({ page }) => {
  await failSession(page, 503, "Unavailable");
  await page.goto("/");
  const screen = page.getByRole("main", { name: "Operations is unavailable right now" });
  await expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(screen.getByRole("link")).toHaveCount(0);
});

test("the card fits the screen without sideways scrolling", async ({ page }) => {
  await failSession(page, 403, notSetUp);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Sign in with a different email" })).toBeVisible();
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits).toBe(true);
  for (const control of [page.getByRole("link", { name: "Sign in with a different email" }), page.getByRole("button", { name: "Try again" })]) {
    const box = await control.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
});
