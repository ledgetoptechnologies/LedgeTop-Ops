import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "./api";

const ENDPOINT = "/api/admin/integrations/project-alpha/api-v2/directory/read-adoptions";
const SOURCES_ENDPOINT = `${ENDPOINT}/sources`;
const CANDIDATES_ENDPOINT = `${ENDPOINT}/candidates`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PA_PUBLIC_ID = /^[0-9a-f]{32}$/;

type ResourceType = "client" | "organization";
type Field = "name" | "email" | "phone" | "address_line1" | "address_line2" | "city" | "state"
  | "postal_code" | "country" | "client_type" | "organization_public_id";
type Decision = "unchanged" | "retain_local" | "adopt_project_alpha" | "requires_follow_up";
type Candidate = { source: { sourceId: string; sourceInstanceId: string; applicationId: string; historyEpoch: string };
  resourceType: ResourceType; projectAlphaPublicId: string; resourceRevision: string; authorizationGeneration: string;
  binding: { externalId: string; status: "active"; resourceRevision: string }; conflictState: "clear" };
type Comparison = { status: "compared"; reviewId: string; resourceType: ResourceType; fields: Array<{
  field: Field; localValue: string | null; projectAlphaValue: string | null; equal: boolean;
}> };

const ORGANIZATION_FIELDS: readonly Field[] = ["name","email","phone","address_line1","address_line2","city","state","postal_code","country"];
const CLIENT_FIELDS: readonly Field[] = [...ORGANIZATION_FIELDS,"client_type","organization_public_id"];
const LABELS: Record<Field,string> = { name:"Name",email:"Email",phone:"Phone",address_line1:"Address line 1",
  address_line2:"Address line 2",city:"City",state:"State",postal_code:"Postal code",country:"Country",
  client_type:"Client type",organization_public_id:"Organization public ID" };

function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==="object"&&!Array.isArray(value);}
function error(caught:unknown,fallback:string):string{return caught instanceof ApiError&&caught.status===404
  ?"Existing-record adoption is disabled. No action was taken."
  :caught instanceof ApiError&&caught.status===403
    ?"Current administrator, permission, and native staff authority is required. No values were disclosed."
    :fallback;}
function comparison(value:unknown,reviewId:string):value is Comparison{
  if(!object(value)||value.status!=="compared"||value.reviewId!==reviewId
    ||(value.resourceType!=="client"&&value.resourceType!=="organization")||!Array.isArray(value.fields))return false;
  const expected=value.resourceType==="client"?CLIENT_FIELDS:ORGANIZATION_FIELDS,seen=new Set<string>();
  return value.fields.length===expected.length&&value.fields.every(item=>{
    if(!object(item)||!expected.includes(item.field as Field)||seen.has(String(item.field))
      ||!(item.localValue===null||typeof item.localValue==="string")
      ||!(item.projectAlphaValue===null||typeof item.projectAlphaValue==="string")||typeof item.equal!=="boolean"
      ||item.equal!==Object.is(item.localValue,item.projectAlphaValue))return false;
    seen.add(String(item.field));return true;
  });
}
function value(value:string|null){return value===null?<em>Not set</em>:value===""?<em>Empty string</em>:<code>{value}</code>;}

