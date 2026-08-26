import { expect, test, type Page } from "@playwright/test";

const root = "Jobs/Clients/Acme/";
const edited = `${root}Edited/`;
const originals = `${root}Originals/`;
const files = Array.from({ length: 40 }, (_, index) => ({
  id: `file-${index}`, name: `Report ${index + 1}.txt`, kind: "document", size: 1024,
  physicalKey: `${root}Report ${index + 1}.txt`,
}));
const folders = [
  { id: "edited", name: "Edited", prefix: edited, itemCount: 900, fileCount: 800, files: [{ id: "nested-photo" }] },
  { id: "originals", name: "Originals", prefix: originals, itemCount: 300 },
];

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(({ page }) => {
  expect(pageErrors.get(page) || [], "No uncaught browser errors").toEqual([]);
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function fixture(page: Page, options: {
  paged?: boolean;
  secondPage?: Promise<void>;
  slowSearch?: Promise<void>;
  refresh?: Promise<void>;
  failRefresh?: boolean;
  reconciling?: boolean;
} = {}) {
  const folderRequests: string[] = [];
  const sharePrefixes: string[] = [];
  const searchQueries: string[] = [];
  let rootReads = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    expect(route.request().method()).toBe("GET");
    if (url.pathname === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-count", email: "staff@example.test", displayName: "Delivery Staff", status: "Active", profileType: "Administrator", isAdministrator: true,
        permissions: ["delivery.browse", "delivery.share.audit"], divisions: [] },
      csrfToken: "fixture-count", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null,
      capabilities: { deliveryJobsRoot: { enabled: true } },
    } });
    if (url.pathname === "/api/delivery/access-revision") return route.fulfill({ json: { revision: `dbr_${"a".repeat(43)}` } });
    if (url.pathname === "/api/delivery/folders") {
      const prefix = url.searchParams.get("prefix") || "";
      folderRequests.push(prefix);
      if (prefix === edited) return route.fulfill({ json: { prefix, folders: [], files: files.slice(0, 2), nextCursor: null, mediaHydrated: true } });
      if (prefix === originals) return route.fulfill({ json: { prefix, folders: [], files: [], nextCursor: null, mediaHydrated: true } });
      if (url.searchParams.has("cursor")) {
        if (options.secondPage) await options.secondPage;
        return route.fulfill({ json: { prefix, folders: [folders[0], folders[1]], files: files.slice(1, 4), nextCursor: null, mediaHydrated: true } }).catch(() => {});
      }
      rootReads += 1;
      if (rootReads > 1 && options.refresh) await options.refresh;
      if (rootReads > 1 && options.failRefresh) return route.fulfill({ status: 503, json: { error: "Folder listing temporarily unavailable" } });
      return route.fulfill({ json: {
        prefix, folders: options.paged ? folders.slice(0, 1) : folders, files: options.paged ? files.slice(0, 2) : files,
        nextCursor: options.paged ? "page-2" : null, mediaHydrated: true, reconciliationNeeded: options.reconciling === true,
      } });
    }
    if (url.pathname === "/api/delivery/search") {
      const query = url.searchParams.get("q");
      searchQueries.push(query || "");
      if (query === "slow" && options.slowSearch) await options.slowSearch;
      if (query === "error") return route.fulfill({ status: 503, json: { error: "Search temporarily unavailable" } });
      return route.fulfill({ json: {
        items: query === "missing" ? [] : query === "slow" ? [files[0]] : [folders[0], files[0]],
        nextCursor: query === "partial" ? "more-search-results" : null,
      } }).catch(() => {});
    }
    if (url.pathname === "/api/delivery/folders/locations") return route.fulfill({ json: { points: [], imageCount: 1200, truncated: false } });
    if (url.pathname === "/api/delivery/trash") return route.fulfill({ json: { items: [] } });
    if (url.pathname === "/api/delivery/thumbnail-queue") return route.fulfill({ json: { pending: 0, processing: 0, total: 0 } });
    if (url.pathname === "/api/delivery/shares") {
      const prefix = url.searchParams.get("prefix") || "";
      sharePrefixes.push(prefix);
      return route.fulfill({ json: { shares: [], nextCursor: null } });
    }
    return route.fulfill({ status: 404, json: { error: "No fixture endpoint" } });
  });
  return { folderRequests, sharePrefixes, searchQueries };
}

