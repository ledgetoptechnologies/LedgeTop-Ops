import { useState } from "react";
import { Card } from "@ltds/ui";
import { api, setCsrf } from "./api";
import { isProjectReplayAcceptanceLocation } from "./ProjectReplayAcceptanceRoute";

export const PROJECT_COMMANDS_PATH = "/api/admin/project-alpha/projects/v2/commands";
export const PROJECT_PREPARATION_PATH = "/api/admin/staging/projects/v2/preparation";
const SOURCE = "project-alpha:staging";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/,PUBLIC_ID=/^[0-9a-f]{32}$/,DECIMAL=/^(?:0|[1-9][0-9]{0,18})$/;
type Requester = typeof api;
type LocationShape = Pick<Location, "protocol" | "hostname" | "port" | "pathname">;
export type ProjectAcceptanceSelection = { sourceId: typeof SOURCE; expectedApplicationId: string; externalProjectId: string;
  organizationRecordId: string; clientRecordId: string | null; project: { name: string; description: string | null;
    estimatedStart: string | null; estimatedEnd: string | null }; scopes: Array<{ scopeKind: "business_area" | "division";
      businessAreaId: string; divisionId: string | null }> };
type Prepared = { stage: "create" | "update"; preparationId: string; sourceId: typeof SOURCE; externalProjectId: string;
  currentVersion: number; currentName: string | null; currentProject: ProjectAcceptanceSelection["project"] | null;
  request: Record<string, unknown> & { operation: "create" | "update";
    command: Record<string, unknown> & { externalId: string; project: { name: string; description: string | null;
      estimatedStart: string | null; estimatedEnd: string | null } } } };
type Frozen = { stage: "create" | "update"; key: string; body: string; conflictBody: string; externalId: string;
  expectedVersion: number; targetProject: ProjectAcceptanceSelection["project"];
  phase: "command" | "replay" | "conflict" | "readback" };

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function normalizePreparation(value: unknown, stage: "create" | "update", selection: ProjectAcceptanceSelection): Prepared | null {
  if (!plain(value) || value.status !== "prepared" || !plain(value.preparation)) return null;
  const p=value.preparation;
  if(p.operation!==stage||p.sourceId!==SOURCE||p.expectedApplicationId!==selection.expectedApplicationId
    ||p.externalProjectId!==selection.externalProjectId||!Array.isArray(p.scopes)
    ||JSON.stringify(p.scopes)!==JSON.stringify(selection.scopes)||!plain(p.local))return null;
  if(stage==="create"){
    if(typeof p.expectedAuthorizationGeneration!=="string"||!DECIMAL.test(p.expectedAuthorizationGeneration)
      ||p.local.expectedLocalVersion!==0||p.local.expectedLocalProjectionSha256!==null
      ||!plain(p.directory)||p.directory.organizationRecordId!==selection.organizationRecordId
      ||p.directory.clientRecordId!==selection.clientRecordId||!plain(p.organization)
      ||typeof p.organization.externalId!=="string"||!p.organization.externalId
      ||typeof p.organization.expectedPublicId!=="string"||!PUBLIC_ID.test(p.organization.expectedPublicId)
      ||typeof p.organization.expectedRevision!=="string"||!DECIMAL.test(p.organization.expectedRevision)
      ||typeof p.organization.expectedProjectionSha256!=="string"||!HASH.test(p.organization.expectedProjectionSha256)
      ||(selection.clientRecordId===null?p.client!==null:!plain(p.client)))return null;
    if(plain(p.client)&&(typeof p.client.externalId!=="string"||!p.client.externalId
      ||typeof p.client.expectedPublicId!=="string"||!PUBLIC_ID.test(p.client.expectedPublicId)
      ||typeof p.client.expectedRevision!=="string"||!DECIMAL.test(p.client.expectedRevision)
      ||typeof p.client.expectedProjectionSha256!=="string"||!HASH.test(p.client.expectedProjectionSha256)))return null;
    const request={sourceId:SOURCE,expectedApplicationId:selection.expectedApplicationId,operation:"create" as const,scopes:p.scopes,local:p.local,
      directory:p.directory,command:{externalId:selection.externalProjectId,expectedAuthorizationGeneration:p.expectedAuthorizationGeneration,
        project:selection.project,organization:p.organization,client:p.client??null}};
    return {stage,preparationId:crypto.randomUUID(),sourceId:SOURCE,externalProjectId:selection.externalProjectId,
      currentVersion:0,currentName:null,currentProject:null,request};
  }
  if(!Number.isSafeInteger(p.local.expectedLocalVersion)||Number(p.local.expectedLocalVersion)<1
    ||typeof p.local.expectedLocalProjectionSha256!=="string"||!HASH.test(p.local.expectedLocalProjectionSha256)
    ||typeof p.expectedRevision!=="string"||!DECIMAL.test(p.expectedRevision)
    ||typeof p.expectedProjectionSha256!=="string"||!HASH.test(p.expectedProjectionSha256)
    ||typeof p.expectedAuthorizationGeneration!=="string"||!DECIMAL.test(p.expectedAuthorizationGeneration)
    ||typeof p.expectedPublicId!=="string"||!PUBLIC_ID.test(p.expectedPublicId)
    ||!plain(p.project)||typeof p.project.name!=="string"
    ||!(p.project.description===null||typeof p.project.description==="string")
    ||!(p.project.estimatedStart===null||typeof p.project.estimatedStart==="string")
    ||!(p.project.estimatedEnd===null||typeof p.project.estimatedEnd==="string"))return null;
  const project={name:`${p.project.name.slice(0,120)} updated`,description:p.project.description as string|null,
    estimatedStart:p.project.estimatedStart as string|null,estimatedEnd:p.project.estimatedEnd as string|null};
  const request={sourceId:SOURCE,expectedApplicationId:selection.expectedApplicationId,operation:"update" as const,scopes:p.scopes,local:p.local,
    command:{externalId:selection.externalProjectId,expectedRevision:p.expectedRevision,expectedProjectionSha256:p.expectedProjectionSha256,
      expectedAuthorizationGeneration:p.expectedAuthorizationGeneration,project}};
  return {stage,preparationId:crypto.randomUUID(),sourceId:SOURCE,externalProjectId:selection.externalProjectId,
    currentVersion:Number(p.local.expectedLocalVersion),currentName:String(p.project.name),
    currentProject:{name:p.project.name,description:p.project.description as string|null,estimatedStart:p.project.estimatedStart as string|null,
      estimatedEnd:p.project.estimatedEnd as string|null},request};
}
function activated(value: unknown, frozen: Frozen, replayed: boolean): boolean {
  if (!plain(value) || value.sourceId !== SOURCE || value.stage !== "activate" || !plain(value.outcome)) return false;
  const outcome = value.outcome;
  return outcome.status === "activated" && outcome.commandId === frozen.key && outcome.externalProjectId === frozen.externalId
    && outcome.version === frozen.expectedVersion && outcome.replayed === replayed;
}
function conflict(value: unknown): boolean {
  return plain(value) && value.sourceId === SOURCE && value.stage === "plan" && plain(value.outcome)
    && value.outcome.status === "conflict" && value.outcome.reason === "command_id";
}