function ExactRecordReview({sources,disabled}:{sources:readonly string[];disabled:boolean}){
  const [sourceId,setSourceId]=useState(""),[resourceType,setResourceType]=useState<ResourceType>("client");
  const [recordId,setRecordId]=useState(""),[localVersion,setLocalVersion]=useState("1");
  const [candidates,setCandidates]=useState<Candidate[]>([]),[cursor,setCursor]=useState<string|null>(null);
  const [selected,setSelected]=useState<Candidate|null>(null),[candidateBusy,setCandidateBusy]=useState(false),[candidateError,setCandidateError]=useState("");
  const [reviewId,setReviewId]=useState(""),[compared,setCompared]=useState<Comparison|null>(null);
  const [receiptId,setReceiptId]=useState(""),[decisions,setDecisions]=useState<Partial<Record<Field,Decision>>>({});
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(""),[reviewError,setReviewError]=useState("");
  const reservationKey=useRef(""),finalizationKey=useRef("");
  useEffect(()=>setSourceId(current=>sources.includes(current)?current:sources[0]??""),[sources]);
  const clear=()=>{setReviewId("");setCompared(null);setDecisions({});setReviewError("");setMessage("");};
  const reset=()=>{reservationKey.current="";finalizationKey.current="";setReceiptId("");clear();};
  const load=async(next?:string|null,append=false)=>{
    if(disabled||candidateBusy||!sourceId)return;setCandidateBusy(true);setCandidateError("");
    try{
      const query=new URLSearchParams({sourceId,limit:"50",...(next?{cursor:next}:{})});
      const response=await api<unknown>(`${CANDIDATES_ENDPOINT}?${query.toString()}`);
      if(!object(response)||!Array.isArray(response.items)||!(response.nextCursor===null||typeof response.nextCursor==="string"))throw new Error("invalid candidate response");
      const parsed=response.items.filter((item):item is Candidate=>object(item)&&object(item.source)&&object(item.binding)
        &&item.source.sourceId===sourceId&&typeof item.source.sourceInstanceId==="string"&&typeof item.source.applicationId==="string"
        &&typeof item.source.historyEpoch==="string"&&(item.resourceType==="client"||item.resourceType==="organization")
        &&typeof item.projectAlphaPublicId==="string"&&PA_PUBLIC_ID.test(item.projectAlphaPublicId)
        &&typeof item.resourceRevision==="string"&&typeof item.authorizationGeneration==="string"
        &&item.binding.status==="active"&&typeof item.binding.externalId==="string"
        &&item.binding.resourceRevision===item.resourceRevision&&item.conflictState==="clear");
      if(parsed.length!==response.items.length||parsed.length>50)throw new Error("invalid candidate item");
      setCandidates(current=>append?[...current,...parsed]:parsed);setCursor(response.nextCursor);setSelected(null);
      setRecordId("");setLocalVersion("1");reset();
    }catch(caught){setCandidateError(error(caught,"Eligible Project Alpha candidates could not be loaded. Refresh the list before continuing."));
      if(!append){setCandidates([]);setCursor(null);setSelected(null);}}
    finally{setCandidateBusy(false);}
  };
  const reserve=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();if(disabled||busy)return;const local=recordId.trim(),version=Number(localVersion),candidate=selected;
    if(!sourceId||!local||local.length>191||/\p{C}/u.test(local)||!Number.isInteger(version)||version<1||!candidate
      ||candidate.resourceType!==resourceType||candidate.source.sourceId!==sourceId){setReviewError("Select one eligible Project Alpha record and enter its exact Operations record ID and positive version.");return;}
    setBusy(true);clear();
    try{
      const response=await api<{outcome?:unknown}>(ENDPOINT,{method:"POST",headers:{"Idempotency-Key":reservationKey.current||=crypto.randomUUID()},body:JSON.stringify({
        sourceId,resourceType,recordId:local,expectedLocalRecordVersion:version,sourceInstanceId:candidate.source.sourceInstanceId,
        applicationId:candidate.source.applicationId,historyEpoch:candidate.source.historyEpoch,projectAlphaPublicId:candidate.projectAlphaPublicId,
        resourceRevision:candidate.resourceRevision,authorizationGeneration:candidate.authorizationGeneration,
        bindingExternalId:candidate.binding.externalId,bindingResourceRevision:candidate.binding.resourceRevision})});
      const outcome=response.outcome;
      if(object(outcome)&&(outcome.status==="reserved"||outcome.status==="replayed")&&outcome.state==="inactive"
        &&typeof outcome.reviewId==="string"&&UUID.test(outcome.reviewId)){setReviewId(outcome.reviewId);setMessage("Exact pair reserved as inactive. Field values remain hidden until you explicitly compare them.");}
      else if(object(outcome)&&["disabled","blocked","rejected","conflict"].includes(String(outcome.status)))setReviewError("The exact pair was not reserved. No comparison was performed.");
      else throw new Error("invalid reservation response");
    }catch(caught){setReviewError(error(caught,"The exact-pair reservation response could not be verified."));}finally{setBusy(false);}
  };
  const compare=async()=>{
    if(disabled||busy||!reviewId)return;setBusy(true);setCompared(null);setDecisions({});setReviewError("");setMessage("");
    try{const response=await api<{outcome?:unknown}>(`${ENDPOINT}/${encodeURIComponent(reviewId)}/field-comparison`,{method:"POST",body:JSON.stringify({})});
      if(comparison(response.outcome,reviewId)){setCompared(response.outcome);setDecisions(Object.fromEntries(response.outcome.fields.filter(field=>field.equal).map(field=>[field.field,"unchanged"])));setMessage("Authorized comparison loaded. Review every differing field before sealing.");}
      else if(object(response.outcome)&&["disabled","blocked","rejected"].includes(String(response.outcome.status)))setReviewError("The comparison is no longer current or authorized. No values were disclosed.");
      else throw new Error("invalid comparison response");
    }catch(caught){setReviewError(error(caught,"The field-comparison response could not be verified. No values were disclosed."));}finally{setBusy(false);}
  };
  const seal=async()=>{
    if(disabled||busy||!compared||compared.fields.some(field=>!decisions[field.field]))return;
    if(!window.confirm("Seal these enum-only field dispositions? This does not update local records or Project Alpha."))return;
    setBusy(true);setReviewError("");setMessage("");
    try{const response=await api<{outcome?:unknown}>(`${ENDPOINT}/${encodeURIComponent(compared.reviewId)}/field-review`,{method:"POST",body:JSON.stringify({decisions})}),outcome=response.outcome;
      if(object(outcome)&&(outcome.status==="sealed"||outcome.status==="replayed")&&typeof outcome.receiptId==="string"&&UUID.test(outcome.receiptId)){
        setReceiptId(outcome.receiptId);setCompared(null);setDecisions({});setReviewId("");setMessage("Field review sealed. Review the finalization warning and explicitly finalize to apply the selected fields and binding.");}
      else if(object(outcome)&&["disabled","blocked","rejected","conflict"].includes(String(outcome.status)))setReviewError("The review could not be sealed because its exact evidence is disabled, stale, invalid, or already sealed.");
      else throw new Error("invalid field-review response");
    }catch(caught){setReviewError(error(caught,"The field-review receipt could not be verified. Treat the seal outcome as uncertain and refresh before retrying."));}finally{setBusy(false);}
  };
  const finalize=async()=>{
    if(disabled||busy||!receiptId)return;
    if(!window.confirm("Finalize this sealed review? Explicitly adopted scalar fields will update the Operations record, Project Alpha will be rebound to that exact record, and the canonical mapping will activate. This does not grant client portal, Delivery, folder, workspace, or public-link access."))return;
    setBusy(true);setReviewError("");setMessage("");
    try{const response=await api<{outcome?:unknown}>(`${ENDPOINT}/field-reviews/${encodeURIComponent(receiptId)}/finalize`,{method:"POST",headers:{"Idempotency-Key":finalizationKey.current||=crypto.randomUUID()},body:JSON.stringify({})}),outcome=response.outcome;
      if(object(outcome)&&(outcome.status==="finalized"||outcome.status==="replayed")&&typeof outcome.finalizationId==="string"&&UUID.test(outcome.finalizationId)){
        reset();setRecordId("");setLocalVersion("1");setSelected(null);setMessage("Exact Directory mapping finalized. No client portal, Delivery, workspace, folder, or public-link access was granted.");}
      else if(object(outcome)&&["disabled","blocked","rejected","conflict","uncertain"].includes(String(outcome.status)))setReviewError(`Finalization stopped at ${typeof outcome.stage==="string"?outcome.stage.replaceAll("_"," "):"its safety gate"}. Refresh and perform a new review if evidence or authority is stale.`);
      else throw new Error("invalid finalization response");
    }catch(caught){setReviewError(error(caught,"Finalization could not be verified. Retry with the same browser session before starting a new review."));}finally{setBusy(false);}
  };
  const allDecided=Boolean(compared)&&compared!.fields.every(field=>Boolean(decisions[field.field]));
  const frozen=Boolean(reviewId||receiptId);
  return <section aria-label="Operational exact-record field review"><h3>Existing-record Directory adoption</h3>
    <p>Select one configured source and one eligible Project Alpha record, then explicitly bind it to the exact Operations record and version. Values remain hidden until the authorized comparison step.</p>
    <form onSubmit={reserve} aria-busy={busy}>
      <label>Deployment source<select value={sourceId} disabled={disabled||busy||candidateBusy||frozen} onChange={event=>{setSourceId(event.target.value);setCandidates([]);setCursor(null);setSelected(null);reset();}}>{sources.map(source=><option key={source} value={source}>{source}</option>)}</select></label>
      <label>Record type<select value={resourceType} disabled={disabled||busy||candidateBusy||frozen} onChange={event=>{setResourceType(event.target.value as ResourceType);setSelected(null);reset();}}><option value="client">Client</option><option value="organization">Organization</option></select></label>
      <div role="group" aria-label="Eligible Project Alpha records"><button type="button" className="button-ghost button-small" disabled={disabled||candidateBusy||busy||frozen} onClick={()=>void load(null)}>{candidateBusy?"Loading eligible records…":"Refresh eligible Project Alpha records"}</button>
        {candidateError&&<p role="alert" className="notice">{candidateError}</p>}
        {candidates.filter(candidate=>candidate.resourceType===resourceType).map(candidate=>{const key=`${candidate.source.sourceInstanceId}:${candidate.source.applicationId}:${candidate.source.historyEpoch}:${candidate.resourceType}:${candidate.projectAlphaPublicId}`;return <label key={key}><input type="radio" name="operational-project-alpha-directory-candidate" checked={selected===candidate} disabled={disabled||candidateBusy||busy||frozen} onChange={()=>{reset();setSelected(candidate);}} />{candidate.resourceType} · {candidate.projectAlphaPublicId} · revision {candidate.resourceRevision} · binding {candidate.binding.externalId}</label>;})}
        {!candidateBusy&&candidates.filter(candidate=>candidate.resourceType===resourceType).length===0&&<p role="status">No eligible unreserved {resourceType} records on this page.</p>}
        {cursor&&<button type="button" className="button-ghost button-small" disabled={disabled||candidateBusy||busy||frozen} onClick={()=>void load(cursor,true)}>{candidateBusy?"Loading more…":"Load more eligible records"}</button>}</div>
      <label>Exact local record ID<input value={recordId} maxLength={191} disabled={disabled||busy||frozen} onChange={event=>{setRecordId(event.target.value);reset();}} /></label>
      <label>Expected local record version<input type="number" min="1" step="1" value={localVersion} disabled={disabled||busy||frozen} onChange={event=>{setLocalVersion(event.target.value);reset();}} /></label>
      <button type="submit" className="button-ghost button-small" disabled={disabled||busy||frozen||!selected}>{busy&&!reviewId?"Reserving exact pair…":"Reserve selected exact pair"}</button>
    </form>
    {reviewId&&!compared&&<button type="button" className="button-ghost button-small" disabled={disabled||busy} onClick={()=>void compare()}>{busy?"Comparing authorized fields…":"Compare authorized fields"}</button>}
    {compared&&<div role="group" aria-label="Compared field dispositions"><div className="project-alpha-field-review-table-scroll" tabIndex={0} aria-label="Compared fields; scroll horizontally to view each value and disposition"><table><thead><tr><th>Field</th><th>Local value</th><th>Project Alpha value</th><th>Disposition</th></tr></thead><tbody>{compared.fields.map(field=><tr key={field.field}><th scope="row">{LABELS[field.field]}</th><td>{value(field.localValue)}</td><td>{value(field.projectAlphaValue)}</td><td>{field.equal?<span>Unchanged</span>:<select aria-label={`${LABELS[field.field]} disposition`} value={decisions[field.field]??""} disabled={busy} onChange={event=>setDecisions(current=>({...current,[field.field]:event.target.value as Decision}))}><option value="">Select disposition</option><option value="retain_local">Retain local</option><option value="adopt_project_alpha">Adopt Project Alpha</option><option value="requires_follow_up">Requires follow-up</option></select>}</td></tr>)}</tbody></table></div><button type="button" className="button-ghost button-small" disabled={disabled||busy||!allDecided} onClick={()=>void seal()}>{busy?"Sealing review…":"Seal field review"}</button></div>}
    {receiptId&&<div role="group" aria-label="Finalize sealed Directory review"><p>This applies only the sealed scalar dispositions, rebinds the exact Project Alpha identity, and activates the one-to-one canonical mapping. Unsupported relationship changes require a new review. Client portal, Delivery, workspace, folder, and public-link access remain unchanged.</p><button type="button" className="button-ghost button-small" disabled={disabled||busy} onClick={()=>void finalize()}>{busy?"Finalizing exact mapping…":"Finalize sealed review"}</button></div>}
    {message&&<p role="status" className="notice">{message}</p>}{reviewError&&<p role="alert" className="notice">{reviewError}</p>}
  </section>;
}

