import { expect, test, type Page, type Request } from "@playwright/test";

const session = {
  user: { id: "owner-a", email: "owner@example.test", displayName: "Owner User", status: "Active", profileType: "Administrator",
    isAdministrator: true, permissions: ["dashboard.view"], divisions: [] },
  csrfToken: "csrf-test", timezone: "America/Chicago", capabilities: {},
};
const linked = { id: "binding-1", email: "linked@example.test", version: 3, status: "active", createdAt: "2026-10-20T15:00:00Z", revokedAt: null };
const revoked = { id: "binding-0", email: "old@example.test", version: 2, status: "revoked", createdAt: "2026-10-01T15:00:00Z", revokedAt: "2026-10-02T15:00:00Z" };
const INTENT = "3f2b8c1e-7d4a-4e9b-a6c2-5d8e9f0a1b2c", TOKEN = "aaaaaaaa0123456789abcdef0123456789abcdef0123456789abcdefbbbbbbbb";
const verificationUrl = (origin: string) => `${origin}/auth/link-login#intent=3f2b8c1e-7d4a-4e9b-a6c2-5d8e9f0a1b2c&token=aaaaaaaa0123456789abcdef0123456789abcdef0123456789abcdefbbbbbbbb`;

type Seen = { requests: Request[]; links: unknown; intents: number; deletes: unknown[]; claims: Request[]; sessions: number; logouts: number };

