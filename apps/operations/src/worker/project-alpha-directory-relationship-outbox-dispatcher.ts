import {
  isProjectAlphaDirectoryRelationshipCommand,
  sendProjectAlphaDirectoryOrganizationRelationshipCommand,
  validatedProjectAlphaDirectoryCommandAcknowledgement,
  type ProjectAlphaDirectoryRelationshipAction,
  type ProjectAlphaDirectoryRelationshipCommand,
  type ProjectAlphaDirectoryRelationshipSuccess,
} from "./project-alpha-directory-relationship-api-v2";
import { withEnabledConfiguredProjectAlphaApiV2Connection, type ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";
import type { ProjectAlphaApiV2Connection } from "./project-alpha-api-v2";

const LEASE_MS=5*60_000, MAX_RETRY_MS=60*60_000;
type Environment=ProjectAlphaApiV2ConnectionEnvironment & Readonly<{ OPS_DB:D1Database }>;
type Row=Readonly<Record<string,unknown>&{ command_id:string;source_id:string;source_instance_id:string;application_id:string;
  history_epoch_id:string;destination_origin:string;client_public_id:string;action:ProjectAlphaDirectoryRelationshipAction;
  command_json:string;request_json:string;state:string;attempts:number;next_attempt_at:number;lease_expires_at:number|null;outcome_json:string|null }>;

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
async function load(db:D1Database,commandId:string):Promise<Row|null>{return db.prepare("SELECT * FROM project_alpha_directory_relationship_outbox WHERE command_id=?").bind(commandId).first<Row>();}
async function live(db:D1Database,commandId:string):Promise<boolean>{return !!await db.prepare("SELECT 1 present FROM project_alpha_directory_live_relationship_commands WHERE command_id=?").bind(commandId).first();}
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
async function release(db:D1Database,row:Row,token:string,now:number):Promise<void>{const delay=Math.min(MAX_RETRY_MS,1_000*2**Math.min(12,Math.max(0,row.attempts)));
  await db.prepare(`UPDATE project_alpha_directory_relationship_outbox SET state='pending',lease_token=NULL,lease_expires_at=NULL,
    next_attempt_at=?,outcome_json=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE command_id=? AND state='leased' AND lease_token=? AND lease_expires_at>?`).bind(now+delay,row.command_id,token,now).run();}

/** Dispatches exactly one pre-reserved relationship command.  No route,
 * scheduler, or profile materialization imports this private boundary. */
export async function dispatchProjectAlphaDirectoryRelationshipCommand(env:Environment,sourceId:string,commandId:string,
  send:typeof fetch=fetch):Promise<ProjectAlphaDirectoryRelationshipDispatcherOutcome>{
  const initial=await load(env.OPS_DB,commandId);if(!initial)return{status:"blocked",reason:"in_progress"};
  if(initial.source_id!==sourceId)return{status:"conflict",reason:"source"};const completed=replay(initial);if(completed)return completed;
  const selected=await withEnabledConfiguredProjectAlphaApiV2Connection(env,sourceId,async connection=>{
    if(!exactDestination(initial,connection))return{phase:"invalid" as const,reason:"destination" as const};
    if(!await live(env.OPS_DB,commandId))return{phase:"invalid" as const,reason:"authority" as const};
    let command:ProjectAlphaDirectoryRelationshipCommand;try{command=JSON.parse(initial.command_json) as ProjectAlphaDirectoryRelationshipCommand;}catch{return{phase:"invalid" as const,reason:"command" as const};}
    if(!isProjectAlphaDirectoryRelationshipCommand(initial.action,command))return{phase:"invalid" as const,reason:"command" as const};
    const now=Date.now();if(initial.state==="pending"&&initial.next_attempt_at>now)return{phase:"blocked" as const,reason:"not_due" as const};
    if(initial.state==="leased"&&(initial.lease_expires_at===null||initial.lease_expires_at>now))return{phase:"blocked" as const,reason:"in_progress" as const};
    if(initial.state!=="pending"&&initial.state!=="leased")return{phase:"blocked" as const,reason:"in_progress" as const};
    const token=crypto.randomUUID();const claimed=await env.OPS_DB.prepare(`UPDATE project_alpha_directory_relationship_outbox
      SET state='leased',attempts=attempts+1,lease_token=?,lease_expires_at=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE command_id=? AND command_json=? AND ((state='pending' AND next_attempt_at<=?) OR (state='leased' AND lease_expires_at<=?))`)
      .bind(token,now+LEASE_MS,commandId,initial.command_json,now,now).run();
    if(claimed.meta.changes!==1)return{phase:"blocked" as const,reason:"in_progress" as const};
    const leased=await load(env.OPS_DB,commandId);
    if(!leased||!exactDestination(leased,connection)||!await live(env.OPS_DB,commandId)){if(leased)await release(env.OPS_DB,leased,token,Date.now());return{phase:"invalid" as const,reason:!leased?"command" as const:!exactDestination(leased,connection)?"destination" as const:"authority" as const};}
    const outcome=await sendProjectAlphaDirectoryOrganizationRelationshipCommand(connection,leased.client_public_id,leased.action,command,send);
    if(outcome.status!=="acknowledged"){
      if(outcome.status==="conflict"){
        const saved=JSON.stringify({directoryRelationshipDispatcher:"conflict",reason:outcome.reason,
          ...(outcome.httpStatus?{httpStatus:outcome.httpStatus}:{}),...(outcome.requestId?{requestId:outcome.requestId}:{})});
        const settled=await env.OPS_DB.prepare(`UPDATE project_alpha_directory_relationship_outbox SET state='terminal',outcome_json=?,
          lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE command_id=? AND state='leased' AND lease_token=? AND lease_expires_at>?`).bind(saved,commandId,token,Date.now()).run();
        return settled.meta.changes===1?{phase:"conflict" as const,httpStatus:outcome.httpStatus,requestId:outcome.requestId}
          :{phase:"uncertain" as const,reason:"lost_lease"};
      }
      await release(env.OPS_DB,leased,token,Date.now());return{phase:"uncertain" as const,reason:outcome.reason,
        ...(outcome.httpStatus?{httpStatus:outcome.httpStatus}:{}),...(outcome.requestId?{requestId:outcome.requestId}:{})};
    }
    const evidence=validatedProjectAlphaDirectoryCommandAcknowledgement<ProjectAlphaDirectoryRelationshipSuccess>(outcome);
    if(!evidence||JSON.stringify(evidence.command)!==initial.command_json||origin(evidence.destinationOrigin)!==origin(leased.destination_origin)){
      await release(env.OPS_DB,leased,token,Date.now());return{phase:"uncertain" as const,reason:"evidence"};}
    if(!exactDestination(leased,connection)||!await live(env.OPS_DB,commandId)){
      await release(env.OPS_DB,leased,token,Date.now());return{phase:"invalid" as const,reason:"authority" as const};}
    const outcomeJson=JSON.stringify({status:"acknowledged",response:evidence.response});
    const settled=await env.OPS_DB.prepare(`UPDATE project_alpha_directory_relationship_outbox SET state='acknowledged',outcome_json=?,
      lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE command_id=? AND state='leased' AND lease_token=? AND lease_expires_at>?`).bind(outcomeJson,commandId,token,Date.now()).run();
    return settled.meta.changes===1?{phase:"acknowledged" as const,response:evidence.response}:{phase:"uncertain" as const,reason:"lost_lease"};
  });
  if(selected.status!=="enabled")return{status:"blocked",reason:"configuration"};const result=selected.value;
  if(result.phase==="acknowledged")return{status:"acknowledged",commandId,replayed:result.response.replayed,
    clientPublicId:result.response.result.client.publicId,revision:result.response.result.client.revision};
  if(result.phase==="conflict")return{status:"conflict",reason:"remote",...(result.httpStatus?{httpStatus:result.httpStatus}:{}),...(result.requestId?{requestId:result.requestId}:{})};
  if(result.phase==="uncertain")return{status:"uncertain",reason:result.reason,...("httpStatus" in result&&result.httpStatus?{httpStatus:result.httpStatus}:{}),...("requestId" in result&&result.requestId?{requestId:result.requestId}:{})};
  if(result.phase==="blocked")return{status:"blocked",reason:result.reason};
  return result.reason==="destination"?{status:"blocked",reason:"destination"}:result.reason==="authority"?{status:"blocked",reason:"authority"}:{status:"conflict",reason:"command"};
}
