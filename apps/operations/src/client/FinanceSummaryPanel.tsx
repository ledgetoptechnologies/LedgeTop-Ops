import { useEffect, useState } from "react";
import { Card, Skeleton, StatusPill } from "@ltds/ui";
import { projectAlphaSourceName } from "@ltds/shared";
import { api, ApiError } from "./api";

// Mirrors packages/shared/src/admin-finance-summary.ts on Codex's
// codex/admin-finance-summary-20261016 branch. Replace with that import once it
// is exported from @ltds/shared.
type FinanceAmount = string;
type FinancePeriod = Readonly<{ from: string; to: string; dateBasis: "stored-calendar-date" }>;
export type FinanceMoneyBucket = Readonly<{
  currency: string;
  decimalScale: 2;
  payments: Readonly<{ count: number; received: FinanceAmount | null; adjustedNetIncome: FinanceAmount | null;
    processorFeeQuality: Readonly<{ actual: number; estimated: number; unknown: number }> }>;
  expenses: Readonly<{ count: number | null; total: FinanceAmount | null; pending: FinanceAmount | null;
    confirmed: FinanceAmount | null; reimbursed: FinanceAmount | null }>;
  recordedOperatingResult: FinanceAmount | null;
  receivables: Readonly<{ count: number; outstanding: FinanceAmount; overdue: FinanceAmount }>;
}>;
type CompanyCoverage = Readonly<{
  complete: boolean; baseCurrency: string | null; unknownPaymentCurrencyCount: number; unknownReceivableCurrencyCount: number;
  unallocatedProjectPaymentCount: number; expenseCurrencyKnown: boolean; processorFeeEstimateCount: number;
  recordedExpenseCounts: Readonly<{ total: number; pending: number; confirmed: number; reimbursed: number; other: number }>;
}>;
type CompanyFinanceSummary = Readonly<{ asOf: string; period: FinancePeriod; coverage: CompanyCoverage;
  currencies: readonly FinanceMoneyBucket[] }>;
type FinanceSourceSummary = Readonly<{ sourceId: string; label: string;
  status: "ok" | "unavailable" | "incompatible" | "forbidden"; summary: CompanyFinanceSummary | null }>;
export type AdminFinanceSummary = Readonly<{ asOf: string; period: FinancePeriod; complete: boolean;
  sources: readonly FinanceSourceSummary[];
  combined: Readonly<{ currencies: readonly FinanceMoneyBucket[]; coverageComplete: boolean }> | null }>;

const DECIMAL = /^-?\d+(\.\d{1,2})?$/;

/** Formats an exact decimal string without converting it through Number. */
export function formatAmount(amount: FinanceAmount | null, currency: string): string {
  if (amount === null || !DECIMAL.test(amount)) return "—";
  const negative = amount.startsWith("-"), [whole = "0", fraction = ""] = amount.replace("-", "").split(".");
  const grouped = whole.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let symbol = `${currency} `;
  try {
    symbol = new Intl.NumberFormat("en-US", { style: "currency", currency }).formatToParts(0)
      .find(part => part.type === "currency")?.value ?? symbol;
  } catch { /* unknown currency code: keep the code as prefix */ }
  return `${negative ? "-" : ""}${symbol}${grouped}.${fraction.padEnd(2, "0")}`;
}

export function periodLabel(period: FinancePeriod): string {
  const from = new Date(`${period.from}T12:00:00`);
  return Number.isNaN(from.getTime()) ? `${period.from} to ${period.to}`
    : from.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

const STATUS_COPY: Record<Exclude<FinanceSourceSummary["status"], "ok">, string> = {
  unavailable: "Project Alpha did not return figures for this company. Nothing is counted for it.",
  incompatible: "This company's Project Alpha version can't report finances yet. Nothing is counted for it.",
  forbidden: "You don't have finance access for this company.",
};

function usableSummary(value: unknown): value is AdminFinanceSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.asOf === "string" && typeof row.complete === "boolean" && Array.isArray(row.sources)
    && !!row.period && typeof row.period === "object"
    && (row.combined === null || (typeof row.combined === "object" && Array.isArray((row.combined as Record<string, unknown>).currencies)));
}

