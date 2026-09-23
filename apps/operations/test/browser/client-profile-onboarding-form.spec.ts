import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const stylesheet = readFileSync(new URL("../../src/client/ClientProfileOnboardingForm.css", import.meta.url), "utf8");
const markup = `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${stylesheet}</style><main class="client-profile-onboarding"><section class="client-profile-onboarding-card"><header><p class="client-profile-onboarding-eyebrow">LedgeTop Ops Client Portal</p><h1>Client profile onboarding</h1></header><form class="client-profile-onboarding-form"><fieldset class="client-profile-onboarding-type"><legend>Profile type</legend><div><label><input type="radio" checked> Individual</label><label><input type="radio"> Organization</label></div></fieldset><div class="client-profile-onboarding-grid"><label class="client-profile-onboarding-field">Contact name <input required></label><label class="client-profile-onboarding-field">Email address <input type="email" required></label><label class="client-profile-onboarding-field">Phone <input></label><div class="client-profile-onboarding-span-two"><label class="client-profile-onboarding-field">Address line 1 <input></label></div><div class="client-profile-onboarding-span-two"><label class="client-profile-onboarding-field">Address line 2 <input></label></div><label class="client-profile-onboarding-field">City <input></label><label class="client-profile-onboarding-field">Region / state <input maxlength="2"></label><label class="client-profile-onboarding-field">Postal code <input maxlength="20"></label><label class="client-profile-onboarding-field">Country <input></label></div><button>Continue</button></form></section></main>`;

test("onboarding form stays contained and collapses to one column at 320px", async ({ page }) => {
  await page.setContent(markup);
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 320, height: 900 });
  const fields = await page.locator(".client-profile-onboarding-grid > :not(.client-profile-onboarding-span-two)").evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect(); return { x: rect.x, width: rect.width };
  }));
  expect(new Set(fields.map(field => field.x)).size).toBe(1);
  expect(new Set(fields.map(field => field.width)).size).toBe(1);
  await expect(page.getByLabel("Email address")).toHaveAttribute("required", "");
  await expect(page.getByLabel("Region / state")).toHaveAttribute("maxlength", "2");
});
