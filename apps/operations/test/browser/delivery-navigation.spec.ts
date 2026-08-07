import { expect, test, type Page } from "@playwright/test";

type DeliveryNavigationOptions = {
  jobsRootEnabled: boolean;
};

async function mockDeliveryNavigation(
  page: Page,
  { jobsRootEnabled }: DeliveryNavigationOptions,
) {
  const folderPrefixes: string[] = [];

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") {
      await route.fulfill({
        json: {
          user: {
            id: "staff-navigation-test",
            email: "staff-navigation@example.test",
            displayName: "Navigation Test Staff",
            status: "Active",
            profileType: "Employee",
            isAdministrator: false,
            permissions: ["delivery.browse"],
            divisions: [],
          },
          csrfToken: "csrf-navigation-test",
          timezone: "America/Chicago",
          mapStyleUrl: null,
          mapboxPublicToken: null,
          capabilities: {
            deliveryJobsRoot: { enabled: jobsRootEnabled },
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/delivery/folders") {
      const prefix = url.searchParams.get("prefix") || "";
      folderPrefixes.push(prefix);
      await route.fulfill({
        json: { prefix, folders: [], files: [], nextCursor: null },
      });
      return;
    }
    if (url.pathname === "/api/delivery/folders/locations") {
      await route.fulfill({
        json: { points: [], imageCount: 0, truncated: false },
      });
      return;
    }
    if (url.pathname === "/api/delivery/shares") {
      await route.fulfill({ json: { shares: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  return folderPrefixes;
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function mockDeliveryNavigationRace(page: Page) {
  const firstRoot = deferred();
  const nested = deferred();
  const nestedRequested = deferred();
  let rootRequests = 0;

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") {
      await route.fulfill({
        json: {
          user: {
            id: "staff-navigation-race",
            email: "staff-navigation-race@example.test",
            displayName: "Navigation Race Staff",
            status: "Active",
            profileType: "Employee",
            isAdministrator: false,
            permissions: ["delivery.browse"],
            divisions: [],
          },
          csrfToken: "csrf-navigation-race",
          timezone: "America/Chicago",
          mapStyleUrl: null,
          mapboxPublicToken: null,
          capabilities: { deliveryJobsRoot: { enabled: true } },
        },
      });
      return;
    }
    if (url.pathname === "/api/delivery/folders") {
      const prefix = url.searchParams.get("prefix") || "";
      if (prefix === "Jobs/Clients/Acme/Current/") {
        await route.fulfill({ json: { prefix, folders: [], files: [], nextCursor: null } });
        return;
      }
      if (prefix === "Jobs/Clients/Acme/") {
        nestedRequested.release();
        await nested.promise;
        await route.fulfill({ json: { prefix, folders: [], files: [], nextCursor: null } }).catch(() => {});
        return;
      }
      if (prefix === "Jobs/Clients/") {
        rootRequests += 1;
        if (rootRequests === 1) await firstRoot.promise;
        await route.fulfill({
          json: {
            prefix,
            folders: [{
              id: "folder-acme",
              prefix: "Jobs/Clients/Acme/",
              name: "Acme",
              displayName: "Acme",
              isShared: false,
            }],
            files: [],
            nextCursor: null,
          },
        });
        return;
      }
    }
    if (url.pathname === "/api/delivery/folders/locations") {
      await route.fulfill({ json: { points: [], imageCount: 0, truncated: false } });
      return;
    }
    if (url.pathname === "/api/delivery/shares") {
      await route.fulfill({ json: { shares: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  return { firstRoot, nested, nestedRequested };
}

async function mockStaleOperationRefresh(page: Page) {
  const operation = deferred();
  const operationRequested = deferred();
  const root = deferred();
  const rootRequested = deferred();
  let sourceFolderRequests = 0;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/session") {
      await route.fulfill({
        json: {
          user: {
            id: "staff-stale-operation",
            email: "staff-stale-operation@example.test",
            displayName: "Stale Operation Staff",
            status: "Active",
            profileType: "Administrator",
            isAdministrator: true,
            permissions: ["delivery.browse", "delivery.files.create"],
            divisions: [],
          },
          csrfToken: "csrf-stale-operation",
          timezone: "America/Chicago",
          mapStyleUrl: null,
          mapboxPublicToken: null,
          capabilities: { deliveryJobsRoot: { enabled: true } },
        },
      });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/delivery/fs/folders") {
      operationRequested.release();
      await operation.promise;
      await route.fulfill({
        json: { status: "completed", progress: 1, message: "Folder created" },
      });
      return;
    }
    if (url.pathname === "/api/delivery/folders") {
      const prefix = url.searchParams.get("prefix") || "";
      if (prefix === "Jobs/Clients/Acme/Current/") {
        sourceFolderRequests += 1;
        await route.fulfill({ json: { prefix, folders: [], files: [], nextCursor: null } });
        return;
      }
      if (prefix === "Jobs/Clients/") {
        rootRequested.release();
        await root.promise;
        await route.fulfill({
          json: {
            prefix,
            folders: [{
              id: "folder-acme",
              prefix: "Jobs/Clients/Acme/",
              name: "Acme",
              displayName: "Acme",
              isShared: false,
            }],
            files: [],
            nextCursor: null,
          },
        }).catch(() => {});
        return;
      }
    }
    if (url.pathname === "/api/delivery/folders/locations") {
      await route.fulfill({ json: { points: [], imageCount: 0, truncated: false } });
      return;
    }
    if (url.pathname === "/api/delivery/shares") {
      await route.fulfill({ json: { shares: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  return {
    operation,
    operationRequested,
    root,
    rootRequested,
    sourceFolderRequests: () => sourceFolderRequests,
  };
}

async function mockDeliveryPagination(page: Page) {
  const cursors: Array<string | null> = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") {
      await route.fulfill({
        json: {
          user: {
            id: "staff-pagination",
            email: "staff-pagination@example.test",
            displayName: "Pagination Staff",
            status: "Active",
            profileType: "Employee",
            isAdministrator: false,
            permissions: ["delivery.browse"],
            divisions: [],
          },
          csrfToken: "csrf-pagination",
          timezone: "America/Chicago",
          mapStyleUrl: null,
          mapboxPublicToken: null,
          capabilities: { deliveryJobsRoot: { enabled: true } },
        },
      });
      return;
    }
    if (url.pathname === "/api/delivery/folders") {
      const prefix = url.searchParams.get("prefix") || "";
      const cursor = url.searchParams.get("cursor");
      cursors.push(cursor);
      if (!cursor) {
        await route.fulfill({ json: {
          prefix,
          folders: [{ id: "folder-alpha", prefix: `${prefix}Alpha/`, name: "Alpha", displayName: "Alpha" }],
          files: [{ id: "file-one", name: "one.txt", displayName: "one.txt", kind: "text", size: 3 }],
          nextCursor: "page-2",
        } });
        return;
      }
      if (cursor === "page-2") {
        await route.fulfill({ json: {
          prefix,
          folders: [
            { id: "folder-alpha", prefix: `${prefix}Alpha/`, name: "Duplicate Alpha", displayName: "Duplicate Alpha" },
            { id: "folder-bravo", prefix: `${prefix}Bravo/`, name: "Bravo", displayName: "Bravo" },
          ],
          files: [
            { id: "file-one", name: "duplicate-one.txt", displayName: "duplicate-one.txt", kind: "text", size: 3 },
            { id: "file-two", name: "two.txt", displayName: "two.txt", kind: "text", size: 3 },
          ],
          nextCursor: "page-3",
        } });
        return;
      }
      await route.fulfill({ json: {
        prefix,
        folders: [{ id: "folder-charlie", prefix: `${prefix}Charlie/`, name: "Charlie", displayName: "Charlie" }],
        files: [],
        nextCursor: null,
      } });
      return;
    }
    if (url.pathname === "/api/delivery/folders/locations") {
      await route.fulfill({ json: { points: [], imageCount: 0, truncated: false } });
      return;
    }
    if (url.pathname === "/api/delivery/shares") {
      await route.fulfill({ json: { shares: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return cursors;
}

async function mockPaginationNavigationRace(page: Page) {
  const secondPage = deferred();
  const secondPageRequested = deferred();
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") {
      await route.fulfill({ json: {
        user: {
          id: "staff-pagination-race",
          email: "staff-pagination-race@example.test",
          displayName: "Pagination Race Staff",
          status: "Active",
          profileType: "Employee",
          isAdministrator: false,
          permissions: ["delivery.browse"],
          divisions: [],
        },
        csrfToken: "csrf-pagination-race",
        timezone: "America/Chicago",
        mapStyleUrl: null,
        mapboxPublicToken: null,
        capabilities: { deliveryJobsRoot: { enabled: true } },
      } });
      return;
    }
    if (url.pathname === "/api/delivery/folders") {
      const prefix = url.searchParams.get("prefix") || "";
      const cursor = url.searchParams.get("cursor");
      if (prefix === "Jobs/Clients/Acme/Current/" && !cursor) {
        await route.fulfill({ json: {
          prefix,
          folders: [{ id: "old-first", prefix: `${prefix}Old first/`, name: "Old first", displayName: "Old first" }],
          files: [],
          nextCursor: "slow-page-2",
        } });
        return;
      }
      if (prefix === "Jobs/Clients/Acme/Current/" && cursor === "slow-page-2") {
        secondPageRequested.release();
        await secondPage.promise;
        await route.fulfill({ json: {
          prefix,
          folders: [{ id: "late-old", prefix: `${prefix}Late old/`, name: "Late old", displayName: "Late old" }],
          files: [],
          nextCursor: null,
        } }).catch(() => {});
        return;
      }
      if (prefix === "Jobs/Clients/") {
        await route.fulfill({ json: {
          prefix,
          folders: [{ id: "current-root", prefix: `${prefix}Current root/`, name: "Current root", displayName: "Current root" }],
          files: [],
          nextCursor: null,
        } });
        return;
      }
    }
    if (url.pathname === "/api/delivery/folders/locations") {
      await route.fulfill({ json: { points: [], imageCount: 0, truncated: false } });
      return;
    }
    if (url.pathname === "/api/delivery/shares") {
      await route.fulfill({ json: { shares: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return { secondPage, secondPageRequested };
}

test("Delivery navigation defaults to the Jobs/Clients workspace", async ({ page }) => {
  const prefixes = await mockDeliveryNavigation(page, { jobsRootEnabled: true });

  await page.goto("/jobs/Archive");
  await expect.poll(() => prefixes.includes("Jobs/Archive/")).toBe(true);

  await page.locator(".ops-header").getByRole("button", { name: "Delivery" }).click();

  await expect(page).toHaveURL(/\/delivery$/);
  await expect.poll(() => prefixes.includes("Jobs/Clients/")).toBe(true);
  await expect(
    page.getByRole("navigation", { name: "Current delivery folder" }),
  ).toContainText("Jobs/Clients");
});

test("enabled Jobs breadcrumb opens the true Jobs root", async ({ page }) => {
  const prefixes = await mockDeliveryNavigation(page, { jobsRootEnabled: true });

  await page.goto("/delivery/Acme/Current");
  await expect.poll(() => prefixes.includes("Jobs/Clients/Acme/Current/")).toBe(true);

  await page
    .getByRole("navigation", { name: "Current delivery folder" })
    .getByRole("button", { name: "Jobs", exact: true })
    .click();

  await expect(page).toHaveURL(/\/jobs$/);
  await expect.poll(() => prefixes.includes("Jobs/")).toBe(true);
});

test("Jobs breadcrumb is not interactive without root capability", async ({ page }) => {
  await mockDeliveryNavigation(page, { jobsRootEnabled: false });

  await page.goto("/delivery/Acme/Current");
  const crumbs = page.getByRole("navigation", { name: "Current delivery folder" });

  await expect(crumbs.getByText("Jobs", { exact: true })).toBeVisible();
  await expect(
    crumbs.getByRole("button", { name: "Jobs", exact: true }),
  ).toHaveCount(0);
});

test("direct /jobs routes render Delivery at the true Jobs root", async ({ page }) => {
  const prefixes = await mockDeliveryNavigation(page, { jobsRootEnabled: true });

  await page.goto("/jobs");

  await expect(page.locator(".ops-header").getByRole("button", { name: "Delivery" })).toHaveClass(/active/);
  await expect.poll(() => prefixes.includes("Jobs/")).toBe(true);
  await expect(page.getByRole("navigation", { name: "Current delivery folder" })).toHaveText("Jobs");
});

test("returning to Jobs/Clients clears stale folder data and ignores a late nested response", async ({ page }) => {
  const race = await mockDeliveryNavigationRace(page);
  await page.goto("/delivery/Acme/Current");
  await expect(page.getByText("This folder is empty", { exact: true })).toBeVisible();

  const crumbs = page.getByRole("navigation", { name: "Current delivery folder" });
  await crumbs.getByRole("button", { name: "Clients", exact: true }).click();
  await expect(page.locator(".delivery-skeleton")).toBeVisible();
  await expect(page.getByText("This folder is empty", { exact: true })).toHaveCount(0);

  race.firstRoot.release();
  await expect(page.locator(".file-card-title", { hasText: "Acme" })).toBeVisible();

  await page.locator(".file-card", { hasText: "Acme" }).click();
  await race.nestedRequested.promise;
  await page
    .getByRole("navigation", { name: "Current delivery folder" })
    .getByRole("button", { name: "Clients", exact: true })
    .click();

  await expect(page).toHaveURL(/\/delivery$/);
  await expect(page.locator(".file-card-title", { hasText: "Acme" })).toBeVisible();
  race.nested.release();
  await page.waitForTimeout(150);
  await expect(page.locator(".file-card-title", { hasText: "Acme" })).toBeVisible();
  await expect(page.getByText("This folder is empty", { exact: true })).toHaveCount(0);
});

test("an operation completed in an old prefix cannot abort or replace the current folder load", async ({ page }) => {
  const race = await mockStaleOperationRefresh(page);
  await page.goto("/delivery/Acme/Current");
  await expect(page.getByText("This folder is empty", { exact: true })).toBeVisible();

  page.once("dialog", dialog => dialog.accept("Synthetic folder"));
  await page.getByRole("button", { name: "New folder" }).click();
  await race.operationRequested.promise;
  await page
    .getByRole("navigation", { name: "Current delivery folder" })
    .getByRole("button", { name: "Clients", exact: true })
    .click();
  await race.rootRequested.promise;

  race.operation.release();
  await page.waitForTimeout(100);
  expect(race.sourceFolderRequests()).toBe(1);

  race.root.release();
  await expect(page.locator(".file-card-title", { hasText: "Acme" })).toBeVisible();
  await expect(page).toHaveURL(/\/delivery$/);
});

test("folder pagination loads every page and deduplicates repeated item identities", async ({ page }) => {
  const cursors = await mockDeliveryPagination(page);
  await page.goto("/delivery/Acme/Current");

  await expect(page.locator(".file-card-title", { hasText: "Charlie" })).toBeVisible();
  expect(cursors).toEqual([null, "page-2", "page-3"]);
  await expect(page.locator(".file-card-title", { hasText: "Alpha" })).toHaveCount(1);
  await expect(page.getByText("Duplicate Alpha", { exact: true })).toHaveCount(0);
  await expect(page.getByText("one.txt", { exact: true })).toHaveCount(1);
  await expect(page.getByText("duplicate-one.txt", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Bravo", { exact: true })).toBeVisible();
  await expect(page.getByText("two.txt", { exact: true })).toBeVisible();
});

test("navigation during page two aborts the old cursor chain without contaminating the new folder", async ({ page }) => {
  const race = await mockPaginationNavigationRace(page);
  await page.goto("/delivery/Acme/Current");
  await expect(page.locator(".file-card-title", { hasText: "Old first" })).toBeVisible();
  await race.secondPageRequested.promise;

  await page
    .getByRole("navigation", { name: "Current delivery folder" })
    .getByRole("button", { name: "Clients", exact: true })
    .click();
  await expect(page.locator(".file-card-title", { hasText: "Current root" })).toBeVisible();

  race.secondPage.release();
  await page.waitForTimeout(150);
  await expect(page.locator(".file-card-title", { hasText: "Current root" })).toBeVisible();
  await expect(page.getByText("Late old", { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/delivery$/);
});
