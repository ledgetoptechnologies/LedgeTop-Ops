import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Card, StatusPill, requestChoice } from "@ltds/ui";
import { api, ApiError } from "./api";
import { SharedProfileAuthorityRecovery } from "./SharedProfileAuthorityRecovery";
import { NativeDirectoryProfileEdit, serializeNativeDirectoryProfile, type ProfileForm } from "./NativeDirectoryProfileEditor";

type Kind = "organization" | "client";
type Member = { recordId: string; version: number; sourceIds: string[]; sourceNames?: string[] };
// sourceId is the logical business-records source. When the client portal uses a
// different source, the server pairs portalSourceId with the approved
// correspondence revision; the two travel together or not at all.
type PortalCandidate={workspaceId:string;sourceId:string;portalSourceId?:string;correspondenceRevisionId?:string;principalPublicId:string;targetPublicId:string;recordId:string;groupId:string;clientName:string;
  state:'available'|'enabled'|'revoked'|'suspended';currentGrantId?:string;currentGrantRevision?:number};
type SharedProfile = { id: string; kind: Kind; version: number; profile: Record<string, string>; members: Member[];
  delivery: { state: "acknowledged" | "pending" | "conflict"; destinations?: unknown[] }; editing?: { available: boolean; reason?: string | null };
  emailEditing?: boolean; emailEditingReason?: string | null;portalSetup?:{available:boolean;candidates:PortalCandidate[]} };
type ProfileResponse = { sharedProfile: SharedProfile | null; canMerge?: boolean;canBootstrap?:boolean };
type Candidate = Member & { kind: Kind; name: string; parentName?: string };
type Preview = { previewToken: string; kind: Kind; profile: Record<string, string>; members: Member[];
  expiresAt: string; differences?: string[]; canConfirm: boolean };
type FrozenRequest = { path: string; method: "POST" | "PATCH"; mutationId: string; body: string };
const ENDPOINT = "/api/client-hub/shared-profiles";
const EMPTY: ProfileForm = { name: "", generalEmail: "", generalPhone: "", email: "", phone: "", clientType: "unknown",
  addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", country: "" };
const errorText = (error: unknown) => error instanceof Error ? error.message : "The shared profile could not be loaded.";
const sourceLabel = (source: string) => source === "project-alpha:primary" ? "Ledge Top Drone Services PA"
  : source === "project-alpha:secondary" ? "Ledge Top Technologies PA" : `Project Alpha (${source.replace(/^project-alpha:/, "")})`;
function validMember(value: Member): boolean {
  return !!value && typeof value.recordId === "string" && Number.isSafeInteger(value.version) && value.version > 0
    && Array.isArray(value.sourceIds) && value.sourceIds.length > 0
    && value.sourceIds.every(source => typeof source === "string" && /^project-alpha:[a-z0-9][a-z0-9_-]*$/.test(source));
}
function validFields(value: unknown, kind: Kind): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = (kind === "organization" ? ["name", "generalEmail", "generalPhone"] : ["name", "email", "phone"])
    .concat(["addressLine1", "addressLine2", "city", "state", "postalCode", "country"]);
  return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)
    && typeof (value as Record<string, unknown>)[field] === "string");
}
function validProfile(value: SharedProfile, kind: Kind, recordId: string): boolean {
  return !!value && typeof value.id === "string" && value.kind === kind && Number.isSafeInteger(value.version) && value.version > 0
    && validFields(value.profile, kind)
    && Array.isArray(value.members) && value.members.length >= 1 && value.members.length <= 2 && value.members.every(validMember)
    && new Set(value.members.map(member => member.recordId)).size === value.members.length
    && value.members.some(member => member.recordId === recordId)
    && !!value.delivery && ["acknowledged", "pending", "conflict"].includes(value.delivery.state)
    && (value.portalSetup===undefined||validPortalSetup(value));
}
const candidateKey=(candidate:PortalCandidate)=>JSON.stringify([candidate.workspaceId,candidate.sourceId,candidate.portalSourceId??null,candidate.correspondenceRevisionId??null,candidate.principalPublicId,candidate.targetPublicId,candidate.recordId]);
const PORTAL_SOURCE_PATTERN=/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/,REVISION_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validCorrespondencePair(candidate:PortalCandidate):boolean{
  if(candidate.portalSourceId===undefined&&candidate.correspondenceRevisionId===undefined)return true;
  return typeof candidate.portalSourceId==='string'&&PORTAL_SOURCE_PATTERN.test(candidate.portalSourceId)&&candidate.portalSourceId!==candidate.sourceId
    &&typeof candidate.correspondenceRevisionId==='string'&&REVISION_PATTERN.test(candidate.correspondenceRevisionId);
}
function validCurrentGrant(candidate:PortalCandidate):boolean{
  if(candidate.currentGrantId===undefined&&candidate.currentGrantRevision===undefined)return candidate.state!=='suspended';
  return typeof candidate.currentGrantId==='string'&&candidate.currentGrantId.length>0&&candidate.currentGrantId.length<=128
    &&Number.isSafeInteger(candidate.currentGrantRevision)&&(candidate.currentGrantRevision as number)>0;
}
function validPortalSetup(value:SharedProfile):boolean{
  const setup=value.portalSetup;
  return !!setup&&typeof setup.available==='boolean'&&Array.isArray(setup.candidates)&&setup.candidates.length<=64
    && setup.candidates.every(candidate=>!!candidate&&['workspaceId','sourceId','principalPublicId','targetPublicId','recordId','groupId','clientName'].every(field=>
      typeof (candidate as Record<string,unknown>)[field]==='string'&&((candidate as Record<string,unknown>)[field] as string).length>0&&((candidate as Record<string,unknown>)[field] as string).length<=512)
      && candidate.groupId===value.id&&['available','enabled','revoked','suspended'].includes(candidate.state)
      && validCorrespondencePair(candidate)&&validCurrentGrant(candidate)
      && value.members.some(member=>member.recordId===candidate.recordId&&member.sourceIds.includes(candidate.sourceId)))
    && new Set(setup.candidates.map(candidateKey)).size===setup.candidates.length;
}
function destinations(members: Member[]): string[] {
  return [...new Set(members.flatMap(member => member.sourceNames?.length ? member.sourceNames : member.sourceIds.map(sourceLabel)))];
}
async function transmit(request: FrozenRequest) {
  return api(request.path, { method: request.method, headers: { "Idempotency-Key": request.mutationId }, body: request.body });
}

