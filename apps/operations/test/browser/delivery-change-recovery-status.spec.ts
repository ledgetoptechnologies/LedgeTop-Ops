import { expect, test } from "@playwright/test";

type Recovery = {
  enabled: boolean; state: "ready" | "attention" | "disabled" | "unavailable";
  reason: "schema_unavailable" | "status_unavailable" | null;
  counts: { pending: number; processing: number; completed: number; failed: number } | null;
  failures: Array<{ reason: "authority-suppressed" | "staging-fence" | "staging-schema" | "staging-invalid" | "staging-failed"; count: number }>;
  oldestPendingAt: string | null; lastFailureAt: string | null;
};

const workflowReadiness = { ready: true, workflows: {
  nativeFeedback: { state: "ready", reasons: [] }, serviceRequests: { state: "ready", reasons: [] },
  requestAttachments: { state: "ready", reasons: [] }, delegatedSharing: { state: "ready", reasons: [] }, expiryNotices: { state: "ready", reasons: [] },
} };
const ready = (): Recovery => ({ enabled: true, state: "ready", reason: null,
  counts: { pending: 2, processing: 1, completed: 7, failed: 0 }, failures: [],
  oldestPendingAt: "2026-09-07T08:00:00.000Z", lastFailureAt: null });

async function fixture(page: import("@playwright/test").Page, recovery: unknown, options: { administrator?: boolean; initialGate?: Promise<void>; refreshGate?: Promise<void> } = {}) {
  let recoveryReads = 0;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: { user: { id: "admin", email: "admin@example.test", displayName: "Admin",
      status: "Active", profileType: options.administrator === false ? "Employee" : "Administrator", isAdministrator: options.administrator !== false,
      permissions: options.administrator === false ? ["administration.view"] : ["administration.view", "integrations.manage"], divisions: [] },
      csrfToken: "csrf", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    if (path === "/api/admin/integrations/project-alpha/connectors") return route.fulfill({ json: { connectors: [], health: [], legacyPrimary: false } });
    if (path === "/api/admin/audit") return route.fulfill({ json: { events: [] } });
    if (path === "/api/admin/portal-workflow-readiness") return route.fulfill({ json: workflowReadiness });
    if (path === "/api/admin/delivery-change-recovery") {
      recoveryReads += 1;
      if (recoveryReads === 1 && options.initialGate) await options.initialGate;
      if (recoveryReads === 2 && options.refreshGate) await options.refreshGate;
      return route.fulfill({ json: recovery });
    }
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  return () => recoveryReads;
}

function recoveryCard(page: import("@playwright/test").Page) {
  return page.getByRole("heading", { name: "Delivery notification recovery", exact: true }).locator("xpath=ancestor::section[1]");
}

test("Administration shows redacted recovery counts and clears stale data while refreshing", async ({ page }) => {
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const reads = await fixture(page, ready(), { refreshGate });
  await page.goto("/administration");
  const card = recoveryCard(page);
  await expect(card).toContainText("Completed means a target was staged or suppressed; it does not mean email was delivered.");
  await expect(card).toContainText("Pending");
  await expect(card.locator("time[datetime='2026-09-07T08:00:00.000Z']")).toBeVisible();
  await card.getByRole("button", { name: "Refresh delivery recovery", exact: true }).click();
  await expect(card.getByText("Refreshing delivery recovery…", { exact: true })).toBeVisible();
  await expect(card.getByText("Pending", { exact: true })).toHaveCount(0);
  releaseRefresh();
  await expect.poll(reads).toBe(2);
  await expect(card.getByText("Pending", { exact: true })).toBeVisible();
});

test("paused recovery keeps aggregate failures visible without mutation controls", async ({ page }, testInfo) => {
  const data: Recovery = { enabled: false, state: "disabled", reason: null, counts: { pending: 4, processing: 0, completed: 11, failed: 3 },
    failures: [{ reason: "staging-fence", count: 2 }, { reason: "authority-suppressed", count: 1 }],
    oldestPendingAt: "2026-09-07T08:00:00.000Z", lastFailureAt: "2026-09-07T09:00:00.000Z" };
  await fixture(page, data);
  await page.goto("/administration");
  const card = recoveryCard(page);
  await expect(card).toContainText("paused");
  await expect(card).toContainText("Recovery is paused; existing jobs remain visible.");
  await expect(card).toContainText("Staging fence: 2");
  await expect(card).toContainText("Authority suppressed: 1");
  await expect(card.getByRole("button", { name: /retry|enable|clear/i })).toHaveCount(0);
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await card.evaluate(element => element.scrollIntoView({ block: "start" }));
    await card.screenshot({ path: testInfo.outputPath(`delivery-change-recovery-paused-${width}.png`) });
  }
});

