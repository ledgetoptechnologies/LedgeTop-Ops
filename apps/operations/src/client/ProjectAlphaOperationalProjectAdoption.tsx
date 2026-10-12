import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "./api";

type Candidate = Readonly<{ publicId:string; revision:string; name:string; status:string; archived:boolean;
  organizationPublicId:string|null; clientPublicId:string|null }>;
type Root = Readonly<{ sourceId:string; rootNamespace:string; kind:"organization"|"standalone_client"; publicId:string }>;

function message(error:unknown,fallback:string):string {
  return error instanceof ApiError && error.message ? error.message : error instanceof Error && error.message ? error.message : fallback;
}

export function ProjectAlphaOperationalProjectAdoption({root,contextVersion,contextSignal,disabled,onInvalidated,onRefresh}:{
  root:Root;contextVersion:string;contextSignal:AbortSignal;disabled:boolean;
  onInvalidated:(message:string)=>void;onRefresh:()=>void;
}) {
  const base=`/api/client-hub/sources/${encodeURIComponent(root.sourceId)}/${root.rootNamespace}/${root.kind==="organization"?"organizations":"standalone"}/${encodeURIComponent(root.publicId)}/project-adoption`;
  const [projects,setProjects]=useState<readonly Candidate[]>([]),[nextCursor,setNextCursor]=useState<string|null>(null);
  const [selected,setSelected]=useState(""),[externalId,setExternalId]=useState("");
  const [reviewKey,setReviewKey]=useState(""),[reviewItemId,setReviewItemId]=useState("");
  const [reserveKey,setReserveKey]=useState(""),[reservationId,setReservationId]=useState("");
  const [commandId,setCommandId]=useState(""),[finalizationStarted,setFinalizationStarted]=useState(false),[finalized,setFinalized]=useState(false);
  const [busy,setBusy]=useState(false),[status,setStatus]=useState(""),[error,setError]=useState("");
  const live=useRef(true),frozen=Boolean(reviewKey||reviewItemId||reserveKey||reservationId||commandId);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const fail=(caught:unknown,fallback:string)=>{
    if(caught instanceof ApiError&&[401,403,404,409].includes(caught.status)) onInvalidated(message(caught,fallback));
    else if(live.current)setError(`${message(caught,fallback)} Keep the displayed identifiers and retry only the same frozen action after review.`);
  };
  const discover=async(cursor?:string)=>{
    if(disabled||busy||frozen||contextSignal.aborted)return;
    setBusy(true);setError("");setStatus("");
    if(!cursor){setProjects([]);setSelected("");setNextCursor(null);}
    try{
      const params=new URLSearchParams({expectedContextVersion:contextVersion,limit:"50"});if(cursor)params.set("cursor",cursor);
      const response=await api<{contextVersion?:string;outcome?:{status?:string;projects?:Candidate[];nextCursor?:string|null}}>(`${base}/candidates?${params}`,{signal:contextSignal});
      if(response.contextVersion!==contextVersion||response.outcome?.status!=="observed"||!Array.isArray(response.outcome.projects))
        throw new ApiError("Project candidates could not be verified for this customer.",409,{});
      if(live.current){setProjects(current=>cursor?[...current,...response.outcome!.projects!]:response.outcome!.projects!);setNextCursor(response.outcome.nextCursor??null);
        setStatus(response.outcome.projects.length?"Select one exact Project for adoption.":"No authorized unbound Projects were found for this customer.");}
    }catch(caught){if(!contextSignal.aborted)fail(caught,"Project adoption discovery is unavailable.");}
    finally{if(live.current)setBusy(false);}
  };
  const review=async(event?:FormEvent)=>{
    event?.preventDefault();const exact=externalId.trim();
    if(!/^[0-9a-f]{32}$/.test(selected)||!exact||exact!==externalId||exact.length>191||/\p{C}/u.test(exact)){setError("Select a candidate and enter a new, unused Operations Project ID.");return;}
    if(!reviewKey&&!window.confirm("Reserve this new Operations Project ID and create short-lived review evidence for the selected customer Project? This does not grant access or publish anything."))return;
    const key=reviewKey||crypto.randomUUID();if(!reviewKey)setReviewKey(key);
    setBusy(true);setError("");setStatus("");
    try{
      const response=await api<{outcome?:{status?:string;reviewItemId?:string}}>(`${base}/review`,{method:"POST",headers:{"Idempotency-Key":key},body:JSON.stringify({expectedContextVersion:contextVersion,externalProjectId:exact,projectAlphaPublicId:selected})});
      if(response.outcome?.status!=="reviewed"||!response.outcome.reviewItemId)throw new Error(`Review was not completed (${response.outcome?.status??"invalid response"}).`);
      if(live.current){setReviewItemId(response.outcome.reviewItemId);setStatus(`Review evidence created: ${response.outcome.reviewItemId}.`);}
    }catch(caught){fail(caught,"Project adoption review outcome is uncertain.");}finally{if(live.current)setBusy(false);}
  };
  const reserve=async()=>{
    if(!reviewItemId||busy||reservationId)return;
    if(!reserveKey&&!window.confirm("Reserve this exact reviewed adoption intent? This still does not bind the Project or grant access."))return;
    const key=reserveKey||crypto.randomUUID();if(!reserveKey)setReserveKey(key);
    setBusy(true);setError("");setStatus("");
    try{
      const response=await api<{status?:string;reservationId?:string}>(`${base}/reserve`,{method:"POST",headers:{"Idempotency-Key":key},body:JSON.stringify({expectedContextVersion:contextVersion,reviewItemId,idempotencyKey:key})});
      if(response.status!=="reserved"||!response.reservationId)throw new Error(`Reservation was not completed (${response.status??"invalid response"}).`);
      if(live.current){setReservationId(response.reservationId);setStatus(`Adoption reservation created: ${response.reservationId}.`);}
    }catch(caught){fail(caught,"Project adoption reservation outcome is uncertain.");}finally{if(live.current)setBusy(false);}
  };
  const bind=async()=>{
    if(!reservationId||busy||commandId)return;
    if(!window.confirm("Create the new Operations Project and queue the exact Project Alpha bind command? This does not grant client access or publish a portal."))return;
    setBusy(true);setError("");setStatus("");
    try{
      const response=await api<{status?:string;commandId?:string}>(`${base}/bind`,{method:"POST",headers:{"Idempotency-Key":reservationId},body:JSON.stringify({expectedContextVersion:contextVersion,reservationId})});
      if(response.status!=="planned"||!response.commandId)throw new Error(`Bind was not planned (${response.status??"invalid response"}).`);
      if(live.current){setCommandId(response.commandId);setStatus(`Bind command queued locally: ${response.commandId}. Remote acknowledgement is not yet confirmed.`);}
    }catch(caught){fail(caught,"Project adoption bind outcome is uncertain.");}finally{if(live.current)setBusy(false);}
  };
  const finalize=async()=>{
    if(!reservationId||!commandId||busy||finalized)return;
    if(!finalizationStarted&&!window.confirm("Send the exact queued bind command and verify Project Alpha acknowledgement before activating its Operations mapping? No client access or public link is created."))return;
    setFinalizationStarted(true);setBusy(true);setError("");setStatus("");
    try{
      const response=await api<{stage?:string;outcome?:{status?:string}}>(`${base}/finalize`,{method:"POST",headers:{"Idempotency-Key":commandId},body:JSON.stringify({expectedContextVersion:contextVersion,reservationId,commandId})});
      if(response.stage!=="activate"||response.outcome?.status!=="activated")throw new Error(`Finalization stopped at ${response.stage??"unknown"} (${response.outcome?.status??"invalid response"}). Do not create a replacement command.`);
      if(live.current){setFinalized(true);setStatus("Project Alpha binding verified and the new Operations Project mapping activated. Client access and public links remain unchanged.");}
    }catch(caught){fail(caught,"Project adoption finalization outcome is uncertain.");}finally{if(live.current)setBusy(false);}
  };
  return <section className="client-hub-project-adoption" aria-label="Adopt a Project Alpha project for this customer">
    <h3>Adopt an existing Project Alpha project</h3>
    <p>Find an unbound Project related to this exact customer, choose a new unused Operations Project ID, then review each durable step. This does not grant client access, publish a link, or activate a portal.</p>
    <button type="button" className="button-ghost button-small" disabled={disabled||busy||frozen} onClick={()=>void discover()}>{busy?"Checking…":"Find unbound Projects for this customer"}</button>
    {nextCursor&&<button type="button" className="button-ghost button-small" disabled={disabled||busy||frozen} onClick={()=>void discover(nextCursor)}>Load next 50 Projects</button>}
    {projects.length>0&&<form onSubmit={review} aria-busy={busy}><fieldset><legend>Select one exact Project</legend>{projects.map(project=><label key={project.publicId}>
      <input type="radio" name="operational-project-adoption-candidate" value={project.publicId} checked={selected===project.publicId} disabled={disabled||busy||frozen} onChange={()=>setSelected(project.publicId)}/>
      {project.name} · revision {project.revision} · {project.publicId}</label>)}</fieldset>
      <label>New, unused Operations Project ID<input value={externalId} maxLength={191} disabled={disabled||busy||frozen} onChange={event=>setExternalId(event.target.value)}/></label>
      <button type="submit" disabled={disabled||busy||frozen}>Create review evidence</button></form>}
    {reviewKey&&!reviewItemId&&<button type="button" disabled={disabled||busy} onClick={()=>void review()}>Retry frozen review request</button>}
    {reviewItemId&&!reservationId&&<button type="button" disabled={disabled||busy} onClick={()=>void reserve()}>{reserveKey?"Retry frozen reservation":"Reserve reviewed intent"}</button>}
    {reservationId&&!commandId&&<button type="button" disabled={disabled||busy} onClick={()=>void bind()}>Create Project and queue bind command</button>}
    {commandId&&!finalized&&<button type="button" disabled={disabled||busy} onClick={()=>void finalize()}>{finalizationStarted?"Resume verification of the same bind command":"Finalize and verify Project binding"}</button>}
    {finalized&&<button type="button" className="button-ghost button-small" onClick={onRefresh}>Refresh customer projects</button>}
    {(reviewKey||reserveKey||reservationId||commandId)&&<dl aria-label="Project adoption recovery references"><dt>Review request</dt><dd>{reviewKey}</dd><dt>Reservation request</dt><dd>{reserveKey}</dd><dt>Reservation</dt><dd>{reservationId}</dd><dt>Bind command</dt><dd>{commandId}</dd></dl>}
    {status&&<p role="status" className="notice">{status}</p>}{error&&<p role="alert" className="notice">{error}</p>}
  </section>;
}
