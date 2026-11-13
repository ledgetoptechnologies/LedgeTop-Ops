import { expect, test } from "@playwright/test";

test("authenticated invitation acceptance immediately removes the secret from URL history", async ({ page }) => {
  const token = "A".repeat(43);
  let requestUrl = "";
  let requestBody: unknown;
  await page.route("**/api/client/v2/invitations/accept", async route => {
    requestUrl = route.request().url();
    requestBody = route.request().postDataJSON();
    await route.fulfill({ json: { accepted: true, replayed: false } });
  });
  await page.goto(`/portal/invitations/accept#token=${token}`);
  await expect(page).toHaveURL("http://127.0.0.1:4173/portal/invitations/accept");
  await expect(page.getByRole("heading", { name: "Access ready" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open client portal" })).toHaveAttribute("href", "/portal/dashboard");
  expect(requestUrl).toBe("http://127.0.0.1:4173/api/client/v2/invitations/accept");
  expect(requestUrl).not.toContain(token);
  expect(requestBody).toEqual({ token });
  expect(await page.evaluate(() => window.location.hash)).toBe("");
});

test("invitation acceptance presents a safe email-mismatch error on desktop and mobile", async ({ page }) => {
  const token = "B".repeat(43);
  await page.route("**/api/client/v2/invitations/accept", route => route.fulfill({ status: 404, json: { error: "Invitation not found" } }));
  await page.goto(`/portal/invitations/accept#token=${token}`);
  await expect(page).toHaveURL("http://127.0.0.1:4173/portal/invitations/accept");
  await expect(page.getByRole("heading", { name: "Invitation unavailable" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("invalid, expired, revoked, or belongs to a different email address");
  await expect(page.getByRole("link", { name: "Go to client portal" })).toHaveAttribute("href", "/portal/dashboard");
  await expect(page.locator("body")).not.toContainText(token);
});

test("incomplete invitation offers email recovery without putting a capability in navigation", async ({ page }) => {
  await page.goto("/portal/invitations/accept");
  await expect(page.getByRole("heading", { name: "Invitation unavailable" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in with a different email" })).toHaveAttribute("href", "/cdn-cgi/access/logout");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page).toHaveURL("http://127.0.0.1:4173/portal/invitations/accept");
});

test("invitation retry keeps the opaque token in memory and Access recovery returns only to portal", async ({ page }) => {
  const token = "C".repeat(43);
  const bodies: unknown[] = [];
  let logoutCalled = false;
  await page.route("**/api/client/v2/invitations/accept", async route => {
    bodies.push(route.request().postDataJSON());
    return bodies.length === 1 ? route.fulfill({ status: 503, json: { error: "unavailable" } })
      : route.fulfill({ status: 404, json: { error: "unavailable" } });
  });
  await page.route("**/cdn-cgi/access/logout", async route => {
    logoutCalled = true;
    await route.fulfill({ status: 200, body: "signed out" });
  });
  await page.goto(`/portal/invitations/accept#token=${token}`);
  await expect(page.getByRole("heading", { name: "Invitation status uncertain" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in with a different email" })).toHaveCount(0);
  await expect(page).toHaveURL("http://127.0.0.1:4173/portal/invitations/accept");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Invitation unavailable" })).toBeVisible();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies).toEqual([{ token }, { token }]);
  expect(await page.evaluate(() => window.location.href)).not.toContain(token);
  await page.getByRole("link", { name: "Sign in with a different email" }).click();
  await expect(page).toHaveURL("http://127.0.0.1:4173/portal");
  expect(logoutCalled).toBe(true);
  expect(await page.evaluate(() => window.location.href)).not.toContain(token);
});


test("uncertain invitation acceptance reconciles a replay with the same token before email switching", async ({ page }) => {
  const token = "D".repeat(43), bodies: unknown[] = [];
  await page.route("**/api/client/v2/invitations/accept", async route => {
    bodies.push(route.request().postDataJSON());
    return bodies.length === 1 ? route.abort("failed")
      : route.fulfill({ json: { accepted: true, replayed: true } });
  });
  await page.goto(`/portal/invitations/accept#token=${token}`);
  await expect(page.getByRole("heading", { name: "Invitation status uncertain" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in with a different email" })).toHaveCount(0);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Access ready" })).toBeVisible();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies).toEqual([{ token }, { token }]);
  await expect(page.getByText("This invitation was already accepted by your signed-in account.")).toBeVisible();
  expect(page.url()).not.toContain(token);
});
