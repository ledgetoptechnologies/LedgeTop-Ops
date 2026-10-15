import { expect, test } from "@playwright/test";

const invitationId = "00000000-0000-4000-8000-000000000001";
const invitationSecret = "ab".repeat(32);
const onboardingPath = `/onboarding/${invitationId}`;

test("recipient invitation scrubs its secret before opening and submits exactly once", async ({ page }) => {
  const requests: Array<{ path: string; body: Record<string, unknown>; visibleUrl: string }> = [];
  await page.route("**/api/client-onboarding/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push({ path, body: request.postDataJSON() as Record<string, unknown>, visibleUrl: page.url() });
    await route.fulfill({ json: { state: path.endsWith("/submit") ? "submitted" : "pending" } });
  });

  await page.goto(`${onboardingPath}#${invitationSecret}`);
  await expect(page).toHaveURL(`http://127.0.0.1:4173${onboardingPath}`);
  await expect(page.getByRole("heading", { name: "Client profile onboarding" })).toBeVisible();
  expect(requests[0]?.path).toBe(`/api/client-onboarding/${invitationId}/session`);
  expect(requests[0]?.body).toEqual({ invitationSecret });
  expect(requests[0]?.visibleUrl).toBe(`http://127.0.0.1:4173${onboardingPath}`);

  await page.getByRole("textbox", { name: "Contact name" }).fill("Example Recipient");
  await page.getByRole("textbox", { name: "Email address" }).fill("recipient@example.invalid");
  await page.getByRole("button", { name: "Submit for Review" }).click();
  await expect(page.getByRole("heading", { name: "Information submitted" })).toBeVisible();

  expect(requests.map(request => request.path)).toEqual([
    `/api/client-onboarding/${invitationId}/session`,
    `/api/client-onboarding/${invitationId}/status`,
    `/api/client-onboarding/${invitationId}/submit`,
  ]);
  expect(requests[1]?.body.invitationSecret).toBe(invitationSecret);
  expect(requests[2]?.body.invitationSecret).toBe(invitationSecret);
  expect(requests[2]?.body.fields).toMatchObject({
    clientType: "consumer",
    name: "Example Recipient",
    email: "recipient@example.invalid",
  });
  expect(requests[2]?.body.submissionId).toBe(requests[1]?.body.submissionId);
  expect(requests[2]?.body.submissionId).toMatch(/^[0-9a-f-]{36}$/);
  for (const request of requests) {
    expect(request.visibleUrl).not.toContain(invitationSecret);
    expect(request.path).not.toContain(invitationSecret);
  }
  await expect(page.locator("body")).not.toContainText(invitationSecret);
});

test("a synthetic onboarding URL without a secret stays unavailable without an API request", async ({ page }) => {
  let recipientRequests = 0;
  await page.route("**/api/client-onboarding/**", async route => {
    recipientRequests += 1;
    await route.abort();
  });
  await page.goto(onboardingPath);
  await expect(page.getByRole("heading", { name: "Invitation unavailable" })).toBeVisible();
  expect(recipientRequests).toBe(0);
});
