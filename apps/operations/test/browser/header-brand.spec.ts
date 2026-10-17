import { expect, test, type Page } from "@playwright/test";

async function mockSession(page: Page) {
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: {
      user: { id: "header-staff", email: "staff@example.test", displayName: "Header Staff", status: "Active", profileType: "Administrator",
        isAdministrator: true, permissions: ["delivery.browse"], divisions: [] },
      csrfToken: "header-fixture", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: { deliveryJobsRoot: { enabled: true } },
    } });
    if (url.pathname === "/api/delivery/folders") return route.fulfill({ json: { prefix: "Jobs/Clients/", folders: [], files: [], nextCursor: null } });
    if (url.pathname === "/api/delivery/folders/locations") return route.fulfill({ json: { points: [], imageCount: 0, truncated: false } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
}

const brandState = (page: Page) => page.locator(".ops-header .ltds-brand").evaluate(brand => {
  const name = brand.querySelector("span")!, rect = brand.getBoundingClientRect(), nav = document.querySelector(".ops-header > nav")?.getBoundingClientRect();
  return {
    nameVisible: name.getBoundingClientRect().width > 1,
    nameText: name.textContent,
    truncated: brand.scrollWidth > brand.clientWidth + 1,
    overlapsNav: nav ? rect.right > nav.left + 1 : false,
  };
});

for (const width of [1000, 1180]) test(`at ${width}px the header shows the LT mark only, never a clipped name`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  await mockSession(page);
  await page.goto("/delivery");
  await expect(page.locator(".ops-header .ltds-brand")).toBeVisible();
  const state = await brandState(page);
  expect(state).toMatchObject({ nameVisible: false, truncated: false, overlapsNav: false });
  expect(state.nameText).toContain("Ledge Top");
});

for (const width of [1280, 1440]) test(`at ${width}px the full brand fits beside the menu`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  await mockSession(page);
  await page.goto("/delivery");
  await expect(page.locator(".ops-header .ltds-brand")).toBeVisible();
  expect(await brandState(page)).toMatchObject({ nameVisible: true, truncated: false, overlapsNav: false });
});