function Figure({ label, value, tone, hint }: { label: string; value: string; tone?: "danger" | "muted"; hint?: string }) {
  return <div className={`finance-figure${tone ? ` ${tone}` : ""}`}>
    <span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}
  </div>;
}

function CurrencyFigures({ bucket, expenseCurrencyKnown, showUnavailableResult = true }: { bucket: FinanceMoneyBucket; expenseCurrencyKnown: boolean; showUnavailableResult?: boolean }) {
  const c = bucket.currency;
  const overdue = bucket.receivables.overdue !== "0.00" && bucket.receivables.overdue !== "0";
  return <div className="finance-figures">
    <Figure label="Adjusted income" value={formatAmount(bucket.payments.adjustedNetIncome, c)}
      hint={`${bucket.payments.count} payment${bucket.payments.count === 1 ? "" : "s"} · after refunds and fees`} />
    <Figure label="Payments received" value={formatAmount(bucket.payments.received, c)} />
    <Figure label="Outstanding" value={formatAmount(bucket.receivables.outstanding, c)}
      hint={`${bucket.receivables.count} open invoice${bucket.receivables.count === 1 ? "" : "s"}, all time`} />
    <Figure label="Overdue" value={formatAmount(bucket.receivables.overdue, c)} tone={overdue ? "danger" : undefined} hint="All time" />
    {expenseCurrencyKnown && bucket.recordedOperatingResult !== null
      ? <Figure label="Recorded operating result" value={formatAmount(bucket.recordedOperatingResult, c)}
        hint={`Expenses ${formatAmount(bucket.expenses.total, c)}${bucket.expenses.pending ? ` · ${formatAmount(bucket.expenses.pending, c)} pending` : ""}`} />
      : showUnavailableResult && <Figure label="Recorded operating result" value="Not available" tone="muted" hint="Expense currency isn't configured in Project Alpha." />}
  </div>;
}

function coverageWarnings(coverage: CompanyCoverage): string[] {
  const notes: string[] = [];
  if (coverage.unknownPaymentCurrencyCount) notes.push(`${coverage.unknownPaymentCurrencyCount} payment${coverage.unknownPaymentCurrencyCount === 1 ? " has" : "s have"} no currency and ${coverage.unknownPaymentCurrencyCount === 1 ? "isn't" : "aren't"} counted.`);
  if (coverage.unknownReceivableCurrencyCount) notes.push(`${coverage.unknownReceivableCurrencyCount} open invoice${coverage.unknownReceivableCurrencyCount === 1 ? " has" : "s have"} no currency and ${coverage.unknownReceivableCurrencyCount === 1 ? "isn't" : "aren't"} counted.`);
  if (coverage.unallocatedProjectPaymentCount) notes.push(`${coverage.unallocatedProjectPaymentCount} payment${coverage.unallocatedProjectPaymentCount === 1 ? " isn't" : "s aren't"} linked to a project.`);
  if (coverage.processorFeeEstimateCount) notes.push(`${coverage.processorFeeEstimateCount} processor fee${coverage.processorFeeEstimateCount === 1 ? " is" : "s are"} estimated.`);
  if (!coverage.expenseCurrencyKnown) notes.push("Expense totals are hidden until an expense currency is configured.");
  return notes;
}