test("unavailable recovery never renders fabricated zero counts", async ({ page }) => {
  await fixture(page, { enabled: true, state: "unavailable", reason: "status_unavailable", counts: null, failures: [], oldestPendingAt: null, lastFailureAt: null });
  await page.goto("/administration");
  const card = recoveryCard(page);
  await expect(card).toContainText("Recovery status is unavailable.");
  await expect(card.getByText("Pending", { exact: true })).toHaveCount(0);
  await expect(card.getByText("Completed", { exact: true })).toHaveCount(0);
  await expect(card.getByText("0", { exact: true })).toHaveCount(0);
});

test("malformed recovery status is rejected without exposing a partial result", async ({ page }) => {
  await fixture(page, { enabled: true, state: "ready", reason: null, counts: { pending: -1, processing: 0, completed: 0, failed: 0 },
    failures: [], oldestPendingAt: null, lastFailureAt: null });
  await page.goto("/administration");
  const card = recoveryCard(page);
  await expect(card.getByRole("alert")).toHaveText("Delivery recovery status could not be checked.");
  await expect(card.getByText("Pending", { exact: true })).toHaveCount(0);
});

test("non-administrator Administration view does not fetch recovery status", async ({ page }) => {
  const reads = await fixture(page, ready(), { administrator: false });
  await page.goto("/administration");
  await expect(page.getByRole("heading", { name: "Administration", exact: true })).toBeVisible();
  await expect(page.getByText("Delivery notification recovery", { exact: true })).toHaveCount(0);
  expect(reads()).toBe(0);
});

test("contradictory recovery payloads never render reassuring or partial status", async ({ page }) => {
  const invalid = [
    { ...ready(), enabled: false },
    { ...ready(), reason: "status_unavailable" },
    { ...ready(), state: "attention" },
    { ...ready(), oldestPendingAt: null },
    { ...ready(), lastFailureAt: "2026-09-07T09:00:00.000Z" },
    { ...ready(), state: "attention", counts: { pending: 2, processing: 1, completed: 7, failed: 2 },
      lastFailureAt: "2026-09-07T09:00:00.000Z", failures: [{ reason: "staging-failed", count: 1 }] },
    { ...ready(), state: "attention", counts: { pending: 2, processing: 1, completed: 7, failed: 2 },
      lastFailureAt: "2026-09-07T09:00:00.000Z", failures: [{ reason: "staging-failed", count: 1 }, { reason: "staging-failed", count: 1 }] },
  ];
  for (const payload of invalid) {
    await page.unroute("**/api/**");
    await fixture(page, payload);
    await page.goto("/administration");
    const card = recoveryCard(page);
    await expect(card.getByRole("alert")).toHaveText("Delivery recovery status could not be checked.");
    await expect(card.getByText("Pending", { exact: true })).toHaveCount(0);
    await expect(card.getByText("No terminal failures recorded", { exact: true })).toHaveCount(0);
  }
});

test("recovery status loads and refresh control remains keyboard accessible without overflow", async ({ page }) => {
  let releaseInitial!: () => void;
  const initialGate = new Promise<void>(resolve => { releaseInitial = resolve; });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await fixture(page, { ...ready(), state: "attention", counts: { pending: 0, processing: 1, completed: 7, failed: 5 },
    failures: [{ reason: "staging-failed", count: 5 }], oldestPendingAt: "2026-09-07T08:00:00.000Z", lastFailureAt: "2026-09-07T09:00:00.000Z" }, { initialGate });
  await page.goto("/administration");
  const card = recoveryCard(page), refresh = card.getByRole("button", { name: "Refresh delivery recovery", exact: true });
  await expect(card.getByText("Checking delivery recovery…", { exact: true })).toBeVisible();
  releaseInitial();
  await expect(card.getByText("Staging failed: 5", { exact: true })).toBeVisible();
  await expect(card.getByText("Oldest outstanding", { exact: true })).toBeVisible();
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await refresh.focus(); await expect(refresh).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const box = await refresh.boundingBox();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width + 1);
    if (width <= 640) expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  expect(errors).toEqual([]);
});
