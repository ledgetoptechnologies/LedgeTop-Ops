import { useEffect,useState } from "react";
import { loadOperationsFinancial,type PortalFinancialDocument,type PortalOperationsHomeResponse } from "./portal-api";
import { OperationsNativeDataBrowser } from "./OperationsNativeDataBrowser";
import { AccountMenu } from "@ltds/ui";
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

/** Whole cents from a server decimal string ("1234.50"); amounts are never parsed as floats. */
const cents = (value: string | null) => value === null ? null : Number(value.replace(".", ""));
function money(amountInCents: number, currency: string) {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountInCents / 100); }
  catch { return `${currency} ${(amountInCents / 100).toFixed(2)}`; }
}
type InvoiceState = "due" | "partial" | "paid" | "other";
function invoiceState(document: PortalFinancialDocument): InvoiceState {
  const total = cents(document.total)!, due = cents(document.balanceDue), paid = cents(document.amountPaid);
  if (due !== null) return due <= 0 ? "paid" : paid && paid > 0 ? "partial" : "due";
  if (paid !== null) return paid >= total ? "paid" : paid > 0 ? "partial" : "due";
  return "other";
}
const STATE_TEXT: Record<InvoiceState, string> = { due: "Payment due", partial: "Partly paid", paid: "Paid", other: "" };

/**
 * Invoices and contracts as a picture: what's owed now, how much of each invoice is paid, and one tap to pay.
 * Payment itself happens on the existing secure payment page; nothing is paid or changed here.
 */
export function OperationsFinancialSummary({state,documents}:{state:"loading"|"ready"|"unavailable";documents:PortalFinancialDocument[]}){
  const invoices = documents.filter(document => document.kind !== "contract");
  const contracts = documents.filter(document => document.kind === "contract");
  const owed = new Map<string, { amount: number; count: number }>();
  for (const invoice of invoices) {
    const state = invoiceState(invoice);
    if (state !== "due" && state !== "partial") continue;
    const due = cents(invoice.balanceDue) ?? cents(invoice.total)! - (cents(invoice.amountPaid) ?? 0);
    const entry = owed.get(invoice.currency) ?? { amount: 0, count: 0 };
    owed.set(invoice.currency, { amount: entry.amount + due, count: entry.count + 1 });
  }
  const dueCount = [...owed.values()].reduce((sum, entry) => sum + entry.count, 0);
  const ordered = [...invoices].sort((left, right) => {
    const rank = (document: PortalFinancialDocument) => ({ due: 0, partial: 0, other: 1, paid: 2 })[invoiceState(document)];
    return rank(left) - rank(right);
  });
  return <section className="portal-card portal-finance" aria-label="Invoices and contracts"><h2>Invoices and contracts</h2>
    {state==="loading"?<p>Loading financial documents…</p>:state==="unavailable"?<p>Financial information is temporarily unavailable.</p>
      :documents.length===0?<p>No invoices or contracts are currently available.</p>
      :<>
        {invoices.length > 0 && <div className={`portal-finance-summary${dueCount ? " portal-finance-owing" : " portal-finance-settled"}`}>
          {dueCount ? <>
            <span className="portal-finance-label">Balance due</span>
            <span className="portal-finance-total">{[...owed].map(([currency, entry]) => money(entry.amount, currency)).join(" + ")}</span>
            <span className="portal-finance-detail">{dueCount === 1 ? "1 invoice needs payment" : `${dueCount} invoices need payment`}</span>
          </> : <>
            <span className="portal-finance-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></span>
            <span className="portal-finance-total">You’re all paid up</span>
            <span className="portal-finance-detail">No invoices need payment right now.</span>
          </>}
        </div>}
        {ordered.length > 0 && <ul className="portal-finance-list">{ordered.map(document => {
          const state = invoiceState(document), total = cents(document.total)!;
          const paid = state === "paid" ? total : cents(document.amountPaid) ?? (cents(document.balanceDue) !== null ? total - cents(document.balanceDue)! : 0);
          const percent = total > 0 ? Math.max(0, Math.min(100, Math.round(paid / total * 100))) : 100;
          return <li key={`${document.scopeKey}:${document.kind}:${document.publicId}`}>
            <div className="portal-finance-row">
              <strong>{money(total, document.currency)}</strong>
              <span className={`status-pill ${state === "paid" ? "success" : state === "other" ? "neutral" : "warning"}`}>{STATE_TEXT[state] || document.status}</span>
            </div>
            {state !== "other" && <div className="portal-finance-meter" role="img" aria-label={`${percent}% paid`}><span style={{ width: `${percent}%` }} /></div>}
            <div className="portal-finance-actions">
              {document.actionUrl && document.actionUrl !== document.documentUrl && state !== "paid" &&
                <a className="button-orange button-small" href={document.actionUrl} rel="noreferrer">Pay now</a>}
              {document.documentUrl && <a className="portal-text-action" href={document.documentUrl} rel="noreferrer">View document</a>}
            </div>
          </li>;
        })}</ul>}
        {contracts.length > 0 && <div className="portal-finance-contracts"><h3>Contracts</h3><ul>{contracts.map(document =>
          <li key={`${document.scopeKey}:${document.kind}:${document.publicId}`}>
            <span>Contract <small>{document.status}</small></span>
            <span className="portal-finance-actions">
              {document.actionUrl && document.actionUrl !== document.documentUrl && <a className="button-ghost button-small" href={document.actionUrl} rel="noreferrer">Review and sign</a>}
              {document.documentUrl && <a className="portal-text-action" href={document.documentUrl} rel="noreferrer">View document</a>}
            </span>
          </li>)}</ul></div>}
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
      <AccountMenu className="portal-account-menu" displayName="Client portal" avatar="LT" />
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
