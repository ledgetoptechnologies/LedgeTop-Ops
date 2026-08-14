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
  await expect(page.getByRole("heading", { name: "Workspace access ready" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open client portal" })).toBeVisible();
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
  await expect(page.getByRole("link", { name: "Go to client portal" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(token);
});