/** One editor owns the reviewed shared revision; source record IDs stay internal. */
export function SharedDirectoryProfileEdit({ kind, recordId, allowPreparedAttempt = false }: {
  kind: Kind; recordId: string; allowPreparedAttempt?: boolean;
}) {
  return <SharedDirectoryProfileEditBound key={`${kind}\0${recordId}`} kind={kind} recordId={recordId} allowPreparedAttempt={allowPreparedAttempt} />;
}
function SharedDirectoryProfileEditBound({ kind, recordId, allowPreparedAttempt }: {
  kind: Kind; recordId: string; allowPreparedAttempt: boolean;
}) {
  const id = useId(), [response, setResponse] = useState<ProfileResponse | null>(null), [fields, setFields] = useState<ProfileForm>(EMPTY);
  const [error, setError] = useState(""), [success, setSuccess] = useState(""), [busy, setBusy] = useState(false);
  const [merging, setMerging] = useState(false), [query, setQuery] = useState(""), [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState(""), [preview, setPreview] = useState<Preview | null>(null);
  const [attempt, setAttempt] = useState<FrozenRequest | null>(null);
  const [ownerAttempt,setOwnerAttempt]=useState<{kind:'bootstrap'|'grant'|'revoke';key:string;request:FrozenRequest;expectedRevision?:number}|null>(null);
  const confirmingRevoke=useRef(false),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const load = async () => {
    const value = await api<ProfileResponse>(`${ENDPOINT}/records/${encodeURIComponent(recordId)}`);
    if (!value || !Object.hasOwn(value, "sharedProfile") || (value.sharedProfile !== null && !validProfile(value.sharedProfile, kind, recordId)))
      throw new Error("The current shared profile could not be verified. Refresh before editing.");
    setResponse(value);
    if (value.sharedProfile) setFields({ ...EMPTY, ...value.sharedProfile.profile } as ProfileForm);
    return value;
  };
  useEffect(() => { let active = true;
    void load().catch(caught => { if (active) { setResponse(null); setError(errorText(caught)); } });
    return () => { active = false; };
  }, [kind, recordId]);
  useEffect(() => {
    if (!merging || attempt) return;
    let active = true;
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ kind, q: query, excludeRecordId: recordId });
      void api<{ candidates: Candidate[] }>(`${ENDPOINT}/candidates?${params}`).then(value => {
        if (!active) return;
        if (!value || !Array.isArray(value.candidates) || value.candidates.some(candidate => !validMember(candidate)
          || candidate.kind !== kind || candidate.recordId === recordId || typeof candidate.name !== "string"))
          throw new Error("Profile choices could not be verified.");
        setCandidates(value.candidates);
      }).catch(caught => { if (active) { setCandidates([]); setError(errorText(caught)); } });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [merging, kind, query, recordId, attempt]);
  const refresh = async () => {
    if(ownerAttempt)return;
    setBusy(true); setError("");
    try { await load(); } catch (caught) { setResponse(null); setError(errorText(caught)); }
    finally { setBusy(false); }
  };
  const review = async () => {
    if (!selected || busy || attempt || ownerAttempt) return;
    setBusy(true); setError(""); setPreview(null);
    try {
      const value = await api<Preview>(`${ENDPOINT}/preview`, { method: "POST",
        body: JSON.stringify({ recordIds: [recordId, selected], primaryRecordId: recordId }) });
      if (!value || typeof value.previewToken !== "string" || value.kind !== kind || !Array.isArray(value.members)
        || value.members.length !== 2 || !value.members.every(validMember)
        || ![recordId, selected].every(record => value.members.some(member => member.recordId === record))
        || typeof value.canConfirm !== "boolean" || !validFields(value.profile, kind) || !Array.isArray(value.differences)
        || value.differences.some(field => typeof field !== "string") || !Number.isFinite(Date.parse(value.expiresAt))
        || Date.parse(value.expiresAt) <= Date.now()) throw new Error("The merge review could not be verified.");
      setPreview(value);
    } catch (caught) { setError(errorText(caught)); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (busy || ownerAttempt || (!attempt && (!preview || !preview.canConfirm || preview.differences?.length))) return;
    const mutationId = attempt?.mutationId ?? crypto.randomUUID();
    const request = attempt ?? { path: `${ENDPOINT}/confirm`, method: "POST" as const, mutationId,
      body: JSON.stringify({ mutationId, previewToken: preview!.previewToken }) };
    setAttempt(request); setBusy(true); setError(""); setSuccess("");
    try {
      await transmit(request); const current = await load();
      if (!current.sharedProfile) throw new Error("The merge acknowledgement is not available yet. Retry the same merge.");
      setAttempt(null); setMerging(false); setPreview(null); setSuccess("The two records now use one shared profile.");
    } catch (caught) { setError(`${errorText(caught)} Retry keeps the same merge request.`); }
    finally { setBusy(false); }
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const current = response?.sharedProfile;
    if (!current || busy || ownerAttempt || (!attempt && (current.delivery.state !== "acknowledged" || current.editing?.available === false))) return;
    const mutationId = attempt?.mutationId ?? crypto.randomUUID();
    const request = attempt ?? { path: `${ENDPOINT}/${encodeURIComponent(current.id)}`, method: "PATCH" as const, mutationId,
      body: JSON.stringify({ mutationId, expectedVersion: current.version,
        expectedMembers: current.members.map(member => ({ recordId: member.recordId, version: member.version })),
        profile: serializeNativeDirectoryProfile(kind, fields, "update") }) };
    setAttempt(request); setBusy(true); setError(""); setSuccess("");
    try {
      await transmit(request); await load(); setAttempt(null); setSuccess("Saved. Project Alpha synchronization status is shown below.");
    } catch (caught) { setError(`${errorText(caught)} Retry sends the same saved request.`); }
    finally { setBusy(false); }
  };
  const bootstrap=async()=>{
    if(busy||attempt||(!ownerAttempt&&!response?.canBootstrap)||ownerAttempt&&ownerAttempt.kind!=='bootstrap')return;
    const mutationId=ownerAttempt?.request.mutationId??crypto.randomUUID();
    const current=ownerAttempt??{kind:'bootstrap' as const,key:recordId,request:{path:`${ENDPOINT}/bootstrap`,method:'POST' as const,mutationId,body:JSON.stringify({recordId,mutationId})}};
    setOwnerAttempt(current);setBusy(true);setError('');setSuccess('');
    try{await transmit(current.request);const loaded=await load();if(!loaded.sharedProfile)throw new Error('The shared profile acknowledgement is not available yet.');
      setOwnerAttempt(null);setSuccess('The shared profile is ready to review for portal editing.');}
    catch(caught){setError(`${errorText(caught)} Retry keeps the same profile setup request.`);}finally{setBusy(false);}
  };
  const enablePortal=async(candidate:PortalCandidate)=>{
    const key=candidateKey(candidate);
    if(busy||attempt||ownerAttempt&&(ownerAttempt.kind!=='grant'||ownerAttempt.key!==key)
      ||!ownerAttempt&&(!response?.sharedProfile?.portalSetup?.available||candidate.state!=='available'))return;
    const operationId=ownerAttempt?.request.mutationId??crypto.randomUUID(),grantId=ownerAttempt?null:crypto.randomUUID();
    const current=ownerAttempt??{kind:'grant' as const,key,request:{path:`${ENDPOINT}/portal-grants`,method:'POST' as const,mutationId:operationId,
      body:JSON.stringify({operationId,id:grantId,workspaceId:candidate.workspaceId,sourceId:candidate.sourceId,
        ...(candidate.portalSourceId?{portalSourceId:candidate.portalSourceId,correspondenceRevisionId:candidate.correspondenceRevisionId}:{}),
        recipientMode:'first_verified_identity',issuer:null,subject:null,
        principalPublicId:candidate.principalPublicId,targetType:'client',targetPublicId:candidate.targetPublicId,recordId:candidate.recordId,groupId:candidate.groupId,expectedRevision:0,state:'active'})}};
    setOwnerAttempt(current);setBusy(true);setError('');setSuccess('');
    try{const result=await transmit(current.request) as {ok?:boolean;revision?:number};if(result?.ok!==true||result.revision!==1)throw new Error('The portal editing acknowledgement could not be verified.');
      await load();setOwnerAttempt(null);setSuccess('Portal profile editing permission saved.');}
    catch(caught){setError(`${errorText(caught)} Retry keeps the same portal permission request.`);}finally{setBusy(false);}
  };
  const revokePortal=async(candidate:PortalCandidate)=>{
    const key=candidateKey(candidate),frozen=ownerAttempt?.kind==='revoke'&&ownerAttempt.key===key?ownerAttempt:null;
    if(busy||attempt||confirmingRevoke.current||ownerAttempt&&!frozen)return;
    if(!frozen){
      if(!response?.sharedProfile?.portalSetup?.available||(candidate.state!=='enabled'&&candidate.state!=='suspended')
        ||!candidate.currentGrantId||!Number.isSafeInteger(candidate.currentGrantRevision)||candidate.currentGrantRevision!<1)return;
      confirmingRevoke.current=true;
      const choice=await requestChoice({title:'Turn off portal profile editing?',
        description:`${candidate.clientName} will no longer be able to edit their own profile from the client portal. Their profile, records and other access are unchanged.`,
        choices:[{value:'revoke',label:'Turn off editing',tone:'danger'}]}).finally(()=>{confirmingRevoke.current=false;});
      // The editor is keyed by record, so a context change unmounts it; never submit from an obsolete editor.
      if(choice!=='revoke'||!mounted.current)return;
    }
    const expectedRevision=frozen?.expectedRevision??candidate.currentGrantRevision!,operationId=frozen?.request.mutationId??crypto.randomUUID();
    const current=frozen??{kind:'revoke' as const,key,expectedRevision,request:{path:`${ENDPOINT}/portal-grants`,method:'POST' as const,mutationId:operationId,
      body:JSON.stringify({operationId,id:candidate.currentGrantId,workspaceId:candidate.workspaceId,sourceId:candidate.sourceId,
        ...(candidate.portalSourceId?{portalSourceId:candidate.portalSourceId,correspondenceRevisionId:candidate.correspondenceRevisionId}:{}),
        recipientMode:'first_verified_identity',issuer:null,subject:null,
        principalPublicId:candidate.principalPublicId,targetType:'client',targetPublicId:candidate.targetPublicId,recordId:candidate.recordId,groupId:candidate.groupId,expectedRevision,state:'revoked'})}};
    setOwnerAttempt(current);setBusy(true);setError('');setSuccess('');
    try{const result=await transmit(current.request) as {ok?:boolean;revision?:number};if(result?.ok!==true||result.revision!==expectedRevision+1)throw new Error('The portal editing change could not be verified.');
      await load();setOwnerAttempt(null);setSuccess('Portal profile editing turned off.');}
    catch(caught){
      if(caught instanceof ApiError&&caught.status>=400&&caught.status<500&&caught.status!==429){setOwnerAttempt(null);setError(`${errorText(caught)} The current portal editing permission could not be confirmed. Refresh to review it.`);}
      else setError(`${errorText(caught)} Retry keeps the same turn-off request.`);}
    finally{setBusy(false);}
  };
  if (!response) return <Card title="Client profile"><p role={error ? "alert" : "status"}>{error || "Loading profile…"}</p>
    {error && <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh profile</button>}</Card>;
  const shared = response.sharedProfile;
  const field = (key: keyof ProfileForm, label: string, maxLength: number, required = false) => <label htmlFor={`${id}-${key}`}>{label}
    <input id={`${id}-${key}`} maxLength={maxLength} required={required} value={fields[key]}
      disabled={busy || !!attempt || !!ownerAttempt || shared?.delivery.state !== "acknowledged" || shared?.editing?.available === false
        || (key === "email" && shared?.emailEditing === false)}
      onChange={event => { const value = event.target.value; setFields(previous => ({ ...previous, [key]: value })); }} /></label>;
  return <>
    {response.canMerge && <SharedProfileAuthorityRecovery />}
    {!shared && <NativeDirectoryProfileEdit kind={kind} recordId={recordId} allowPreparedAttempt={allowPreparedAttempt} />}
    {shared && <Card title="Shared client profile"><p>One profile synchronized with {destinations(shared.members).join(" and ")}.</p>
      <StatusPill tone={shared.delivery.state === "acknowledged" ? "success" : "warning"}>{shared.delivery.state === "acknowledged"
        ? shared.delivery.destinations?.length === 0 ? "Shared profile linked" : "Updated in all connected PAs"
        : shared.delivery.state === "conflict" ? "Synchronization needs review" : "Synchronizing with Project Alpha"}</StatusPill>
      <form onSubmit={event => void save(event)}><div className="client-directory-profile-fields">
        {field("name", kind === "organization" ? "Organization name" : "Client name", 150, true)}
        {kind === "organization" ? <>{field("generalEmail", "General email", 255)}{field("generalPhone", "General phone", 50)}</>
          : <>{field("email", "Contact email", 255)}{field("phone", "Phone", 50)}</>}
        {field("addressLine1", "Address line 1", 255)}{field("addressLine2", "Address line 2", 255)}
        {field("city", "City", 150)}{field("state", "State", 150)}{field("postalCode", "Postal code", 30)}{field("country", "Country", 100)}
      </div><button className="button-orange" disabled={busy || !!ownerAttempt || (!attempt && (shared.delivery.state !== "acknowledged" || shared.editing?.available === false))}>{busy ? "Saving…"
        : attempt ? "Retry same shared-profile update" : "Save shared profile"}</button></form>
      <button type="button" className="button-ghost" disabled={busy||!!ownerAttempt} onClick={() => void refresh()}>Refresh synchronization status</button>
    </Card>}
    {!shared&&kind==='client'&&response.canBootstrap&&<Card title="Portal profile setup"><p>Use this client’s profile for portal editing. Merge a duplicate in the other PA first.</p>
      <button type="button" className="button-orange" disabled={busy||!!attempt||!!ownerAttempt&&ownerAttempt.kind!=='bootstrap'} onClick={()=>void bootstrap()}>{ownerAttempt?.kind==='bootstrap'?'Retry same profile setup':'Enable shared profile'}</button></Card>}
    {shared?.kind==='client'&&shared.portalSetup&&<Card title="Portal profile editing"><p>Enable each client’s own profile for their verified portal sign-in.</p>
      {!shared.portalSetup.available&&<p role="status">Portal profile setup isn’t available from this account right now. Staff with client portal setup access can review it.</p>}
      {shared.portalSetup.candidates.length===0?shared.portalSetup.available&&<p>No eligible own-client portal identity is available yet.</p>:shared.portalSetup.candidates.map(candidate=><div key={candidateKey(candidate)}>
        <p><strong>{candidate.clientName}</strong> · {sourceLabel(candidate.sourceId)}</p>
        {candidate.state==='available'?<button type="button" className="button-orange" disabled={busy||!!attempt||!shared.portalSetup?.available||!!ownerAttempt&&ownerAttempt.key!==candidateKey(candidate)} onClick={()=>void enablePortal(candidate)}>
          {ownerAttempt?.kind==='grant'&&ownerAttempt.key===candidateKey(candidate)?'Retry same portal permission':'Enable portal profile editing'}</button>
          :<p role="status">{candidate.state==='enabled'?'Profile editing enabled for verified sign-in.'
            :candidate.state==='suspended'?'Paused for review: the client workspace connection changed. Review it on the Project Alpha connections page before portal editing can resume.'
            :'Portal profile editing permission is revoked.'}</p>}
        {(candidate.state==='enabled'||candidate.state==='suspended')&&candidate.currentGrantId&&<button type="button" className="button-ghost"
          disabled={busy||!!attempt||!shared.portalSetup?.available||!!ownerAttempt&&!(ownerAttempt.kind==='revoke'&&ownerAttempt.key===candidateKey(candidate))}
          onClick={()=>void revokePortal(candidate)}>{ownerAttempt?.kind==='revoke'&&ownerAttempt.key===candidateKey(candidate)?'Retry same turn-off':'Turn off portal profile editing'}</button>}
      </div>)}
    </Card>}
    {!shared && response.canMerge && <Card title="Shared profile"><p>Merge this profile with its reviewed copy in another Project Alpha.</p>
      {!merging ? <button type="button" disabled={busy||!!ownerAttempt} onClick={() => { setMerging(true); setError(""); }}>Merge with another PA profile</button>
        : <div className="shared-profile-merge"><label htmlFor={`${id}-search`}>Find the other profile<input id={`${id}-search`} value={query}
          disabled={busy || !!attempt || !!ownerAttempt} onChange={event => { setQuery(event.target.value); setSelected(""); setPreview(null); }} /></label>
          <label htmlFor={`${id}-candidate`}>Profile to merge<select id={`${id}-candidate`} value={selected} disabled={busy || !!attempt || !!ownerAttempt}
            onChange={event => { setSelected(event.target.value); setPreview(null); }}><option value="">Choose a profile</option>
            {candidates.map(candidate => <option key={candidate.recordId} value={candidate.recordId}>{candidate.name} · {destinations([candidate]).join(", ")}
              {candidate.parentName ? ` · ${candidate.parentName}` : ""}</option>)}</select></label>
          <button type="button" disabled={busy || !!attempt || !!ownerAttempt || !selected} onClick={() => void review()}>Review merge</button>
          {preview && <div><p>Both records will use the same {kind === "organization" ? "organization" : "client"} profile across {destinations(preview.members).join(" and ")}.</p>
            <dl className="shared-profile-review">{Object.entries(preview.profile).filter(([, value]) => value).map(([field, value]) =>
              <div key={field}><dt>{field.replace(/([A-Z])/g, " $1").replace(/^./, letter => letter.toUpperCase())}</dt><dd>{value}</dd></div>)}</dl>
            <p>Documents, source histories, and existing access stay attached to their current PA records.</p>
            {preview.differences?.length ? <p role="alert">Resolve these differences before merging: {preview.differences.join(", ")}.</p>
              : <button type="button" className="button-orange" disabled={busy || !!ownerAttempt || !preview.canConfirm} onClick={() => void confirm()}>{attempt ? "Retry same merge" : "Confirm shared profile"}</button>}
          </div>}
        </div>}
    </Card>}
    {error && <p role="alert">{error}</p>}{success && <p role="status">{success}</p>}
  </>;
}
