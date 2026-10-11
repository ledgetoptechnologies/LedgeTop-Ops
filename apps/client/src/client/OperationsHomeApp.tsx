import { useEffect,useState } from "react";
import { loadOperationsFinancial,type PortalFinancialDocument,type PortalOperationsHomeResponse } from "./portal-api";
import { OperationsNativeDataBrowser } from "./OperationsNativeDataBrowser";
import { AccountMenu } from "@ltds/ui";

export function OperationsServiceSummary({ response, embedded = false }: {
  response: PortalOperationsHomeResponse;
  embedded?: boolean;
}) {
  const hasServices = response.homes.some(home => home.services.length > 0);
  return <section className="portal-card" aria-label="Independent operations service summary">
    <h2>{embedded ? "Operations services" : hasServices ? "Available services" : "No services available"}</h2>
    {embedded && <p>Your service summary. Files and requests follow the access for your selected workspace.</p>}
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
  return <>
    <OperationsServiceSummary response={response} embedded={embedded} />
    <OperationsFinancialPanel key={nativeDataScope} response={response}/>
    <OperationsNativeDataBrowser key={nativeDataScope} />
  </>;
}

function OperationsFinancialPanel({response}:{response:PortalOperationsHomeResponse}){
  const[documents,setDocuments]=useState<PortalFinancialDocument[]>([]),[state,setState]=useState<"loading"|"ready"|"unavailable">("loading");
  useEffect(()=>{const controller=new AbortController();setState("loading");
    void Promise.all(response.homes.map(home=>loadOperationsFinancial(home.authorityId,undefined,controller.signal)))
      .then(values=>{if(!controller.signal.aborted){setDocuments(values.flat());setState("ready");}})
      .catch(()=>{if(!controller.signal.aborted){setDocuments([]);setState("unavailable");}});
    return()=>controller.abort();},[response]);
  return <OperationsFinancialSummary state={state} documents={documents}/>;
}

export function OperationsFinancialSummary({state,documents}:{state:"loading"|"ready"|"unavailable";documents:PortalFinancialDocument[]}){
  return <section className="portal-card" aria-label="Invoices and contracts"><h2>Invoices and contracts</h2>
    {state==="loading"?<p>Loading financial documents…</p>:state==="unavailable"?<p>Financial information is temporarily unavailable.</p>
      :documents.length===0?<p>No invoices or contracts are currently available.</p>
      :<ul>{documents.map(document=><li key={`${document.scopeKey}:${document.kind}:${document.publicId}`}><strong>{document.kind==="contract"?"Contract":"Invoice"}</strong>
        {` — ${document.status} — ${document.currency} ${document.total}`}
        {document.documentUrl&&<> · <a href={document.documentUrl} rel="noreferrer">View document</a></>}
        {document.actionUrl&&document.actionUrl!==document.documentUrl&&<> · <a href={document.actionUrl} rel="noreferrer">Open payment</a></>}
      </li>)}</ul>}
  </section>;
}

export function OperationsHomeApp({ response, clientUnavailable = false, onRetryClient }: {
  response: PortalOperationsHomeResponse;
  clientUnavailable?: boolean;
  onRetryClient?: () => void;
}) {
  return <div className="client-portal operations-home">
    <header className="client-portal-header">
      <div className="ltds-brand" aria-label="LedgeTop client portal">LedgeTop</div>
      <AccountMenu className="portal-account-menu" displayName="Client portal" avatar="LT" />
    </header>
    <main className="portal-main">
      <section className="portal-welcome">
        <p className="portal-eyebrow">LedgeTop client portal</p>
        <h1>Your services</h1>
        <p>Services currently available to you from LedgeTop operations providers.</p>
      </section>
      {clientUnavailable && <section className="portal-card" role="status">
        <h2>Client resources unavailable</h2>
        <p>Your Operations service summary is still available. You can retry without the unavailable workspace selection.</p>
        {onRetryClient && <button type="button" className="button-ghost" onClick={onRetryClient}>Try available client workspaces</button>}
      </section>}
      <OperationsNativeServicePanel response={response} />
    </main>
  </div>;
}