test("folder count includes direct folders and files, not nested metadata or map images", async ({ page }, testInfo) => {
  const requests = await fixture(page);
  await page.goto("/delivery/Acme");
  const count = page.getByRole("status", { name: "Current view item count" });
  await expect(count).toHaveText("42 items · 2 folders · 40 files");
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(count).toHaveText("42 items · 2 folders · 40 files");
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await expect(count).toHaveText("42 items · 2 folders · 40 files");
  await expect(page.getByRole("link", { name: "View folder links" })).toHaveAttribute("href", `/delivery/links?${new URLSearchParams({ prefix: root })}`);
  expect(requests.folderRequests).toEqual([root]);
  expect(requests.sharePrefixes).toEqual([root]);
  await count.scrollIntoViewIfNeeded();
  const box = await count.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await page.screenshot({ path: testInfo.outputPath("current-folder-item-count.png") });

  await page.getByRole("button", { name: "Open Edited", exact: true }).click();
  await expect(count).toHaveText("2 items · 0 folders · 2 files");
  await page.reload();
  await expect(count).toHaveText("2 items · 0 folders · 2 files");
  await page.goBack();
  await expect(count).toHaveText("42 items · 2 folders · 40 files");
  await page.getByRole("button", { name: "Open Originals", exact: true }).click();
  await expect(count).toHaveText("0 items · 0 folders · 0 files");
  await expect(page.getByText("This folder is empty", { exact: true })).toBeVisible();
});

test("incomplete pages say loaded and count deduplicated direct children when more arrive", async ({ page }) => {
  const next = deferred();
  await fixture(page, { paged: true, secondPage: next.promise });
  try {
    await page.goto("/delivery/Acme");
    const count = page.getByRole("status", { name: "Current view item count" });
    await expect(count).toHaveText("3 items loaded · 1 folder · 2 files");
    await page.locator(".delivery-pagination").scrollIntoViewIfNeeded();
    next.release();
    await expect(count).toHaveText("6 items · 2 folders · 4 files");
    await expect(page.getByRole("button", { name: "Open Edited", exact: true })).toHaveCount(1);
  } finally { next.release(); }
});

test("search counts only matching loaded entries and never advertises a stale query count", async ({ page }) => {
  const slow = deferred();
  const requests = await fixture(page, { slowSearch: slow.promise });
  try {
    await page.goto("/delivery/Acme");
    const count = page.getByRole("status", { name: "Current view item count" });
    const search = page.getByRole("textbox", { name: "Search", exact: true });
    await expect(count).toHaveText("42 items · 2 folders · 40 files");
    await search.fill("Edited");
    await expect(count).toHaveText("2 matching items · 1 folder · 1 file");
    await search.fill("partial");
    await expect(count).toHaveText("2 matching items loaded · 1 folder · 1 file");
    await search.fill("slow");
    await expect(count).toHaveText("Updating search results…");
    await expect.poll(() => requests.searchQueries.includes("slow")).toBe(true);
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(count).toHaveText("42 items · 2 folders · 40 files");
    slow.release();
    await expect(count).toHaveText("42 items · 2 folders · 40 files");
    await search.fill("missing");
    await expect(count).toHaveText("0 matching items · 0 folders · 0 files");
    await search.fill("error");
    await expect(count).toHaveText("Item count unavailable. Reload this view to try again.");
  } finally { slow.release(); }
});

test("refreshing and failed listings do not present the cached count as current", async ({ page }) => {
  const refresh = deferred();
  await fixture(page, { refresh: refresh.promise, failRefresh: true });
  try {
    await page.goto("/delivery/Acme");
    const count = page.getByRole("status", { name: "Current view item count" });
    await expect(count).toHaveText("42 items · 2 folders · 40 files");
    await page.locator(".delivery-toolbar").getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(count).toHaveText("Loading folder items…");
    refresh.release();
    await expect(count).toHaveText("Item count unavailable. Reload this view to try again.");
    await expect(count).not.toContainText("42");
  } finally { refresh.release(); }
});

test("a folder still being indexed does not claim its loaded entries are the final total", async ({ page }) => {
  await fixture(page, { reconciling: true });
  await page.goto("/delivery/Acme");
  await expect(page.getByRole("status", { name: "Current view item count" })).toHaveText("42 items loaded · 2 folders · 40 files");
  await expect(page.getByText("Some newly synced folders are still being indexed.")).toBeVisible();
});
