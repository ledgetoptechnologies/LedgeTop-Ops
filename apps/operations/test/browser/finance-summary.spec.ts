import { expect, test, type Page } from "@playwright/test";

const period = { from: "2030-01-01", to: "2030-01-30", dateBasis: "stored-calendar-date" };
const bucket = { currency: "USD", decimalScale: 2,
  payments: { count: 1, received: "100.00", adjustedNetIncome: "90.00", processorFeeQuality: { actual: 1, estimated: 0, unknown: 0 } },
  expenses: { count: null, total: null, pending: null, confirmed: null, reimbursed: null }, recordedOperatingResult: null,
  receivables: { count: 0, outstanding: "0.00", overdue: "0.00" } };
const coverage = { complete: true, currencyPolicy: "linked-document-currency-only", baseCurrency: null, unknownPaymentCurrencyCount: 0, unknownReceivableCurrencyCount: 0,
  unallocatedProjectPaymentCount: 0, expenseCurrencyKnown: false, processorFeeEstimateCount: 0, recordedExpenseCounts: { total: 0, pending: 0, confirmed: 0, reimbursed: 0, other: 0 } };
const ok = (sourceId: string) => ({ sourceId, label: "x", status: "ok", summary: { apiVersion: "2", sourceInstanceId: "s", applicationId: "a", historyEpoch: "e", requestId: "r",
  asOf: "2030-01-30T12:00:00.000Z", period, snapshotSha256: "f".repeat(64), scope: "company", accountingBasis: "payment-date-current-adjustments-and-recorded-expense-date", coverage, currencies: [bucket] } });
const down = (sourceId: string) => ({ sourceId, label: "x", status: "unavailable", summary: null });

async function mock(page: Page, answer: (request: number) => { status?: number; json: unknown }) {
  let requests = 0;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-a", email: "staff@example.test", displayName: "Staff User", status: "Active", profileType: "Employee", isAdministrator: true, permissions: ["dashboard.view"], divisions: [] },
      csrfToken: "test", timezone: "America/Chicago", capabilities: { financeSummary: { enabled: true } },
    } });
    if (path === "/api/admin/finance/summary") { requests += 1; return route.fulfill(answer(requests)); }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return () => requests;
}
const refocus = (page: Page) => page.evaluate(() => { window.dispatchEvent(new Event("focus")); });
const summary = (sources: unknown[], complete: boolean) => ({ asOf: "2030-01-30T12:00:00.000Z", period, sources, complete,
  combined: { currencies: [bucket], coverageComplete: complete } });

test("the card shows its dates, names a missing company, and recovers when the page regains focus", async ({ page }) => {
  await page.clock.install({ time: new Date("2030-01-30T12:00:00Z") });
  const requests = await mock(page, request => ({ json: request === 1
    ? summary([ok("project-alpha:primary"), down("project-alpha:secondary")], false)
    : summary([ok("project-alpha:primary"), ok("project-alpha:secondary")], true) }));
  await page.goto("/");
  const card = page.locator(".finance-panel");
  await expect(card.locator(".finance-asof")).toContainText("Jan 1 – Jan 30, 2030");
  await expect(card.getByRole("status")).toContainText("Totals leave out Ledge Top Technologies");
  await refocus(page);
  await page.waitForTimeout(100);
  expect(requests(), "a quick return doesn't reload").toBe(1);
  await page.clock.fastForward(60_001);
  await refocus(page);
  await expect(card.getByRole("status")).toHaveCount(0);
  await expect(card.getByText("Combined (partial)")).toHaveCount(0);
  expect(requests()).toBe(2);
});

test("a failed background refresh keeps the figures on screen", async ({ page }) => {
  await page.clock.install({ time: new Date("2030-01-30T12:00:00Z") });
  const requests = await mock(page, request => request === 1
    ? { json: summary([ok("project-alpha:primary")], true) } : { status: 503, json: { error: "Unavailable" } });
  await page.goto("/");
  const card = page.locator(".finance-panel");
  await expect(card.getByText("$90.00").first()).toBeVisible();
  await page.clock.fastForward(60_001);
  await refocus(page);
  await expect.poll(requests).toBe(2);
  await expect(card.getByText("$90.00").first()).toBeVisible();
  await expect(card.getByRole("alert")).toHaveCount(0);
});
