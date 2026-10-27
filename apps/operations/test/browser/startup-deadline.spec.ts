import { expect, test } from "@playwright/test";

const session = {
  user: { id: "owner-a", email: "owner@example.test", displayName: "Owner User", status: "Active", profileType: "Administrator",
    isAdministrator: true, permissions: ["dashboard.view", "administration.view"], divisions: [] },
  csrfToken: "csrf-test", timezone: "America/Chicago", capabilities: {},
};

test("a sign-in check that never answers offers recovery, ignores a late answer and starts fresh on Try again", async ({ page }) => {
  await page.clock.install();
  const held: import("@playwright/test").Route[] = [];
  let holding = true;
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") { if (holding) { held.push(route); return; } return route.fulfill({ json: session }); }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/");
  await expect.poll(() => held.length).toBe(1);
  await page.clock.runFor(19_000);
  await expect(page.getByRole("heading", { name: "Operations is unavailable right now" })).toHaveCount(0);
  await page.clock.runFor(1_500);
  await expect(page.getByRole("heading", { name: "Operations is unavailable right now" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Sign in/ })).toBeVisible();
  await held[0]!.fulfill({ json: session }).catch(() => undefined);
  await page.clock.runFor(1_000);
  await expect(page.getByRole("heading", { name: "Operations is unavailable right now" })).toBeVisible();
  holding = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Operations dashboard" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Operations is unavailable right now" })).toHaveCount(0);
});