/** Operations signed in as the main owner, with the login-links API answered from `links` and `respond` overrides. */
async function mockOps(page: Page, options: {
  links?: unknown; linksStatus?: number; identity?: string;
  intent?: (origin: string) => { status: number; json: unknown }; claim?: { status: number; json: unknown };
  claims?: Array<{ status: number; json: unknown }>; deletes?: Array<{ status: number; json: unknown }>;
} = {}) {
  const seen: Seen = { requests: [], links: options.links ?? { canonicalEmail: "owner@example.test", currentEmail: "owner@example.test", canManage: true, bindings: [linked, revoked] },
    intents: 0, deletes: [], claims: [], sessions: 0, logouts: 0 };
  await page.route("**/cdn-cgi/access/get-identity", route => route.fulfill({ json: { email: options.identity ?? "owner@example.test" } }));
  await page.route("**/cdn-cgi/access/logout", route => { seen.logouts++; return route.fulfill({ status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/logout" } }); });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    seen.requests.push(request);
    if (path === "/api/session") { seen.sessions++; return route.fulfill({ json: session }); }
    if (path === "/api/account/login-links" && request.method() === "GET")
      return options.linksStatus ? route.fulfill({ status: options.linksStatus, json: { error: "Not found" } }) : route.fulfill({ json: seen.links });
    if (path === "/api/account/login-links/intents") {
      seen.intents++;
      const answer = options.intent?.(url.origin) ?? { status: 200, json: { intentId: "3f2b8c1e-7d4a-4e9b-a6c2-5d8e9f0a1b2c", targetEmail: "new@example.test", verificationUrl: verificationUrl(url.origin), expiresAt: "2026-10-24T18:15:00Z" } };
      return route.fulfill(answer);
    }
    if (path === "/api/account/login-links/claim") {
      seen.claims.push(request);
      return route.fulfill(options.claims?.[seen.claims.length - 1] ?? options.claim ?? { status: 200, json: { bindingId: "binding-2", staffId: "owner-a", version: 1 } });
    }
    if (path.startsWith("/api/account/login-links/") && request.method() === "DELETE") {
      seen.deletes.push(request.postDataJSON());
      const answer = options.deletes?.[seen.deletes.length - 1];
      if (answer) return route.fulfill(answer);
      seen.links = { ...(seen.links as object), bindings: [revoked] };
      return route.fulfill({ json: { bindingId: "binding-1", version: 4, status: "revoked" } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return seen;
}

async function openAccount(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Account menu for Owner User" }).click();
  await page.getByRole("menuitem", { name: "Account" }).click();
  await expect(page).toHaveURL(/\/account$/);
  return page.locator(".account-sign-in-emails");
}

test("the account page lists the main email and active linked emails", async ({ page }) => {
  await mockOps(page);
  const card = await openAccount(page);
  await expect(page.getByRole("heading", { name: "Account", level: 1 })).toBeVisible();
  await expect(card.getByRole("listitem")).toHaveCount(2);
  await expect(card.getByRole("listitem").first()).toContainText("owner@example.test");
  await expect(card.getByRole("listitem").first()).toContainText("Main");
  await expect(card.getByRole("listitem").nth(1)).toContainText("linked@example.test");
  await expect(card).not.toContainText("old@example.test");
  await expect(card).not.toContainText("binding-1");
  await expect(card.getByRole("button", { name: "Add a sign-in email" })).toBeVisible();
});

test("removing a linked email confirms first and sends its version with the staff CSRF token", async ({ page }) => {
  const seen = await mockOps(page);
  const card = await openAccount(page);
  await card.getByRole("button", { name: "Remove" }).click();
  await expect(page.locator("dialog.ops-confirm-action")).toContainText("Remove linked@example.test?");
  await page.locator("dialog.ops-confirm-action").getByRole("button", { name: "Confirm" }).click();
  await expect(card.getByRole("status")).toHaveText("linked@example.test was removed.");
  await expect(card.getByRole("listitem")).toHaveCount(1);
  expect(seen.deletes).toEqual([{ expectedVersion: 3 }]);
  const request = seen.requests.find(item => item.method() === "DELETE")!;
  expect(new URL(request.url()).pathname).toBe("/api/account/login-links/binding-1");
  expect(request.headers()["x-csrf-token"]).toBe("csrf-test");
});

test("adding an email creates one link, then signs out and confirms it on the link page", async ({ page }) => {
  const seen = await mockOps(page, { identity: "new@example.test" });
  const card = await openAccount(page);
  await card.getByRole("button", { name: "Add a sign-in email" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a sign-in email" });
  await dialog.getByLabel("Email").fill("new@example.test");
  await dialog.getByRole("button", { name: "Create link" }).click();
  await expect(card).toContainText("Link ready for new@example.test.");
  await expect(card).not.toContainText("aaaaaaaa0123456789abcdef0123456789abcdef0123456789abcdefbbbbbbbb");
  expect(seen.intents).toBe(1);
  expect(seen.requests.find(item => item.url().endsWith("/intents"))!.postDataJSON()).toEqual({ email: "new@example.test" });

  const sessionsBefore = seen.sessions;
  await card.getByRole("link", { name: "Sign out and continue as new@example.test" }).click();
  await expect(page.getByRole("heading", { name: "Link this email to your Operations account?" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/auth/link-login");
  expect(new URL(page.url()).hash).toBe("");
  expect(seen.logouts).toBe(1);
  expect(seen.sessions).toBe(sessionsBefore);
  await expect(page.getByText("Signed in as new@example.test")).toBeVisible();
  expect(seen.claims).toHaveLength(0);

  await page.getByRole("button", { name: "Link this email" }).click();
  await expect(page.getByRole("heading", { name: "This email is linked" })).toBeVisible();
  expect(seen.claims).toHaveLength(1);
  expect(seen.claims[0]!.postDataJSON()).toEqual({ intentId: "3f2b8c1e-7d4a-4e9b-a6c2-5d8e9f0a1b2c", verificationToken: "aaaaaaaa0123456789abcdef0123456789abcdef0123456789abcdefbbbbbbbb" });
  expect(seen.claims[0]!.headers()["x-csrf-token"]).toBeUndefined();
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  await expect(page.getByRole("link", { name: "Open Operations" })).toHaveAttribute("href", "/");
});

test("a lost link response is never resent and asks for a new link", async ({ page }) => {
  const seen = await mockOps(page, { intent: () => ({ status: 503, json: { error: "Unavailable", code: "unavailable" } }) });
  const card = await openAccount(page);
  await card.getByRole("button", { name: "Add a sign-in email" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a sign-in email" });
  await dialog.getByLabel("Email").fill("new@example.test");
  await dialog.getByRole("button", { name: "Create link" }).click();
  await expect(card.getByRole("status")).toHaveText("The link couldn't be confirmed as created. Create a new link to try again.");
  expect(seen.intents).toBe(1);
  await expect(card.getByRole("button", { name: "Add a sign-in email" })).toBeEnabled();
});

test("signed in with a linked email, management asks for the main email instead", async ({ page }) => {
  await mockOps(page, { links: { canonicalEmail: "owner@example.test", currentEmail: "linked@example.test", canManage: false, bindings: [linked] } });
  const card = await openAccount(page);
  await expect(card).toContainText("You're signed in with linked@example.test, a linked email.");
  await expect(card).toContainText("To add or remove sign-in emails, sign in with your main email (owner@example.test).");
  await expect(card.getByRole("link", { name: "Sign in with main email" })).toHaveAttribute("href", "/cdn-cgi/access/logout");
  await expect(card.getByRole("button", { name: "Remove" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Add a sign-in email" })).toHaveCount(0);
});

test("without the sign-in emails feature the account page shows only the profile", async ({ page }) => {
  await mockOps(page, { linksStatus: 404 });
  await openAccount(page);
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign-in emails" })).toHaveCount(0);
});

test("the link page opens before Operations, hides the link and keeps it until a fresh sign-in", async ({ page }) => {
  const seen = await mockOps(page, { identity: "someone@example.test", claim: { status: 403, json: { error: "Sign in again with the email you're adding.", code: "denied" } } });
  await page.goto("/auth/link-login#intent=3f2b8c1e-7d4a-4e9b-a6c2-5d8e9f0a1b2c&token=aaaaaaaa0123456789abcdef0123456789abcdef0123456789abcdefbbbbbbbb");
  await expect(page.getByRole("heading", { name: "Link this email to your Operations account?" })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  expect(seen.sessions).toBe(0);
  await page.getByRole("button", { name: "Link this email" }).click();
  await expect(page.getByRole("heading", { name: "Sign in with the email you're adding" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in with a different email" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Link this email to your Operations account?" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Account menu for Owner User" })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  expect(seen.sessions).toBe(1);
});

test("a used or expired link is cleared and points back to the account", async ({ page }) => {
  await mockOps(page, { claim: { status: 400, json: { error: "This link can't be used.", code: "staff_login_invalid" } } });
  await page.goto("/auth/link-login#intent=3f2b8c1e-7d4a-4e9b-a6c2-5d8e9f0a1b2c&token=aaaaaaaa0123456789abcdef0123456789abcdef0123456789abcdefbbbbbbbb");
  await page.getByRole("button", { name: "Link this email" }).click();
  await expect(page.getByRole("heading", { name: "This link can't be used" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Link this email" })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
});

test("the link page without a link explains what to do", async ({ page }) => {
  const seen = await mockOps(page);
  await page.goto("/auth/link-login");
  await expect(page.getByRole("heading", { name: "This link can't be used" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Operations" })).toBeVisible();
  expect(seen.claims).toHaveLength(0);
  expect(seen.sessions).toBe(0);
});

test("the account and link pages fit a phone screen", async ({ page }) => {
  await mockOps(page);
  await openAccount(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto("/auth/link-login#intent=3f2b8c1e-7d4a-4e9b-a6c2-5d8e9f0a1b2c&token=aaaaaaaa0123456789abcdef0123456789abcdef0123456789abcdefbbbbbbbb");
  await expect(page.getByRole("button", { name: "Link this email" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("an unclear claim result keeps the same link and retries it safely", async ({ page }) => {
  const seen = await mockOps(page, { claims: [{ status: 503, json: { error: "Unavailable", code: "unavailable" } }, { status: 200, json: { unexpected: true } }] });
  await page.goto(`/auth/link-login#intent=${INTENT}&token=${TOKEN}`);
  await page.getByRole("button", { name: "Link this email" }).click();
  await expect(page.getByText("We could not confirm whether the email was linked. Retry verification to check safely.")).toBeVisible();
  await expect(page.getByText("Nothing was changed")).toHaveCount(0);
  await page.getByRole("button", { name: "Retry verification" }).click();
  await expect(page.getByText("We could not confirm whether the email was linked. Retry verification to check safely.")).toBeVisible();
  await page.getByRole("button", { name: "Retry verification" }).click();
  await expect(page.getByRole("heading", { name: "This email is linked" })).toBeVisible();
  expect(seen.claims.map(claim => claim.postDataJSON())).toEqual(Array(3).fill({ intentId: INTENT, verificationToken: TOKEN }));
});

test("a link that isn't the server's shape is refused without a claim", async ({ page }) => {
  const seen = await mockOps(page);
  await page.goto(`/auth/link-login#intent=intent-1&token=${TOKEN}`);
  await expect(page.getByRole("heading", { name: "This link can't be used" })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  expect(seen.claims).toHaveLength(0);
});

test("an unclear removal keeps the same version and retries it safely", async ({ page }) => {
  const seen = await mockOps(page, { deletes: [{ status: 502, json: { error: "Bad gateway" } }] });
  const card = await openAccount(page);
  await card.getByRole("button", { name: "Remove" }).click();
  await page.locator("dialog.ops-confirm-action").getByRole("button", { name: "Confirm" }).click();
  await expect(card.getByRole("status")).toHaveText("We couldn't confirm whether linked@example.test was removed. Retry removal to check safely.");
  await card.getByRole("button", { name: "Retry removal" }).click();
  await expect(page.locator("dialog.ops-confirm-action")).toHaveCount(0);
  await expect(card.getByRole("status")).toHaveText("linked@example.test was removed.");
  await expect(card.getByRole("button", { name: "Retry removal" })).toHaveCount(0);
  expect(seen.deletes).toEqual([{ expectedVersion: 3 }, { expectedVersion: 3 }]);
});
