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

// On desktop the brand sits at the top of the sidebar; the top bar repeats it only when the sidebar becomes a drawer.
const brandState = (page: Page) => page.locator(".ltds-sidebar-brand .ltds-brand").evaluate(brand => {
  const name = brand.querySelector("span")!, rect = brand.getBoundingClientRect(), side = brand.closest(".ltds-sidebar")!.getBoundingClientRect();
  return {
    nameVisible: name.getBoundingClientRect().width > 1,
    nameText: name.textContent,
    truncated: brand.scrollWidth > brand.clientWidth + 1,
    overflowsSidebar: rect.right > side.right + 1,
  };
});

for (const width of [1000, 1180, 1280, 1440]) test(`at ${width}px the full brand fits in the sidebar and is not repeated in the top bar`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  await mockSession(page);
  await page.goto("/delivery");
  await expect(page.locator(".ltds-sidebar-brand .ltds-brand")).toBeVisible();
  const state = await brandState(page);
  expect(state).toMatchObject({ nameVisible: true, truncated: false, overflowsSidebar: false });
  expect(state.nameText).toContain("Ledge Top");
  await expect(page.locator(".ops-header > .ltds-brand")).toBeHidden();
});

test("the collapsed sidebar keeps the LT mark and every area reachable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockSession(page);
  await page.goto("/delivery");
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.locator(".ltds-sidebar-brand .ltds-mark")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Data" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(page.locator(".ltds-sidebar-brand .ltds-brand")).toBeVisible();
});