export function ProjectReplayAcceptance({ request = api, location = window.location,
  applyCsrf = setCsrf, selection }: { request?: Requester; location?: LocationShape; applyCsrf?: (value: string) => void;
    selection?: ProjectAcceptanceSelection }) {
  const [prep, setPrep] = useState<Prepared | null>(null), [attempt, setAttempt] = useState<Frozen | null>(null);
  const [confirmId, setConfirmId] = useState(""), [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [done, setDone] = useState<string[]>([]);
  const [reviewed,setReviewed]=useState<ProjectAcceptanceSelection|null>(null);
  const [draft,setDraft]=useState({expectedApplicationId:"",externalProjectId:"ops/project-acceptance-",organizationRecordId:"",
    clientRecordId:"",name:"Synthetic Project Acceptance",businessAreaId:"",divisionId:""});
  const selected=selection??reviewed;
  if (!isProjectReplayAcceptanceLocation(location)) return null;

  const prepare = async (stage: "create" | "update", externalProjectId?: string) => {
    setBusy(true); setError(""); setAttempt(null);
    try {
      applyCsrf("");
      if(!selected)throw new Error("An explicitly reviewed synthetic Project selection is required.");
      const session = await request<unknown>("/api/session");
      if (!plain(session) || typeof session.csrfToken !== "string" || session.csrfToken.length < 16
        || !plain(session.user) || session.user.isAdministrator !== true || typeof session.user.id!=="string" || !session.user.id)
        throw new Error("The authenticated Operations session could not be verified.");
      applyCsrf(session.csrfToken);
      const preparationRequest=stage==="create"?{operation:"create",sourceId:selected.sourceId,expectedApplicationId:selected.expectedApplicationId,
        externalProjectId:selected.externalProjectId,organizationRecordId:selected.organizationRecordId,clientRecordId:selected.clientRecordId,scopes:selected.scopes}
        :{operation:"update",sourceId:selected.sourceId,expectedApplicationId:selected.expectedApplicationId,externalProjectId:selected.externalProjectId,scopes:selected.scopes};
      const raw = await request<unknown>(PROJECT_PREPARATION_PATH, { method: "POST",body:JSON.stringify(preparationRequest) });
      const value=normalizePreparation(raw,stage,selected);
      if (!value || (externalProjectId && value.externalProjectId !== externalProjectId))
        throw new Error("The server-derived Project acceptance fences could not be verified.");
      setPrep(value); setConfirmId(""); setConfirmName("");
    } catch (caught) { setPrep(null); setError(caught instanceof Error ? caught.message : "Preparation failed."); }
    finally { setBusy(false); }
  };
  const post = (body: string, key: string) => request<unknown>(PROJECT_COMMANDS_PATH,
    { method: "POST", headers: { "Idempotency-Key": key }, body });
  const advance = async (current: Frozen) => {
    if (current.phase === "command") {
      const value = await post(current.body, current.key);
      if (!activated(value, current, false) && !activated(value, current, true)) throw new Error("The Project command result was not an exact activation.");
      return { ...current, phase: "replay" as const };
    }
    if (current.phase === "replay") {
      if (!activated(await post(current.body, current.key), current, true)) throw new Error("The exact Project replay was not verified.");
      return { ...current, phase: "conflict" as const };
    }
    if (current.phase === "conflict") {
      if (!conflict(await post(current.conflictBody, current.key))) throw new Error("The changed-body Project conflict was not verified.");
      return { ...current, phase: "readback" as const };
    }
    if(!selected)throw new Error("The reviewed Project selection is unavailable.");
    const raw = await request<unknown>(PROJECT_PREPARATION_PATH, { method: "POST",body:JSON.stringify({operation:"update",sourceId:selected.sourceId,
      expectedApplicationId:selected.expectedApplicationId,externalProjectId:current.externalId,scopes:selected.scopes}) });
    const value=normalizePreparation(raw,"update",selected);
    if (!value || value.externalProjectId !== current.externalId || value.currentVersion !== current.expectedVersion
      || !value.currentProject || JSON.stringify(value.currentProject)!==JSON.stringify(current.targetProject))
      throw new Error("The server-derived current Project fences did not confirm the activation.");
    setPrep(value); setDone(previous => [...previous, current.stage]);
    return null;
  };
  const run = async () => {
    if (!prep || busy) return;
    let current = attempt;
    if (!current) {
      if (confirmId !== prep.externalProjectId || confirmName !== (prep.currentName ?? prep.request.command.project.name))
        return setError("Confirm the exact external project ID and displayed project name.");
      const key = crypto.randomUUID(), command = { ...prep.request.command, commandId: key };
      const envelope = { ...prep.request, command }, body = JSON.stringify(envelope);
      const changed = { ...envelope, command: { ...command, project: { ...command.project,
        name: `${String(command.project.name).slice(0, 120)} conflict` } } };
      current = { stage: prep.stage, key, body, conflictBody: JSON.stringify(changed), externalId: prep.externalProjectId,
        expectedVersion: prep.currentVersion + 1, targetProject:command.project, phase: "command" }; setAttempt(current);
    }
    setBusy(true); setError("");
    try { setAttempt(await advance(current)); }
    catch (caught) { setError(`${caught instanceof Error ? caught.message : "Project acceptance step failed."} Retry retains the exact command ID and bytes.`); }
    finally { setBusy(false); }
  };
  const freezeSelection=()=>{
    if(!UUID.test(draft.expectedApplicationId)||!draft.externalProjectId.startsWith("ops/project-acceptance-")||draft.externalProjectId.length>191
      ||!draft.organizationRecordId||!draft.name.startsWith("Synthetic ")||draft.name.length>150||!draft.businessAreaId)
      return setError("Review the exact application, organization, bounded synthetic project ID/name, and business scope.");
    setReviewed({sourceId:SOURCE,expectedApplicationId:draft.expectedApplicationId,externalProjectId:draft.externalProjectId,
      organizationRecordId:draft.organizationRecordId,clientRecordId:draft.clientRecordId||null,
      project:{name:draft.name,description:null,estimatedStart:null,estimatedEnd:null},scopes:[draft.divisionId
        ?{scopeKind:"division",businessAreaId:draft.businessAreaId,divisionId:draft.divisionId}
        :{scopeKind:"business_area",businessAreaId:draft.businessAreaId,divisionId:null}]});setError("");
  };
  return <main className="page"><Card title="Staging Project replay acceptance">
    <p>This staging-only tool uses server-derived fences. Completing this browser sequence still requires independent live staging evidence.</p>
    {!selected&&<div><p>No global scope is available: choose an exact business area or division.</p>
      {Object.entries(draft).map(([key,value])=><label key={key}>{key}<input value={value} disabled={Boolean(reviewed)}
        onChange={event=>setDraft(previous=>({...previous,[key]:event.target.value}))}/></label>)}
      <button onClick={freezeSelection}>Freeze reviewed synthetic selection</button></div>}
    {selected&&!prep && <button disabled={busy} onClick={() => void prepare("create")}>Load create preparation</button>}
    {prep && <><p>{prep.stage === "create" ? "Create" : "Update"} · {prep.externalProjectId} · current version {prep.currentVersion}</p>
      <label>Confirm exact external project ID<input value={confirmId} disabled={Boolean(attempt)} onChange={event => setConfirmId(event.target.value)} /></label>
      <label>Confirm displayed project name<input value={confirmName} disabled={Boolean(attempt)} onChange={event => setConfirmName(event.target.value)} /></label>
      <button disabled={busy} onClick={() => void run()}>{attempt ? "Retry same frozen Project step" : `Start reviewed ${prep.stage}`}</button></>}
    {done.includes("update") && <p role="status">Create and update replay/conflict browser sequence completed. Independent PA readback and live staging evidence are still required.</p>}
    {error && <p role="alert">{error}</p>}
  </Card></main>;
}
