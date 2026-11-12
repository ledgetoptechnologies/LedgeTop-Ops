import { expect, test, type Page } from "@playwright/test";

async function mockSession(page: Page, permissions = ["delivery.browse"]) {
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: {
      user: { id: "header-staff", email: "staff@example.test", displayName: "Header Staff", status: "Active", profileType: "Administrator",
        isAdministrator: true, permissions, divisions: [] },
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

test("keyboard: a collapsed-rail flyout opens on Enter, Escape returns focus to its area button, and Tab continues from there", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // Two Data sections, so Data is a flyout button in the rail rather than a plain link.
  await mockSession(page, ["delivery.browse", "delivery.share.audit"]);
  await page.goto("/delivery");
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  const nav = page.getByRole("navigation", { name: "Primary navigation" });
  const data = nav.getByRole("button", { name: "Data" });
  await data.focus();
  await page.keyboard.press("Enter");
  const flyout = page.getByRole("group", { name: "Data" });
  await expect(flyout).toBeVisible();
  await expect(data).toHaveAttribute("aria-expanded", "true");
  await expect(flyout.getByRole("link", { name: "Client delivery" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(flyout).toBeHidden();
  await expect(data).toBeFocused();
  await expect(data).toHaveAttribute("aria-expanded", "false");
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);

  // Tab order continues from the area button: the next control in the rail, not the start of the page.
  const expected = await data.evaluate(button => {
    const all = [...document.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")].filter(el => el.offsetParent !== null);
    const next = all[all.indexOf(button as HTMLElement) + 1];
    return next?.getAttribute("aria-label") ?? next?.textContent?.trim() ?? null;
  });
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => { const el = document.activeElement as HTMLElement | null; return el?.getAttribute("aria-label") ?? el?.textContent?.trim() ?? null; });
  expect(focused).toBe(expected);
  expect(focused).not.toBeNull();

  // Reopening and pressing Escape from inside the flyout again lands back on the button.
  await data.focus();
  await page.keyboard.press("Enter");
  await expect(flyout).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await expect(flyout).toBeHidden();
  await expect(data).toBeFocused();
});
