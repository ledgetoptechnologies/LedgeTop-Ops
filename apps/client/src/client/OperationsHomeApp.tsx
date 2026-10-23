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
    <h2>{embedded ? "Operations services" : hasServices ? "Available services" : "No services available"}</h2>
    {embedded && <p>Your service summary. Files and requests follow the access for your selected client.</p>}
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
