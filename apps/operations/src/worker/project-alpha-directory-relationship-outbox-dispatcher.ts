import {
  isProjectAlphaDirectoryRelationshipCommand,
  sendProjectAlphaDirectoryOrganizationRelationshipCommand,
  validatedProjectAlphaDirectoryCommandAcknowledgement,
  type ProjectAlphaDirectoryRelationshipCommand,
  type ProjectAlphaDirectoryRelationshipSuccess,
} from "./project-alpha-directory-relationship-api-v2";
import { withEnabledConfiguredProjectAlphaApiV2Connection, type ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";
import type { ProjectAlphaApiV2Connection } from "./project-alpha-api-v2";
import { validateDirectoryRelationshipRecoveryReservation } from "./project-alpha-directory-relationship-generation-recovery";
import {
  claimEffectiveRelationshipCommand,
  isEffectiveRelationshipCommandLive,
  loadEffectiveRelationshipCommand,
  releaseEffectiveRelationshipCommand,
  settleEffectiveRelationshipCommand,
  type EffectiveRelationshipCommandRow,
  type ProjectAlphaDirectoryRelationshipCommandKind,
} from "./project-alpha-directory-effective-relationship-commands";

const LEASE_MS=5*60_000, MAX_RETRY_MS=60*60_000;
type Environment=ProjectAlphaApiV2ConnectionEnvironment & Readonly<{ OPS_DB:D1Database;
  PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED?:string }>;
type Row=EffectiveRelationshipCommandRow;

export type ProjectAlphaDirectoryRelationshipDispatcherOutcome=
  | Readonly<{status:"acknowledged";commandId:string;replayed:boolean;clientPublicId:string;revision:string}>
  | Readonly<{status:"conflict";reason:"source"|"command"|"remote";httpStatus?:number;requestId?:string}>
  | Readonly<{status:"blocked";reason:"configuration"|"authority"|"destination"|"not_due"|"in_progress"}>
  | Readonly<{status:"uncertain";reason:string;httpStatus?:number;requestId?:string}>;

function origin(value:unknown):string|null{try{return typeof value==="string"?new URL(value).origin:null;}catch{return null;}}
function parse(value:string):Record<string,unknown>|null{try{const result=JSON.parse(value);return result&&typeof result==="object"&&!Array.isArray(result)?result:null;}catch{return null;}}
function exactDestination(row:Row,connection:ProjectAlphaApiV2Connection):boolean{return row.source_instance_id===connection.expectedSourceInstanceId
  &&row.application_id===connection.expectedApplicationId&&row.history_epoch_id===connection.expectedHistoryEpoch
  &&origin(row.destination_origin)===origin(connection.baseUrl);}
function replay(row:Row):ProjectAlphaDirectoryRelationshipDispatcherOutcome|null{
  if(row.state!=="acknowledged"&&row.state!=="terminal")return null;
  const outcome=row.outcome_json?parse(row.outcome_json):null;
  if(row.state==="terminal")return{status:"conflict",reason:"remote",
    ...(typeof outcome?.httpStatus==="number"?{httpStatus:outcome.httpStatus}:{}),...(typeof outcome?.requestId==="string"?{requestId:outcome.requestId}:{})};
  const response=outcome&&typeof outcome.response==="object"&&outcome.response!==null&&!Array.isArray(outcome.response)
    ?outcome.response as Record<string,unknown>:null;
  const result=response&&typeof response.result==="object"&&response.result!==null&&!Array.isArray(response.result)
    ?response.result as Record<string,unknown>:null;
  const client=result&&typeof result.client==="object"&&result.client!==null&&!Array.isArray(result.client)
    ?result.client as Record<string,unknown>:null;
  return client&&typeof client.publicId==="string"&&typeof client.revision==="string"
    ?{status:"acknowledged",commandId:row.command_id,replayed:true,clientPublicId:client.publicId,revision:client.revision}
    :{status:"uncertain",reason:"evidence"};
}
async function release(db:D1Database,kind:ProjectAlphaDirectoryRelationshipCommandKind,row:Row,token:string,now:number):Promise<void>{
  const delay=Math.min(MAX_RETRY_MS,1_000*2**Math.min(12,Math.max(0,row.attempts)));
  await releaseEffectiveRelationshipCommand(db,kind,row,token,now+delay,now);}

/** Dispatches exactly one pre-reserved relationship command.  No route,
 * scheduler, or profile materialization imports this private boundary. */
export async function dispatchProjectAlphaDirectoryRelationshipCommand(env:Environment,sourceId:string,commandId:string,
  send:typeof fetch=fetch,kind:ProjectAlphaDirectoryRelationshipCommandKind="normal"):Promise<ProjectAlphaDirectoryRelationshipDispatcherOutcome>{
  if(kind==="generation_recovery"&&env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED!=="true")
    return{status:"blocked",reason:"configuration"};
  const initial=await loadEffectiveRelationshipCommand(env.OPS_DB,kind,commandId);if(!initial)return{status:"blocked",reason:"in_progress"};
  if(initial.source_id!==sourceId)return{status:"conflict",reason:"source"};const completed=replay(initial);if(completed)return completed;
  const selected=await withEnabledConfiguredProjectAlphaApiV2Connection(env,sourceId,async connection=>{
    if(!exactDestination(initial,connection))return{phase:"invalid" as const,reason:"destination" as const};
    if(!await isEffectiveRelationshipCommandLive(env.OPS_DB,kind,commandId)
      ||kind==="generation_recovery"&&!await validateDirectoryRelationshipRecoveryReservation(env,commandId))
      return{phase:"invalid" as const,reason:"authority" as const};
    let command:ProjectAlphaDirectoryRelationshipCommand;try{command=JSON.parse(initial.command_json) as ProjectAlphaDirectoryRelationshipCommand;}catch{return{phase:"invalid" as const,reason:"command" as const};}
    if(!isProjectAlphaDirectoryRelationshipCommand(initial.action,command))return{phase:"invalid" as const,reason:"command" as const};
    const now=Date.now();if(initial.state==="pending"&&initial.next_attempt_at>now)return{phase:"blocked" as const,reason:"not_due" as const};
    if(initial.state==="leased"&&(initial.lease_expires_at===null||initial.lease_expires_at>now))return{phase:"blocked" as const,reason:"in_progress" as const};
    if(initial.state!=="pending"&&initial.state!=="leased")return{phase:"blocked" as const,reason:"in_progress" as const};
    const token=crypto.randomUUID();const claimed=await claimEffectiveRelationshipCommand(env.OPS_DB,kind,commandId,initial.command_json,token,now,now+LEASE_MS);
    if(!claimed)return{phase:"blocked" as const,reason:"in_progress" as const};
    const leased=await loadEffectiveRelationshipCommand(env.OPS_DB,kind,commandId);
    const authorized=!!leased&&await isEffectiveRelationshipCommandLive(env.OPS_DB,kind,commandId)
      &&(kind==="normal"||env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED==="true"
        &&await validateDirectoryRelationshipRecoveryReservation(env,commandId));
    if(!leased||!exactDestination(leased,connection)||!authorized){if(leased)await release(env.OPS_DB,kind,leased,token,Date.now());return{phase:"invalid" as const,reason:!leased?"command" as const:!exactDestination(leased,connection)?"destination" as const:"authority" as const};}
    const outcome=await sendProjectAlphaDirectoryOrganizationRelationshipCommand(connection,leased.client_public_id,leased.action,command,send);
    if(outcome.status!=="acknowledged"){
      if(outcome.status==="conflict"){
        const saved=JSON.stringify({directoryRelationshipDispatcher:"conflict",reason:outcome.reason,
          ...(outcome.httpStatus?{httpStatus:outcome.httpStatus}:{}),...(outcome.requestId?{requestId:outcome.requestId}:{})});
        const settled=await settleEffectiveRelationshipCommand(env.OPS_DB,kind,commandId,token,Date.now(),"terminal",saved);
        return settled?{phase:"conflict" as const,httpStatus:outcome.httpStatus,requestId:outcome.requestId}
          :{phase:"uncertain" as const,reason:"lost_lease"};
      }
      await release(env.OPS_DB,kind,leased,token,Date.now());return{phase:"uncertain" as const,reason:outcome.reason,
        ...(outcome.httpStatus?{httpStatus:outcome.httpStatus}:{}),...(outcome.requestId?{requestId:outcome.requestId}:{})};
    }
    const evidence=validatedProjectAlphaDirectoryCommandAcknowledgement<ProjectAlphaDirectoryRelationshipSuccess>(outcome);
    if(!evidence||JSON.stringify(evidence.command)!==initial.command_json||origin(evidence.destinationOrigin)!==origin(leased.destination_origin)){
      await release(env.OPS_DB,kind,leased,token,Date.now());return{phase:"uncertain" as const,reason:"evidence"};}
    // Normal commands retain their historical post-send live-authority fence.
    // A recovery acknowledgement, however, is provider proof after the remote
    // mutation boundary: later local revocation must not discard that proof.
    if(!exactDestination(leased,connection)||(kind==="normal"&&!await isEffectiveRelationshipCommandLive(env.OPS_DB,kind,commandId))){
      await release(env.OPS_DB,kind,leased,token,Date.now());return{phase:"invalid" as const,reason:"authority" as const};}
    const outcomeJson=JSON.stringify({status:"acknowledged",response:evidence.response});
    const settled=await settleEffectiveRelationshipCommand(env.OPS_DB,kind,commandId,token,Date.now(),"acknowledged",outcomeJson);
    return settled?{phase:"acknowledged" as const,response:evidence.response}:{phase:"uncertain" as const,reason:"lost_lease"};
  });
  if(selected.status!=="enabled")return{status:"blocked",reason:"configuration"};const result=selected.value;
  if(result.phase==="acknowledged")return{status:"acknowledged",commandId,replayed:result.response.replayed,
    clientPublicId:result.response.result.client.publicId,revision:result.response.result.client.revision};
  if(result.phase==="conflict")return{status:"conflict",reason:"remote",...(result.httpStatus?{httpStatus:result.httpStatus}:{}),...(result.requestId?{requestId:result.requestId}:{})};
  if(result.phase==="uncertain")return{status:"uncertain",reason:result.reason,...("httpStatus" in result&&result.httpStatus?{httpStatus:result.httpStatus}:{}),...("requestId" in result&&result.requestId?{requestId:result.requestId}:{})};
  if(result.phase==="blocked")return{status:"blocked",reason:result.reason};
  return result.reason==="destination"?{status:"blocked",reason:"destination"}:result.reason==="authority"?{status:"blocked",reason:"authority"}:{status:"conflict",reason:"command"};
}
