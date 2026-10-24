import { useEffect,useState } from "react";
import { loadOperationsFinancial,type PortalFinancialDocument,type PortalOperationsHomeResponse } from "./portal-api";
import { OperationsNativeDataBrowser } from "./OperationsNativeDataBrowser";
import { AccountMenu } from "@ltds/ui";
import { PORTAL_APP_API } from "@ltds/shared";
import { PortalBrand } from "./PortalShell";

export function OperationsServiceSummary({ response, embedded = false }: {
  response: PortalOperationsHomeResponse;
  embedded?: boolean;
}) {
  const hasServices = response.homes.some(home => home.services.length > 0);
  return <section className="portal-card" aria-label="Independent operations service summary">
    <h2>{embedded ? "Services" : hasServices ? "Available services" : "No services available"}</h2>
    {embedded && <p>The services you have with Ledge Top.</p>}
    {response.homes.length === 0
      ? <p>Your account has no active operations services.</p>
      : response.homes.map(home => <div key={home.authorityId}>
        {home.services.length === 0
          ? <p>No services are currently listed for this access.</p>
          : <ul className="operations-home-services">
            {home.services.map(service => <li key={service.serviceId}><strong>{service.displayLabel}</strong></li>)}
          </ul>}
      </div>)}
  </section>;
}

export function OperationsNativeServicePanel({ response, embedded = false }: {
  response: PortalOperationsHomeResponse;
  embedded?: boolean;
}) {
  const nativeDataScope = JSON.stringify(response.homes
    .map(home => JSON.stringify([home.authorityId, home.workspaceId, home.ownershipEpoch, home.grantRevision]))
    .sort());
  // What a client most needs first (what they owe) leads; the service list and shared files follow.
  return <>
    <OperationsFinancialPanel key={nativeDataScope} response={response}/>
    <OperationsServiceSummary response={response} embedded={embedded} />
    <OperationsNativeDataBrowser key={nativeDataScope} />
  </>;
}

function OperationsFinancialPanel({response}:{response:PortalOperationsHomeResponse}){
  const[documents,setDocuments]=useState<PortalFinancialDocument[]>([]),[state,setState]=useState<"loading"|"ready"|"unavailable">("loading");
  useEffect(()=>{const controller=new AbortController();setState("loading");
    void Promise.all(response.homes.map(home=>loadOperationsFinancial(home.authorityId,undefined,controller.signal)
      .catch((error:unknown)=>{
        const denial=error as {status?:unknown;body?:{error?:unknown}};
        if(denial?.status===403&&denial.body?.error==="Client access is not provisioned")return [];
        throw error;
      })))
      .then(values=>{if(!controller.signal.aborted){setDocuments(values.flat());setState("ready");}})
      .catch(()=>{if(!controller.signal.aborted){setDocuments([]);setState("unavailable");}});
    return()=>controller.abort();},[response]);
  return <OperationsFinancialSummary state={state} documents={documents}/>;
}

/**
 * Exact whole cents from a server decimal string ("1234.50"). The server allows up to 18 integer digits, which a
 * float can't hold, so all money math here is BigInt and nothing is ever parsed as a float.
 */