function SourceCard({ source }: { source: FinanceSourceSummary }) {
  const name = projectAlphaSourceName(source.sourceId);
  if (source.status !== "ok" || !source.summary) return <section className="finance-source unavailable" aria-label={name}>
    <header><h3>{name}</h3><StatusPill tone={source.status === "forbidden" ? "neutral" : "warning"}>
      {source.status === "forbidden" ? "No access" : source.status === "incompatible" ? "Not supported" : "Unavailable"}</StatusPill></header>
    <p>{STATUS_COPY[source.status === "ok" ? "unavailable" : source.status]}</p>
  </section>;
  const { coverage, currencies } = source.summary, notes = coverageWarnings(coverage);
  const expenses = coverage.recordedExpenseCounts;
  return <section className="finance-source" aria-label={name}>
    <header><h3>{name}</h3><StatusPill tone={coverage.complete ? "success" : "warning"}>{coverage.complete ? "Complete" : "Partial"}</StatusPill></header>
    {currencies.length ? currencies.map(bucket => <div key={bucket.currency} className="finance-currency">
      {currencies.length > 1 && <span className="finance-currency-code">{bucket.currency}</span>}
      <CurrencyFigures bucket={bucket} expenseCurrencyKnown={coverage.expenseCurrencyKnown} showUnavailableResult={false} />
    </div>) : <p className="finance-empty">No payments or open invoices this period.</p>}
    {expenses.total > 0 && <p className="finance-meta">{expenses.total} expense{expenses.total === 1 ? "" : "s"} recorded · {expenses.pending} pending · {expenses.confirmed} confirmed · {expenses.reimbursed} reimbursed</p>}
    {notes.length > 0 && <ul className="finance-notes">{notes.map(note => <li key={note}>{note}</li>)}</ul>}
  </section>;
}

export function FinanceSummaryView({ summary }: { summary: AdminFinanceSummary }) {
  const asOf = new Date(summary.asOf), expenseKnown = summary.sources.every(source => source.summary?.coverage.expenseCurrencyKnown ?? true);
  return <Card className="finance-panel" title="Finances at a glance"
    action={<span className="finance-asof">{periodLabel(summary.period)}{Number.isNaN(asOf.getTime()) ? "" : ` · as of ${asOf.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`}</span>}>
    {!summary.complete && <p className="notice warning" role="status">Some figures are incomplete. Totals only include the companies and records shown below.</p>}
    {summary.combined && summary.combined.currencies.length > 0 && <section className="finance-combined" aria-label="Combined">
      <h3>Combined{summary.combined.coverageComplete ? "" : " (partial)"}</h3>
      {summary.combined.currencies.map(bucket => <div key={bucket.currency} className="finance-currency">
        {summary.combined!.currencies.length > 1 && <span className="finance-currency-code">{bucket.currency}</span>}
        <CurrencyFigures bucket={bucket} expenseCurrencyKnown={expenseKnown} />
      </div>)}
    </section>}
    <div className="finance-sources">{summary.sources.map(source => <SourceCard key={source.sourceId} source={source} />)}</div>
    <p className="finance-footnote">Read-only figures from Project Alpha. Adjusted income counts payments by their original date with current refunds, disputes and fees; it isn't bank deposits. The recorded operating result is adjusted income minus recorded expenses, not an accounting profit.</p>
  </Card>;
}

/** Admin-only dashboard panel. Renders nothing unless the session grants finance summary access. */
export function FinanceSummaryPanel({ enabled }: { enabled: boolean }) {
  const [summary, setSummary] = useState<AdminFinanceSummary | null>(null), [error, setError] = useState(""), [hidden, setHidden] = useState(false);
  const load = () => {
    setError(""); setSummary(null);
    api<unknown>("/api/admin/finance/summary").then(value => {
      if (!usableSummary(value)) throw new Error("The finance summary could not be verified.");
      setSummary(value);
    }).catch(caught => {
      if (caught instanceof ApiError && caught.status === 403) { setHidden(true); return; }
      setError(caught instanceof Error ? caught.message : "The finance summary could not be loaded.");
    });
  };
  useEffect(() => { if (enabled) load(); }, [enabled]);
  if (!enabled || hidden) return null;
  if (error) return <Card className="finance-panel" title="Finances at a glance">
    <div className="notice error" role="alert"><span>{error}</span></div>
    <button type="button" className="button-ghost button-small" onClick={load}>Retry</button>
  </Card>;
  if (!summary) return <Card className="finance-panel" title="Finances at a glance"><Skeleton variant="stats" columns={4} label="Loading finance summary…" /></Card>;
  return <FinanceSummaryView summary={summary} />;
}
