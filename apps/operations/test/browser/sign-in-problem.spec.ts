import { expect, test, type Page } from "@playwright/test";

const notSetUp = "This email is not set up for Ledge Top. Sign in with your Operations staff email or contact your administrator.";
/** The exact denial the current live server sends; it must never reach the page. */
const legacyDenial = "Your Access identity is not provisioned for LTDS Operations";
const deniedCopy = "This email isn't set up for Ledge Top Operations. Sign in with your Ledge Top staff email, or ask your administrator to add this one.";

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
  await expect(screen.getByRole("alert")).toHaveText(deniedCopy);
  await expect(screen).toContainText("Signed in as someone@example.test");
  await expect(screen).not.toContainText("LTDS");
  const switchAccount = screen.getByRole("link", { name: "Sign in with a different email" });
  await expect(switchAccount).toHaveAttribute("href", "/cdn-cgi/access/logout");
  await expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  // Only the session and the Access identity are read: nothing is linked, granted or retried behind the scenes.
  expect(calls.filter(call => call !== "identity")).toEqual(["/api/session"]);
});

test("the live server's legacy denial is replaced by Ledge Top wording, with every way out shown", async ({ page }) => {
  await failSession(page, 403, legacyDenial);
  await page.goto("/");
  const screen = page.getByRole("main", { name: "This email can't open Ledge Top Operations" });
  await expect(screen.getByRole("alert")).toHaveText(deniedCopy);
  await expect(page.locator("body")).not.toContainText("LTDS");
  await expect(page.locator("body")).not.toContainText("provisioned");
  await expect(screen.getByRole("link", { name: "Sign in with a different email" })).toHaveAttribute("href", "/cdn-cgi/access/logout");
  await expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(screen.getByRole("link", { name: "info@ledgetopdroneservices.com" })).toBeVisible();
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
  await expect(screen.getByRole("link", { name: "info@ledgetopdroneservices.com" })).toHaveAttribute("href", "mailto:info@ledgetopdroneservices.com");
});

for (const [name, fail] of [
  ["a server problem", (page: Page) => failSession(page, 503, "Unavailable")],
  ["a network failure", async (page: Page) => {
    await page.route("**/cdn-cgi/access/get-identity", route => route.fulfill({ json: { email: "someone@example.test" } }));
    await page.route("**/api/**", route => route.abort("failed"));
  }],
] as const) test(`${name} still offers the way out: retry first, another email, and support`, async ({ page }) => {
  await fail(page);
  await page.goto("/");
  const screen = page.getByRole("main", { name: "Operations is unavailable right now" });
  await expect(screen.getByRole("button", { name: "Try again" })).toHaveClass(/button-orange/);
  await expect(screen.getByRole("link", { name: "Sign in with a different email" })).toHaveAttribute("href", "/cdn-cgi/access/logout");
  await expect(screen.getByRole("link", { name: "info@ledgetopdroneservices.com" })).toHaveAttribute("href", "mailto:info@ledgetopdroneservices.com");
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

const signedIn = {
  user: { id: "staff-a", email: "staff@example.test", displayName: "Staff User", status: "Active", profileType: "Employee",
    isAdministrator: false, permissions: ["dashboard.view"], divisions: [] },
  csrfToken: "test", timezone: "America/Chicago", capabilities: {},
};

/**
 * A browser whose session fails with `status` until Access logout runs, after which the right email opens Operations.
 * `logout` answers the in-page sign-out request; a navigation to the logout URL shows Access's own page.
 */
async function signOutFlow(page: Page, status: number, logout: (route: import("@playwright/test").Route) => Promise<void> | void) {
  const seen = { logoutFetches: 0, logoutPages: 0, sessions: 0 };
  let signedOut = false;
  await page.route("**/cdn-cgi/access/get-identity", route => route.fulfill({ json: { email: "someone@example.test" } }));
  await page.route("**/cdn-cgi/access/logout", async route => {
    if (route.request().resourceType() === "document") {
      seen.logoutPages++;
      return route.fulfill({ contentType: "text/html", body: "<title>Logged out</title><p>You have been logged out.</p>" });
    }
    seen.logoutFetches++;
    signedOut = true;
    return logout(route);
  });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path !== "/api/session") return route.fulfill({ status: 404, json: { error: "Not found" } });
    seen.sessions++;
    return signedOut ? route.fulfill({ json: signedIn }) : route.fulfill({ status, json: { error: status === 403 ? notSetUp : "Expired" } });
  });
  return seen;
}

test("one click signs out of Access and returns to Operations' sign-in", async ({ page }) => {
  const seen = await signOutFlow(page, 403, route => route.fulfill({ status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/logout" } }));
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with a different email" }).click();
  await expect(page.getByRole("button", { name: "Account menu for Staff User" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
  expect(seen).toEqual({ logoutFetches: 1, logoutPages: 0, sessions: 2 });
});

test("the Access sign-out wording is honest about the shared sign-in", async ({ page }) => {
  await failSession(page, 403, notSetUp);
  await page.goto("/");
  await expect(page.getByText("Signing out ends your Ledge Top sign-in in this browser, so other Ledge Top apps will ask you to sign in again too. It doesn't change any account.")).toBeVisible();
});

test("a pending sign-out ignores further clicks", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const seen = await signOutFlow(page, 403, async route => { await held; await route.fulfill({ status: 200, body: "ok" }); });
  await page.goto("/");
  const link = page.getByRole("link", { name: "Sign in with a different email" });
  await link.click();
  const pending = page.getByRole("link", { name: "Signing out…" });
  await expect(pending).toHaveAttribute("aria-disabled", "true");
  // Playwright treats aria-disabled as disabled, so force the clicks a person could still make.
  await pending.click({ force: true });
  await pending.click({ force: true });
  release();
  await expect(page.getByRole("button", { name: "Account menu for Staff User" })).toBeVisible();
  expect(seen.logoutFetches).toBe(1);
  expect(seen.logoutPages).toBe(0);
});

test("an ended sign-in signs in again in one click", async ({ page }) => {
  const seen = await signOutFlow(page, 401, route => route.fulfill({ status: 200, body: "ok" }));
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in again" }).click();
  await expect(page.getByRole("button", { name: "Account menu for Staff User" })).toBeVisible();
  expect(seen.logoutFetches).toBe(1);
});

for (const [name, logout] of [
  ["a network failure", (route: import("@playwright/test").Route) => route.abort("failed")],
  ["an Access error", (route: import("@playwright/test").Route) => route.fulfill({ status: 500, body: "error" })],
] as const) {
  test(`${name} during sign-out falls back to the ordinary logout page`, async ({ page }) => {
    const seen = await signOutFlow(page, 403, logout);
    await page.goto("/");
    await page.getByRole("link", { name: "Sign in with a different email" }).click();
    await expect(page).toHaveTitle("Logged out");
    expect(new URL(page.url()).pathname).toBe("/cdn-cgi/access/logout");
    expect(seen.logoutPages).toBe(1);
  });
}

test("a modified click keeps the ordinary logout link behavior", async ({ page }) => {
  const seen = await signOutFlow(page, 403, route => route.fulfill({ status: 200, body: "ok" }));
  await page.goto("/");
  const link = page.getByRole("link", { name: "Sign in with a different email" });
  await link.click({ modifiers: ["ControlOrMeta"] });
  // The browser's own new-tab handling is left alone: no in-page sign-out starts and this page stays as it was.
  await expect(link).not.toHaveAttribute("aria-disabled", "true");
  expect(seen.logoutFetches).toBe(0);
  expect(new URL(page.url()).pathname).toBe("/");
});
