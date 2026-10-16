import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceSummaryView, formatAmount, type AdminFinanceSummary, type FinanceMoneyBucket } from "../src/client/FinanceSummaryPanel";

const bucket = (overrides: Partial<FinanceMoneyBucket> = {}): FinanceMoneyBucket => ({
  currency: "USD", decimalScale: 2,
  payments: { count: 3, received: "12050.00", adjustedNetIncome: "11890.40", processorFeeQuality: { actual: 2, estimated: 1, unknown: 0 } },
  expenses: { count: null, total: null, pending: null, confirmed: null, reimbursed: null },
  recordedOperatingResult: null,
  receivables: { count: 4, outstanding: "31400.00", overdue: "6900.00" },
  ...overrides,
});
const coverage = { complete: true, currencyPolicy: "linked-document-currency-only" as const, baseCurrency: null, unknownPaymentCurrencyCount: 0, unknownReceivableCurrencyCount: 2, unallocatedProjectPaymentCount: 0,
  expenseCurrencyKnown: false, processorFeeEstimateCount: 1, recordedExpenseCounts: { total: 2, pending: 1, confirmed: 1, reimbursed: 0, other: 0 } };
const period = { from: "2026-10-01", to: "2026-10-31", dateBasis: "stored-calendar-date" as const };

describe("finance summary panel", () => {
  beforeEach(() => vi.stubGlobal("React", React));
  afterEach(() => vi.unstubAllGlobals());

  it("formats exact decimal strings without floating point", () => {
    expect(formatAmount("1234567890123.45", "USD")).toBe("$1,234,567,890,123.45");
    expect(formatAmount("-0.5", "USD")).toBe("-$0.50");
    expect(formatAmount("12", "USD")).toBe("$12.00");
    expect(formatAmount(null, "USD")).toBe("—");
    expect(formatAmount("1e5", "USD")).toBe("—");
  });

  it("names companies, never shows missing sources as zero, and explains unconfigured expenses", () => {
    const summary: AdminFinanceSummary = {
      asOf: "2026-10-16T12:02:00.000Z", period, complete: false,
      combined: { currencies: [bucket()], coverageComplete: false },
      sources: [
        { sourceId: "project-alpha:primary", label: "x", status: "ok", summary: { apiVersion: "2", sourceInstanceId: "src-1", applicationId: "app-1",
          historyEpoch: "epoch-1", requestId: "req-1", asOf: "2026-10-16T12:02:00.000Z", period, snapshotSha256: "f".repeat(64), scope: "company",
          accountingBasis: "payment-date-current-adjustments-and-recorded-expense-date", coverage, currencies: [bucket()] } },
        { sourceId: "project-alpha:secondary", label: "x", status: "unavailable", summary: null },
      ],
    };
    const html = renderToStaticMarkup(createElement(FinanceSummaryView, { summary }));
    expect(html).toContain("Ledge Top Drone Services");
    expect(html).toContain("Ledge Top Technologies");
    expect(html).toContain("Nothing is counted for it.");
    expect(html).toContain("Combined (partial)");
    expect(html).toContain("Expense currency isn&#x27;t configured in Project Alpha.");
    expect(html).toContain("$6,900.00");
    expect(html).toContain("2 open invoices have no currency");
    // Internal identities, hashes and request IDs never reach the screen.
    expect(html).not.toMatch(/project-alpha:|\$0\.00|src-1|app-1|req-1|epoch-1|f{64}/);
  });

  it("explains an upstream authorization refusal as a connection setup issue, not the viewer's access", () => {
    const summary: AdminFinanceSummary = {
      asOf: "2026-10-16T12:02:00.000Z", period, complete: false, combined: null,
      sources: [
        { sourceId: "project-alpha:primary", label: "x", status: "forbidden", summary: null },
        { sourceId: "project-alpha:secondary", label: "x", status: "forbidden", summary: null },
      ],
    };
    const html = renderToStaticMarkup(createElement(FinanceSummaryView, { summary }));
    expect(html).toContain("Connection not authorized");
    expect(html).toContain("Project Alpha connection isn&#x27;t authorized to share finance totals");
    expect(html).toContain("grant the connection finance summary access");
    expect(html).not.toMatch(/You don&#x27;t have|No access/);
  });
});
