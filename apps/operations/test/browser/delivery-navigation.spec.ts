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

async function deliveryNavigationLink(page: Page) {
  if ((page.viewportSize()?.width || 0) <= 960) {
    await page.getByRole("button", { name: "Open navigation" }).click();
    return page.getByRole("dialog", { name: "Navigation" }).getByRole("link", { name: "Data" });
  }
  return page.locator(".ops-header").getByRole("link", { name: "Data" });
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

async function mockCachedEmptyRootReturn(page: Page) {
  const secondRoot = deferred();
  const secondRootRequested = deferred();
  let rootRequests = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") {
      await route.fulfill({ json: {
        user: {
          id: "staff-cached-empty",
          email: "staff-cached-empty@example.test",
          displayName: "Cached Empty Staff",
          status: "Active",
          profileType: "Employee",
          isAdministrator: false,
          permissions: ["delivery.browse"],
          divisions: [],
        },
        csrfToken: "csrf-cached-empty",
        timezone: "America/Chicago",
        mapStyleUrl: null,
        mapboxPublicToken: null,
        capabilities: { deliveryJobsRoot: { enabled: true } },
      } });
      return;
    }
    if (url.pathname === "/api/delivery/folders") {
      const prefix = url.searchParams.get("prefix") || "";
      if (prefix === "Jobs/Clients/Acme/Current/") {
        await route.fulfill({ json: { prefix, folders: [], files: [], nextCursor: null } });
        return;
      }
      if (prefix === "Jobs/Clients/") {
        rootRequests += 1;
        if (rootRequests === 1) {
          await route.fulfill({ json: { prefix, folders: [], files: [], nextCursor: null } });
          return;
        }
        secondRootRequested.release();
        await secondRoot.promise;
        await route.fulfill({ json: {
          prefix,
          folders: [{ id: "root-acme", prefix: `${prefix}Acme/`, name: "Acme", displayName: "Acme" }],
          files: [],
          nextCursor: null,
        } }).catch(() => {});
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
  return { secondRoot, secondRootRequested };
}

test("Delivery navigation defaults to the Jobs/Clients workspace", async ({ page }) => {
  const prefixes = await mockDeliveryNavigation(page, { jobsRootEnabled: true });

  await page.goto("/jobs/Archive");
  await expect.poll(() => prefixes.includes("Jobs/Archive/")).toBe(true);

  await (await deliveryNavigationLink(page)).click();

  await expect(page).toHaveURL(/\/delivery$/);
  await expect.poll(() => prefixes.includes("Jobs/Clients/")).toBe(true);
  await expect(
    page.getByRole("navigation", { name: "Current delivery folder" }),
  ).toContainText("Jobs/Clients");
  await expect(page.getByRole("button", { name: "Share current folder" })).toHaveCount(0);
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

  await expect(await deliveryNavigationLink(page)).toHaveAttribute("aria-current", "page");
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

test("folder pagination paints page one, prefetches near the boundary, and deduplicates repeated item identities", async ({ page }) => {
  const cursors = await mockDeliveryPagination(page);
  await page.goto("/delivery/Acme/Current");

  await expect(page.locator(".file-card-title", { hasText: "Alpha" })).toBeVisible();
  await expect(page.getByText("Bravo", { exact: true })).toBeVisible();
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

test("1200 immediate children paint in 150-item pages with one page request in flight", async ({ page }) => {
  const fixture=Array.from({length:1200},(_,index)=>({
    id:`asset-${String(index+1).padStart(4,"0")}`,
    physicalKey:`Jobs/Clients/Acme/Current/asset-${String(index+1).padStart(4,"0")}.jpg`,
    name:`Asset ${String(index+1).padStart(4,"0")}.jpg`,displayName:`Asset ${String(index+1).padStart(4,"0")}.jpg`,
    kind:"image",size:1024,uploadedAt:"2026-08-15T12:00:00.000Z",thumbnailState:"pending",
    thumbnailFallbackKind:"image",downloadUrl:`/api/delivery/items/asset-${index+1}/download`,
  }));
  let active=0,maxActive=0;
  const cursors:string[]=[];
  await page.route("**/api/**",async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==="/api/session")return route.fulfill({json:{user:{id:"staff-1200",email:"staff@example.test",displayName:"Staff",status:"Active",profileType:"Administrator",isAdministrator:true,permissions:["delivery.browse"],divisions:[]},csrfToken:"csrf-1200",timezone:"America/Chicago",mapStyleUrl:null,mapboxPublicToken:null,capabilities:{deliveryJobsRoot:{enabled:true}}}});
    if(url.pathname==="/api/delivery/access-revision")return route.fulfill({json:{revision:`dbr_${"a".repeat(43)}`}});
    if(url.pathname==="/api/delivery/folders"){
      const raw=url.searchParams.get("cursor"),offset=raw?Number(raw):0;
      cursors.push(raw||"root");active+=1;maxActive=Math.max(maxActive,active);
      await new Promise(resolve=>setTimeout(resolve,25));active-=1;
      return route.fulfill({json:{prefix:"Jobs/Clients/Acme/Current/",folders:[],files:fixture.slice(offset,offset+150),nextCursor:offset+150<fixture.length?String(offset+150):null,mediaHydrated:true,reconciliationNeeded:false}});
    }
    if(url.pathname==="/api/delivery/folders/locations")return route.fulfill({json:{points:[],imageCount:0,truncated:false}});
    if(url.pathname==="/api/delivery/shares")return route.fulfill({json:{shares:[]}});
    return route.fulfill({status:404,json:{error:"Not found"}});
  });

  await page.goto("/delivery/Acme/Current");
  await expect(page.locator(".file-card")).toHaveCount(150);
  await expect(page.getByText("Asset 0151.jpg",{exact:true})).toHaveCount(0);
  await expect.poll(()=>cursors.length).toBeGreaterThanOrEqual(2);
  expect(cursors.length).toBeLessThanOrEqual(2);
  for(const expected of [300,450,600,750,900,1050,1200]){
    await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
    await expect.poll(async()=>Math.max(0,...(await page.locator(".delivery-pagination small").allTextContents()).map(text=>{
      const match=/(?:of\s+)?(\d+)\s+(?:loaded\s+)?items|of\s+(\d+)\s+loaded items/.exec(text);
      return Number(match?.[1]||match?.[2]||0);
    })),{timeout:15_000}).toBeGreaterThanOrEqual(expected);
    expect(await page.locator(".file-card").count()).toBeLessThanOrEqual(450);
  }
  expect(cursors).toEqual(["root","150","300","450","600","750","900","1050"]);
  expect(maxActive).toBe(1);
  await expect(page.getByText("Showing 1–450 of 1200 loaded items",{exact:true})).toBeVisible();
  for(let index=0;index<5;index+=1)await page.getByRole("button",{name:"Show later"}).click();
  await expect(page.getByText("Showing 751–1200 of 1200 loaded items",{exact:true})).toBeVisible();
  await expect(page.getByText("Asset 1200.jpg",{exact:true})).toBeVisible();
});

test("folder cards render before advisory thumbnail and video state hydration completes", async ({ page }) => {
  const media = deferred();
  const mediaRequested = deferred();
  let thumbnailRequests = 0;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-deferred-media", email: "staff@example.test", displayName: "Staff", status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["delivery.browse"], divisions: [] },
      csrfToken: "csrf-deferred-media", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null,
      capabilities: { deliveryJobsRoot: { enabled: true } },
    } });
    if (url.pathname === "/api/delivery/access-revision") return route.fulfill({ json: { revision: `dbr_${"c".repeat(43)}` } });
    if (url.pathname === "/api/delivery/folders") return route.fulfill({ json: {
      prefix: "Jobs/Clients/Acme/Current/", folders: [], files: [{
        id: "video-one", physicalKey: "Jobs/Clients/Acme/Current/flight.mp4", name: "flight.mp4", displayName: "flight.mp4",
        kind: "video", size: 8192, uploadedAt: "2026-08-16T12:00:00.000Z", thumbnailState: "pending",
        thumbnailFallbackKind: "video", previewStatus: "processing", sourceUrl: "/api/delivery/items/video-one/source",
        downloadUrl: "/api/delivery/items/video-one/download",
      }], nextCursor: null, mediaHydrated: false,
    } });
    if (url.pathname === "/api/delivery/folders/media") {
      mediaRequested.release();
      await media.promise;
      return route.fulfill({ json: { items: [{ id: "video-one", thumbnailState: "ready", thumbnailUrl: "/api/delivery/items/video-one/thumbnail", previewStatus: "ready" }] } }).catch(() => {});
    }
    if (url.pathname === "/api/delivery/items/video-one/thumbnail") {
      thumbnailRequests += 1;
      return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="navy"/></svg>' });
    }
    if (url.pathname === "/api/delivery/folders/locations") return route.fulfill({ json: { points: [], imageCount: 0, truncated: false } });
    if (url.pathname === "/api/delivery/shares") return route.fulfill({ json: { shares: [] } });
    if (url.pathname === "/api/delivery/thumbnail-queue") return route.fulfill({ json: { pending: 0, processing: 0, total: 0 } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/delivery/Acme/Current");
  await mediaRequested.promise;
  await expect(page.getByRole("button", { name: "Open flight.mp4" })).toBeVisible();
  await expect(page.getByText("flight.mp4", { exact: true })).toBeVisible();
  expect(thumbnailRequests).toBe(0);

  media.release();
  await expect.poll(() => thumbnailRequests).toBeGreaterThan(0);
  await expect(page.getByRole("img", { name: "flight.mp4 thumbnail" })).toBeVisible();
});

test("a failed page prefetch keeps loaded cards visible and exposes a working retry",async({page})=>{
  let pageTwoAttempts=0;
  await page.addInitScript(()=>Object.defineProperty(window,"IntersectionObserver",{value:undefined,configurable:true}));
  await page.route("**/api/**",async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==="/api/session")return route.fulfill({json:{user:{id:"staff-retry",email:"staff@example.test",displayName:"Staff",status:"Active",profileType:"Employee",isAdministrator:false,permissions:["delivery.browse"],divisions:[]},csrfToken:"csrf-retry",timezone:"America/Chicago",mapStyleUrl:null,mapboxPublicToken:null,capabilities:{deliveryJobsRoot:{enabled:true}}}});
    if(url.pathname==="/api/delivery/access-revision")return route.fulfill({json:{revision:`dbr_${"b".repeat(43)}`}});
    if(url.pathname==="/api/delivery/folders"){
      const cursor=url.searchParams.get("cursor");
      if(!cursor)return route.fulfill({json:{prefix:"Jobs/Clients/Acme/Current/",folders:[{id:"first",prefix:"Jobs/Clients/Acme/Current/First/",name:"First",displayName:"First"}],files:[],nextCursor:"page-2",mediaHydrated:true}});
      pageTwoAttempts+=1;
      return pageTwoAttempts===1
        ?route.fulfill({status:503,json:{error:"Temporary listing failure"}})
        :route.fulfill({json:{prefix:"Jobs/Clients/Acme/Current/",folders:[{id:"second",prefix:"Jobs/Clients/Acme/Current/Second/",name:"Second",displayName:"Second"}],files:[],nextCursor:null,mediaHydrated:true}});
    }
    if(url.pathname==="/api/delivery/folders/locations")return route.fulfill({json:{points:[],imageCount:0,truncated:false}});
    if(url.pathname==="/api/delivery/shares")return route.fulfill({json:{shares:[]}});
    return route.fulfill({status:404,json:{error:"Not found"}});
  });
  await page.goto("/delivery/Acme/Current");
  await expect(page.getByText("First",{exact:true})).toBeVisible();
  const retry=page.getByRole("button",{name:"Retry loading more"});
  await expect(retry).toBeVisible();
  await expect(page.getByText(/next page could not be prepared|More items could not be loaded/)).toBeVisible();
  await retry.click();
  await expect(page.getByText("Second",{exact:true})).toBeVisible();
  await expect(page.getByText("First",{exact:true})).toBeVisible();
  expect(pageTwoAttempts).toBe(2);
});

test("browser back and forward never render a blank grid from a cached empty Jobs/Clients result", async ({ page }) => {
  const race = await mockCachedEmptyRootReturn(page);
  await page.goto("/delivery/Acme/Current");
  await expect(page.getByText("This folder is empty", { exact: true })).toBeVisible();

  await page
    .getByRole("navigation", { name: "Current delivery folder" })
    .getByRole("button", { name: "Clients", exact: true })
    .click();
  await expect(page).toHaveURL(/\/delivery$/);
  await expect(page.getByText("This folder is empty", { exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/delivery\/Acme\/Current$/);
  await page.goForward();
  await race.secondRootRequested.promise;
  await expect(page.locator(".delivery-skeleton")).toBeVisible();
  await expect(page.locator(".file-grid")).toHaveCount(0);

  race.secondRoot.release();
  await expect(page.locator(".file-card-title", { hasText: "Acme" })).toBeVisible();
});

test("direct Jobs deep links survive refresh for globally authorized Operations staff", async ({ page }) => {
  const prefixes = await mockDeliveryNavigation(page, { jobsRootEnabled: true });
  await page.goto("/jobs/Archive/2024");
  await expect.poll(() => prefixes.filter((prefix) => prefix === "Jobs/Archive/2024/").length).toBe(1);
  await page.reload();
  await expect.poll(() => prefixes.filter((prefix) => prefix === "Jobs/Archive/2024/").length).toBe(2);
  await expect(page).toHaveURL(/\/jobs\/Archive\/2024$/);
});

test("scoped staff cannot click the Jobs crumb and a direct Jobs request surfaces the server deny", async ({ page }) => {
  let jobsRequests = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") {
      await route.fulfill({ json: {
        user: {
          id: "staff-scoped",
          email: "staff-scoped@example.test",
          displayName: "Scoped Staff",
          status: "Active",
          profileType: "Employee",
          isAdministrator: false,
          permissions: ["delivery.browse"],
          divisions: [{ id: "division-a" }],
        },
        csrfToken: "csrf-scoped",
        timezone: "America/Chicago",
        mapStyleUrl: null,
        mapboxPublicToken: null,
        capabilities: { deliveryJobsRoot: { enabled: false } },
      } });
      return;
    }
    if (url.pathname === "/api/delivery/folders") {
      jobsRequests += 1;
      await route.fulfill({ status: 404, json: { error: "Folder not found" } });
      return;
    }
    if (url.pathname === "/api/delivery/folders/locations") {
      await route.fulfill({ status: 404, json: { error: "Folder not found" } });
      return;
    }
    if (url.pathname === "/api/delivery/shares") {
      await route.fulfill({ json: { shares: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/jobs");
  await expect(page.getByText("Folder not found", { exact: true }).first()).toBeVisible();
  expect(jobsRequests).toBe(1);
  await expect(
    page.getByRole("navigation", { name: "Current delivery folder" }).getByRole("button", { name: "Jobs", exact: true }),
  ).toHaveCount(0);
});

test("delivery search and per-item menu stay discoverable without selection mode", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: "staff-search", email: "staff-search@example.test", displayName: "Search Staff", status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["delivery.browse", "delivery.files.copy", "delivery.files.move", "delivery.delete", "delivery.share.create"], divisions: [] }, csrfToken: "csrf-search", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: { deliveryJobsRoot: { enabled: true } } } });
    if (url.pathname === "/api/delivery/folders") {
      const prefix = url.searchParams.get("prefix") || "Jobs/Clients/";
      return route.fulfill({ json: prefix === "Jobs/Clients/Acme/"
        ? { prefix, folders: [], files: [{ id: "acme-file", physicalKey: "Jobs/Clients/Acme/arrival.jpg", name: "arrival.jpg", displayName: "arrival.jpg", kind: "image", size: 1, uploadedAt: "2026-08-12T00:00:00.000Z" }], nextCursor: null }
        : { prefix, folders: [{ id: "folder-acme", prefix: "Jobs/Clients/Acme/", physicalKey: "Jobs/Clients/Acme/", name: "Acme", displayName: "Acme", kind: "folder", isShared: true }], files: [], nextCursor: null } });
    }
    if (url.pathname === "/api/delivery/search") return route.fulfill({ json: { items: [{ id: "folder-acme", prefix: "Jobs/Clients/Acme/", physicalKey: "Jobs/Clients/Acme/", name: "Acme", displayName: "Acme", kind: "folder", isShared: true }], nextCursor: null } });
    if (url.pathname === "/api/delivery/folders/media") return route.fulfill({ json: { items: [] } });
    if (url.pathname === "/api/delivery/folders/locations") return route.fulfill({ json: { points: [], imageCount: 0, truncated: false } });
    if (url.pathname === "/api/delivery/shares") return route.fulfill({ json: { shares: [] } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/delivery");
  const search = page.getByRole("textbox", { name: "Search" });
  await search.fill("Acme");
  const gridCard = page.locator(".file-card").filter({ hasText: "Acme" });
  const gridChrome = await gridCard.evaluate(element => {
    const card = element.getBoundingClientRect();
    const visualElement = element.querySelector<HTMLElement>(".file-visual")!;
    const actionElement = element.querySelector<HTMLElement>(".delivery-item-menu-trigger")!;
    const visual = visualElement.getBoundingClientRect();
    const share = element.querySelector(".share-chip")!.getBoundingClientRect();
    const actions = actionElement.getBoundingClientRect();
    const badge = element.querySelector(".file-card-title .shared-badge")!.getBoundingClientRect();
    const visualStyle = getComputedStyle(visualElement);
    const actionStyle = getComputedStyle(actionElement);
    const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    return {
      shareAtLeft: share.left - card.left,
      actionsAtRight: card.right - actions.right,
      badgeBelowVisual: badge.top >= visual.bottom,
      chromeOverlaps: overlaps(share, actions) || overlaps(share, badge) || overlaps(actions, badge),
      visualRadius: visualStyle.borderRadius,
      visualOverflow: visualStyle.overflow,
      actionBackground: actionStyle.backgroundColor,
      actionBorderStyle: actionStyle.borderStyle,
      actionShadow: actionStyle.boxShadow,
    };
  });
  expect(gridChrome.shareAtLeft).toBeLessThan(16);
  expect(gridChrome.actionsAtRight).toBeLessThan(16);
  expect(gridChrome.badgeBelowVisual).toBe(true);
  expect(gridChrome.chromeOverlaps).toBe(false);
  expect(gridChrome.visualRadius).toBe("11px");
  expect(gridChrome.visualOverflow).toBe("hidden");
  expect(gridChrome.actionBackground).toBe("rgb(255, 255, 255)");
  expect(gridChrome.actionBorderStyle).toBe("solid");
  expect(gridChrome.actionShadow).not.toBe("none");
  await expect(page.getByRole("button", { name: "Actions for Acme" })).toBeVisible();
  await page.getByRole("button", { name: "Actions for Acme" }).click();
  const actionTrigger = page.getByRole("button", { name: "Actions for Acme" });
  const menu = page.getByRole("menu", { name: "Actions for Acme" });
  await expect(page.getByRole("menuitem", { name: "Share" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  const layout = await menu.evaluate(element => {
    const bounds = element.getBoundingClientRect(); const items = [...element.querySelectorAll("button")].map(item => item.getBoundingClientRect());
    return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, overlaps: items.some((item, index) => items.slice(index + 1).some(other => item.bottom > other.top && other.bottom > item.top)) };
  });
  expect(layout.left).toBeGreaterThanOrEqual(0); expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.top).toBeGreaterThanOrEqual(0); expect(layout.bottom).toBeLessThanOrEqual(layout.viewportHeight); expect(layout.overlaps).toBe(false);
  await expect(page.getByRole("menuitem", { name: "Share" })).toBeFocused();
  await page.keyboard.press("ArrowDown"); await expect(page.getByRole("menuitem", { name: "Rename" })).toBeFocused();
  await page.keyboard.press("Escape"); await expect(menu).toHaveCount(0); await expect(actionTrigger).toBeFocused();
  await actionTrigger.click(); await search.click(); await expect(menu).toHaveCount(0);
  await actionTrigger.click();
  await page.evaluate(() => document.dispatchEvent(new Event("scroll")));
  await expect(menu).toHaveCount(0);
  await page.getByRole("button", { name: "Open Acme" }).click();
  await expect(page).toHaveURL(/\/delivery\/Acme$/);
  await expect(search).toHaveValue("");
  await expect(page.getByRole("button", { name: "Open arrival.jpg" })).toBeVisible();
  await page.getByRole("button", { name: "List" }).click();
  const row = page.locator(".delivery-list-item").filter({ hasText: "arrival.jpg" });
  const rowOpen = row.locator(".delivery-list-open");
  expect((await rowOpen.boundingBox())!.width).toBeGreaterThan((await row.getByRole("button", { name: "Actions for arrival.jpg" }).boundingBox())!.width * 4);
  await row.getByRole("button", { name: "Actions for arrival.jpg" }).click();
  const listMenu = page.getByRole("menu", { name: "Actions for arrival.jpg" });
  await expect(listMenu).toBeVisible();
  const listMenuBounds = await listMenu.boundingBox();
  expect(listMenuBounds!.x).toBeGreaterThanOrEqual(0);
  expect(listMenuBounds!.x + listMenuBounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.keyboard.press("Escape");
  await expect(listMenu).toHaveCount(0);
});

test("permission-gated current-folder sharing uses the normalized active folder and separates workspace access", async ({ page }) => {
  let activePrefix = "", activeItemRef: string | null = "unexpected", authenticatedFolderRef = "";
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: {
      id: "staff-current-folder-share", email: "staff@example.test", displayName: "Folder Share Staff",
      status: "Active", profileType: "Administrator", isAdministrator: true,
      permissions: ["delivery.browse", "delivery.share.create", "delivery.share.revoke"], divisions: [],
    }, csrfToken: "csrf-current-folder-share", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null,
      capabilities: { deliveryJobsRoot: { enabled: true }, authenticatedDeliveryGrants: { enabled: true, creationEnabled: true } } } });
    if (url.pathname === "/api/delivery/folders") return route.fulfill({ json: { prefix: url.searchParams.get("prefix"), folders: [], files: [], nextCursor: null } });
    if (url.pathname === "/api/delivery/folders/locations") return route.fulfill({ json: { points: [], imageCount: 0, truncated: false } });
    if (url.pathname === "/api/delivery/shares/active") {
      activePrefix = url.searchParams.get("prefix") || ""; activeItemRef = url.searchParams.get("itemRef");
      return route.fulfill({ json: { share: null } });
    }
    if (url.pathname === "/api/delivery/authenticated-grants") {
      authenticatedFolderRef = url.searchParams.get("folderRef") || "";
      return route.fulfill({ status: 404, json: { error: "No linked workspace" } });
    }
    if (url.pathname === "/api/delivery/shares") return route.fulfill({ json: { shares: [] } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/delivery/DC%20Construction");
  const shareTrigger = page.getByRole("button", { name: "Share current folder" });
  await shareTrigger.click();
  const dialog = page.getByRole("dialog", { name: "Share folder" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  const publicTab = page.getByRole("tab", { name: "Public link" });
  const workspaceTab = page.getByRole("tab", { name: "Client Workspace" });
  await expect(publicTab).toHaveAttribute("aria-selected", "true");
  await expect(publicTab).toHaveAttribute("aria-controls", "share-mode-panel-public");
  await expect(publicTab).toHaveAttribute("tabindex", "0");
  await expect(workspaceTab).toHaveAttribute("aria-controls", "share-mode-panel-workspace");
  await expect(workspaceTab).toHaveAttribute("tabindex", "-1");
  await expect(page.getByRole("tabpanel", { name: "Public link" })).toHaveAttribute("id", "share-mode-panel-public");
  await expect(page.getByRole("button", { name: "Create link" })).toBeVisible();
  const layout = await dialog.evaluate(element => {
    const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { top: bounds.top, bottom: bounds.bottom, viewportHeight: innerHeight,
      overflowY: style.overflowY, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight };
  });
  expect(layout.top).toBeGreaterThanOrEqual(0);
  expect(layout.bottom).toBeLessThanOrEqual(layout.viewportHeight);
  expect(layout.overflowY).toBe("auto");
  expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
  expect(activePrefix).toBe("Jobs/Clients/DC Construction/");
  expect(activeItemRef).toBeNull();
  expect(authenticatedFolderRef).toBe("");

  await publicTab.focus();
  await publicTab.press("ArrowRight");
  await expect(workspaceTab).toBeFocused();
  await expect(workspaceTab).toHaveAttribute("aria-selected", "true");
  await expect(workspaceTab).toHaveAttribute("tabindex", "0");
  await expect(publicTab).toHaveAttribute("tabindex", "-1");
  await expect(page.getByRole("tabpanel", { name: "Client Workspace" })).toHaveAttribute("id", "share-mode-panel-workspace");
  await expect(page.getByRole("tabpanel", { name: "Public link" })).toHaveCount(0);
  await workspaceTab.press("Home");
  await expect(publicTab).toBeFocused();
  await expect(page.getByRole("tabpanel", { name: "Public link" })).toBeVisible();
  await publicTab.press("End");
  await expect(workspaceTab).toBeFocused();
  await expect(page.getByRole("tabpanel", { name: "Client Workspace" })).toBeVisible();
  await workspaceTab.press("ArrowLeft");
  await expect(publicTab).toBeFocused();
  await publicTab.press("ArrowRight");
  await expect(workspaceTab).toBeFocused();
  await expect(page.getByRole("alert").filter({ hasText: "not linked to a Client Portal workspace" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Client Hub portal setup" })).toHaveAttribute("href", "/clients#client-portal-setup");
  expect(authenticatedFolderRef).toBe(Buffer.from("Jobs/Clients/DC Construction").toString("base64url"));
  await expect(page.getByRole("button", { name: "Create link" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(shareTrigger).toBeFocused();
});

test("Share dialog replaces a failed lookup with an explicit retry state", async ({ page }) => {
  let activeRequests = 0; let shareWrites = 0;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: "staff-share", email: "staff-share@example.test", displayName: "Share Staff", status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["delivery.browse", "delivery.share.create"], divisions: [] }, csrfToken: "csrf-share", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: { deliveryJobsRoot: { enabled: true } } } });
    if (url.pathname === "/api/delivery/folders") {
      const prefix = url.searchParams.get("prefix") || "Jobs/Clients/";
      return route.fulfill({ json: { prefix, folders: [{ id: "folder-acme", prefix: "Jobs/Clients/Acme/", physicalKey: "Jobs/Clients/Acme/", name: "Acme", displayName: "Acme", kind: "folder" }], files: [], nextCursor: null } });
    }
    if (url.pathname === "/api/delivery/folders/locations") return route.fulfill({ json: { points: [], imageCount: 0, truncated: false } });
    if (url.pathname === "/api/delivery/shares/active") {
      activeRequests += 1;
      return activeRequests === 1
        ? route.fulfill({ status: 503, json: { error: "Share lookup temporarily unavailable" } })
        : route.fulfill({ json: { share: null } });
    }
    if (url.pathname === "/api/delivery/shares") {
      if (route.request().method() !== "GET") shareWrites += 1;
      return route.fulfill({ json: { shares: [] } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/delivery");
  await page.getByRole("button", { name: "Actions for Acme" }).click();
  await page.getByRole("menuitem", { name: "Share" }).click();
  await expect(page.getByRole("alert")).toContainText("Share status unavailable");
  await expect(page.getByRole("alert")).toContainText("No link was created or changed");
  await expect(page.getByRole("button", { name: "Create link" })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("button", { name: "Create link" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Show photo locations on this client share/ })).toBeChecked();
  expect(activeRequests).toBe(2); expect(shareWrites).toBe(0);
});

test("Share dialog preserves the stored map setting for an existing share", async ({ page }) => {
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: "staff-existing-share", email: "staff-existing-share@example.test", displayName: "Existing Share Staff", status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["delivery.browse", "delivery.share.create", "delivery.share.revoke"], divisions: [] }, csrfToken: "csrf-existing-share", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: { deliveryJobsRoot: { enabled: true } } } });
    if (url.pathname === "/api/delivery/folders") {
      const prefix = url.searchParams.get("prefix") || "Jobs/Clients/";
      return route.fulfill({ json: { prefix, folders: [{ id: "folder-existing", prefix: "Jobs/Clients/Existing/", physicalKey: "Jobs/Clients/Existing/", name: "Existing", displayName: "Existing", kind: "folder", isShared: true }], files: [], nextCursor: null } });
    }
    if (url.pathname === "/api/delivery/folders/locations") return route.fulfill({ json: { points: [], imageCount: 0, truncated: false } });
    if (url.pathname === "/api/delivery/shares/active") return route.fulfill({ json: { share: { id: "share-existing", shareUrl: "https://client.example.test/d/existing", passwordProtected: false, expiresAt: null, recoverable: true, recipientEmail: null, imageLocationMapEnabled: false } } });
    if (url.pathname === "/api/delivery/shares") return route.fulfill({ json: { shares: [] } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/delivery");
  await page.getByRole("button", { name: "Actions for Existing" }).click();
  await page.getByRole("menuitem", { name: "Share" }).click();
  await expect(page.getByText("Already shared", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Show photo locations on this client share/ })).not.toBeChecked();
  await expect(page.getByText(/On by default for a new share/)).toBeVisible();
});

test("Share dialog selects a scoped directory recipient without presenting it as link authorization", async ({ page }) => {
  let posted: Record<string, unknown> | null = null;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: "staff-directory-share", email: "staff@example.test", displayName: "Share Staff", status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["delivery.browse", "delivery.share.create"], divisions: [] }, csrfToken: "csrf-share", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: { deliveryJobsRoot: { enabled: true }, shareDirectoryRecipients: { enabled: true } } } });
    if (url.pathname === "/api/delivery/folders") {
      const prefix = url.searchParams.get("prefix") || "Jobs/Clients/";
      return route.fulfill({ json: { prefix, folders: [{ id: "folder-acme", prefix: "Jobs/Clients/Acme/", physicalKey: "Jobs/Clients/Acme/", name: "Acme", displayName: "Acme", kind: "folder" }], files: [], nextCursor: null } });
    }
    if (url.pathname === "/api/delivery/folders/locations") return route.fulfill({ json: { points: [], imageCount: 0, truncated: false } });
    if (url.pathname === "/api/delivery/shares/active") return route.fulfill({ json: { share: null } });
    if (url.pathname === "/api/delivery/share-recipients") return route.fulfill({ json: { audiences: [{ audienceType: "principal", publicId: "pa-principal-acme", displayName: "Acme Project Lead", email: "lead@acme.example", recipientCount: 1 }] } });
    if (url.pathname === "/api/delivery/shares" && route.request().method() === "POST") {
      posted = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: { share: { id: "share-new", shareUrl: "https://client.example.test/s/new#secret", accessCode: null, passwordProtected: false, expiresAt: null, lifecycle: "created", idempotentReplay: false } } });
    }
    if (url.pathname === "/api/delivery/shares") return route.fulfill({ json: { shares: [] } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/delivery");
  await page.getByRole("button", { name: "Actions for Acme" }).click();
  await page.getByRole("menuitem", { name: "Share" }).click();
  const recipient = page.getByRole("combobox", { name: "Notification only (does not control access)" });
  await recipient.fill("Acme");
  const recipientOption = page.getByRole("option", { name: /Acme Project Lead/ });
  await expect(recipientOption).toBeVisible();
  await recipient.press("ArrowDown");
  await expect(recipientOption).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Share folder" })).toBeVisible();
  await expect(recipient).toBeFocused();
  await expect(recipient).toHaveValue("Acme");
  await recipient.press("ArrowDown");
  await expect(recipientOption).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(recipient).toHaveValue("Acme Project Lead (lead@acme.example)");
  await expect(recipientOption).toHaveCount(0);
  await expect(page.getByText(/does not grant Client Workspace access or restrict who can use the complete bearer link/)).toBeVisible();
  await page.getByRole("button", { name: "Create link" }).click();
  await expect.poll(() => posted).not.toBeNull();
  expect(posted).toMatchObject({ r2Prefix: "Jobs/Clients/Acme/", recipientAudience: { type: "principal", publicId: "pa-principal-acme" } });
  expect(posted).not.toHaveProperty("recipientEmail");
});

test("an individual video card creates and revokes an exact-file share",async({page})=>{
  let posted:Record<string,unknown>|null=null,deleted="";
  await page.route("**/api/**",async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.pathname==="/api/session")return route.fulfill({json:{user:{id:"staff-file-share",email:"staff@example.test",displayName:"File Share Staff",status:"Active",profileType:"Administrator",isAdministrator:true,permissions:["delivery.browse","delivery.share.create","delivery.share.revoke"],divisions:[]},csrfToken:"csrf-file-share",timezone:"America/Chicago",mapStyleUrl:null,mapboxPublicToken:null,capabilities:{deliveryJobsRoot:{enabled:true}}}});
    if(url.pathname==="/api/delivery/folders")return route.fulfill({json:{prefix:"Jobs/Clients/",folders:[],files:[{id:"opaque-video-2",physicalKey:"Jobs/Clients/Video 2.mov",name:"Video 2.mov",displayName:"Video 2.mov",kind:"video",size:65011712,sourceUrl:"/api/delivery/items/opaque-video-2/source",downloadUrl:"/api/delivery/items/opaque-video-2/download"}],nextCursor:null}});
    if(url.pathname==="/api/delivery/folders/media")return route.fulfill({json:{items:[]}});
    if(url.pathname==="/api/delivery/folders/locations")return route.fulfill({json:{points:[],imageCount:0,truncated:false}});
    if(url.pathname==="/api/delivery/shares/active"){
      expect(url.searchParams.get("prefix")).toBe("Jobs/Clients/");
      expect(url.searchParams.get("itemRef")).toBe("opaque-video-2");
      return route.fulfill({json:{share:null}});
    }
    if(url.pathname==="/api/delivery/shares"&&request.method()==="POST"){
      posted=request.postDataJSON();
      return route.fulfill({status:201,json:{share:{id:"share-video-2",shareUrl:"https://client.example.test/s/video-2#secret",accessCode:null,passwordProtected:false,expiresAt:null,lifecycle:"created",idempotentReplay:false}}});
    }
    if(url.pathname==="/api/delivery/shares/share-video-2"&&request.method()==="DELETE"){
      deleted=url.pathname;return route.fulfill({status:204,body:""});
    }
    if(url.pathname==="/api/delivery/shares")return route.fulfill({json:{shares:[]}});
    return route.fulfill({status:404,json:{error:"Not found"}});
  });
  await page.goto("/delivery");
  await page.getByRole("button",{name:"Actions for Video 2.mov"}).click();
  await page.getByRole("menuitem",{name:"Share"}).click();
  await expect(page.getByText("Share file",{exact:true})).toBeVisible();
  await expect(page.getByRole("code").filter({hasText:"Video 2.mov"})).toBeVisible();
  await expect(page.getByRole("checkbox",{name:/Show photo locations/})).toHaveCount(0);
  await page.getByRole("button",{name:"Create link"}).click();
  await expect.poll(()=>posted).not.toBeNull();
  expect(posted).toMatchObject({r2Prefix:"Jobs/Clients/",itemRef:"opaque-video-2",imageLocationMapEnabled:false});
  await expect(page.getByRole("button",{name:"Copy link"})).toBeVisible();
  page.once("dialog",dialog=>dialog.accept());
  await page.getByRole("button",{name:"Unshare file"}).click();
  await expect.poll(()=>deleted).toBe("/api/delivery/shares/share-video-2");
});