export function DirectoryExistingRecordAdoptionPanel({disabled}:{disabled:boolean}){
  const [available,setAvailable]=useState<boolean|null>(null),[sources,setSources]=useState<readonly string[]>([]),[sourceError,setSourceError]=useState("");
  useEffect(()=>{let live=true;api<{sources?:unknown;operational?:unknown;configuration?:unknown}>(SOURCES_ENDPOINT).then(result=>{
    if(!live)return;if(typeof result.operational!=="boolean")throw new Error("invalid operational source list");
    if(!result.operational){setAvailable(false);setSources([]);setSourceError("");return;}
    if(result.configuration!==undefined&&result.configuration!=="unavailable")throw new Error("invalid operational source list");
    if(result.configuration==="unavailable"){setAvailable(true);setSources([]);setSourceError("Existing-record adoption source configuration could not be verified.");return;}
    if(!Array.isArray(result.sources)||result.sources.some(source=>typeof source!=="string"||!/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(source)))throw new Error("invalid operational source list");
    setAvailable(true);setSources([...new Set(result.sources)].sort());setSourceError("");
  }).catch(caught=>{if(!live)return;setAvailable(caught instanceof ApiError&&caught.status===404?false:true);setSources([]);setSourceError(caught instanceof ApiError&&caught.status===404?"":error(caught,"Existing-record adoption source configuration could not be verified."));});return()=>{live=false;};},[]);
  if(available!==true)return null;
  return <details className="alpha-connection"><summary>Existing-record Directory adoption</summary>
    <p>This independent default-off operational panel performs only explicit exact-record review and finalization. Finalization changes the exact Project Alpha binding described in the reviewed evidence; it does not expose arbitrary Project Alpha profile editing, staging inventory, synthetic evidence, permission grants, source registration, or credentials.</p>
    {sourceError&&<p role="alert" className="notice">{sourceError}</p>}
    {sources.length===0?<p role="status">No enabled API-v2 sources are available for existing-record adoption.</p>:<ExactRecordReview sources={sources} disabled={disabled}/>}
  </details>;
}