const cents = (value: string | null) => value === null ? null : BigInt(value.replace(".", ""));
function money(amountInCents: bigint, currency: string) {
  const negative = amountInCents < 0n, absolute = negative ? -amountInCents : amountInCents;
  const decimal = `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
  // Intl formats a decimal string exactly (no float rounding) in current browsers.
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(decimal as unknown as number); }
  catch { return `${currency} ${decimal}`; }
}
function percentPaid(paid: bigint, total: bigint) {
  if (total <= 0n) return 100;
  const value = Number(paid * 100n / total);
  return Math.max(0, Math.min(100, value));
}
type InvoiceState = "overdue" | "due" | "partial" | "paid" | "other";
function invoiceState(document: PortalFinancialDocument): InvoiceState {
  const total = cents(document.total)!, due = cents(document.balanceDue), paid = cents(document.amountPaid);
  const owing = due !== null ? due > 0n : paid !== null ? paid < total : null;
  if (owing === null) return "other";
  if (!owing) return "paid";
  if (document.status === "overdue") return "overdue";
  return paid !== null && paid > 0n ? "partial" : "due";
}
const STATE_TEXT: Record<InvoiceState, string> = { overdue: "Overdue", due: "Payment due", partial: "Partly paid", paid: "Paid", other: "" };
const STATE_TONE: Record<InvoiceState, string> = { overdue: "danger", due: "warning", partial: "warning", paid: "success", other: "neutral" };
const CONTRACT_TEXT: Record<string, string> = { pending: "Awaiting your signature", active: "Active", paused: "Paused", completed: "Completed" };

/**
 * Invoices and contracts as a picture: what's owed now, how much of each invoice is paid, and one tap to pay.
 * Payment itself happens on the existing secure payment page; nothing is paid or changed here.
 */
export function OperationsFinancialSummary({state,documents}:{state:"loading"|"ready"|"unavailable";documents:PortalFinancialDocument[]}){
  const invoices = documents.filter(document => document.kind !== "contract");
  const contracts = documents.filter(document => document.kind === "contract");
  const owed = new Map<string, { amount: bigint; count: number }>();
  let overdue = 0;
  for (const invoice of invoices) {
    const state = invoiceState(invoice);
    if (state !== "due" && state !== "partial" && state !== "overdue") continue;
    if (state === "overdue") overdue++;
    const due = cents(invoice.balanceDue) ?? cents(invoice.total)! - (cents(invoice.amountPaid) ?? 0n);
    const entry = owed.get(invoice.currency) ?? { amount: 0n, count: 0 };
    owed.set(invoice.currency, { amount: entry.amount + due, count: entry.count + 1 });
  }
  const unknownCount = invoices.filter(document => invoiceState(document) === "other").length;
  const dueCount = [...owed.values()].reduce((sum, entry) => sum + entry.count, 0);
  const rank: Record<InvoiceState, number> = { overdue: 0, due: 1, partial: 1, other: 2, paid: 3 };
  const ordered = [...invoices].sort((left, right) => rank[invoiceState(left)] - rank[invoiceState(right)]);
  return <section className="portal-card portal-finance" aria-label="Invoices and contracts"><h2>Invoices and contracts</h2>
    {state==="loading"?<p>Loading financial documents…</p>:state==="unavailable"?<p>Financial information is temporarily unavailable.</p>
      :documents.length===0?<p>No invoices or contracts are currently available.</p>
      :<>
        {invoices.length > 0 && <div className={`portal-finance-summary${dueCount ? " portal-finance-owing" : unknownCount ? "" : " portal-finance-settled"}`}>
          {dueCount ? <>
            <span className="portal-finance-label">Balance due</span>
            <span className="portal-finance-total">{[...owed].map(([currency, entry]) => money(entry.amount, currency)).join(" + ")}</span>
            <span className="portal-finance-detail">{dueCount === 1 ? "1 invoice needs payment" : `${dueCount} invoices need payment`}
              {unknownCount > 0 && <span> � Some invoice balances are unavailable.</span>}
              {overdue > 0 && <strong className="portal-finance-overdue">{overdue === 1 ? " · 1 overdue" : ` · ${overdue} overdue`}</strong>}</span>
          </> : unknownCount ? <>
            <span className="portal-finance-total">Balance unavailable</span>
            <span className="portal-finance-detail">Payment information is unavailable for {unknownCount === 1 ? "1 invoice" : `${unknownCount} invoices`}.</span>
          </> : <>
            <span className="portal-finance-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></span>
            <span className="portal-finance-total">You’re all paid up</span>
            <span className="portal-finance-detail">No invoices need payment right now.</span>
          </>}
        </div>}
        {ordered.length > 0 && <ul className="portal-finance-list">{ordered.map(document => {
          const state = invoiceState(document), total = cents(document.total)!;
          const due = cents(document.balanceDue);
          const paid = state === "paid" ? total : cents(document.amountPaid) ?? (due !== null ? total - due : 0n);
          const percent = percentPaid(paid, total);
          return <li key={`${document.scopeKey}:${document.kind}:${document.publicId}`}>
            <div className="portal-finance-row">
              <strong>{money(total, document.currency)}</strong>
              <span className={`status-pill ${STATE_TONE[state]}`}>{STATE_TEXT[state] || document.status}</span>
            </div>
            {state !== "other" && <div className="portal-finance-meter" role="img" aria-label={`${percent}% paid`}><span style={{ width: `${percent}%` }} /></div>}
            <div className="portal-finance-actions">
              {document.actionUrl && document.actionUrl !== document.documentUrl && state !== "paid" &&
                <a className="button-orange button-small" href={document.actionUrl} rel="noreferrer">Pay now</a>}
              {document.documentUrl && <a className="portal-text-action" href={document.documentUrl} rel="noreferrer">View document</a>}
            </div>
          </li>;
        })}</ul>}
        {contracts.length > 0 && <div className="portal-finance-contracts"><h3>Contracts</h3><ul>{contracts.map(document => {
          // A pending contract is reviewed and signed on its document page, so its sign link is that same page.
          const sign = document.status === "pending" && document.actionUrl ? document.actionUrl : null;
          return <li key={`${document.scopeKey}:${document.kind}:${document.publicId}`}>
            <span>Contract <small>{CONTRACT_TEXT[document.status] ?? document.status}</small></span>
            <span className="portal-finance-actions">
              {sign && <a className="button-orange button-small" href={sign} rel="noreferrer">Review and sign</a>}
              {document.documentUrl && document.documentUrl !== sign && <a className="portal-text-action" href={document.documentUrl} rel="noreferrer">View document</a>}
            </span>
          </li>;
        })}</ul></div>}
      </>}
  </section>;
}

export function OperationsHomeApp({ response, clientUnavailable = false, onRetryClient }: {
  response: PortalOperationsHomeResponse;
  clientUnavailable?: boolean;
  onRetryClient?: () => void;
}) {
  return <div className="client-portal operations-home">
    <header className="client-portal-gate-header">
      <PortalBrand product="Client portal" />
      <AccountMenu className="portal-account-menu" displayName="Client portal" avatar="LT" appApi={PORTAL_APP_API} />
    </header>
    <main className="portal-main">
      <section className="portal-welcome">
        <p className="portal-eyebrow">Ledge Top client portal</p>
        <h1>Your services</h1>
        <p>Services, invoices and files Ledge Top currently shares with you.</p>
      </section>
      {clientUnavailable && <section className="portal-card portal-workspace-status" role="status">
        <h2>Project details unavailable</h2>
        <p>Your projects and requests could not be opened for the selected client. Your services, invoices and files below are still available.</p>
        {onRetryClient && <button type="button" className="button-orange" onClick={onRetryClient}>Try my other client accounts</button>}
      </section>}
      <OperationsNativeServicePanel response={response} />
    </main>
  </div>;
}
