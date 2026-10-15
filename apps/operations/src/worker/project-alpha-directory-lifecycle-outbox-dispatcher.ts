import { withEnabledConfiguredProjectAlphaApiV2Connection, type ProjectAlphaApiV2ConnectionEnvironment }
  from "./project-alpha-api-v2-connections";
import type { ProjectAlphaApiV2Connection } from "./project-alpha-api-v2";

const LEASE_MS=5*60_000;
type Environment=ProjectAlphaApiV2ConnectionEnvironment&Readonly<{OPS_DB:D1Database}>;
type LifecycleEnvironment=Environment&Readonly<{PROJECT_ALPHA_DIRECTORY_LIFECYCLE_ENABLED?:string}>;
type Row=Readonly<{command_id:string;mutation_id:string;record_id:string;action:"archive"|"restore";source_id:string;
  source_instance_id:string;application_id:string;history_epoch_id:string;destination_origin:string;project_alpha_public_id:string;
  command_json:string;state:string;attempts:number;next_attempt_at:number;lease_expires_at:number|null;outcome_json:string|null;
  terminal_sibling:number}>;
export type LifecycleDispatchOutcome=Readonly<{status:"acknowledged";commandId:string;replayed:boolean;revision:string}>
  |Readonly<{status:"blocked";reason:"configuration"|"destination"|"not_due"|"in_progress"}>
  |Readonly<{status:"conflict";httpStatus?:number;requestId?:string}>
  |Readonly<{status:"uncertain";reason:string;httpStatus?:number;requestId?:string}>;

function origin(value:string):string|null{try{return new URL(value).origin;}catch{return null;}}
function exact(row:Row,connection:ProjectAlphaApiV2Connection):boolean{let configured:URL;try{configured=new URL(connection.baseUrl);}catch{return false;}
  return configured.protocol==="https:"&&configured.pathname==="/"&&!configured.search&&!configured.hash&&!configured.username&&!configured.password
  &&row.source_instance_id===connection.expectedSourceInstanceId
  &&row.application_id===connection.expectedApplicationId&&row.history_epoch_id===connection.expectedHistoryEpoch
  &&origin(row.destination_origin)===origin(connection.baseUrl);}
function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==="object"&&!Array.isArray(value);}
function uuid(value:unknown):value is string{return typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);}
function decimal(value:unknown,positive=false):value is string{return typeof value==="string"&&new RegExp(positive?"^[1-9][0-9]{0,18}$":"^(?:0|[1-9][0-9]{0,18})$").test(value)
  &&(value.length<19||value<="9223372036854775807");}
function greater(left:string,right:string):boolean{return left.length>right.length||left.length===right.length&&left>right;}
async function boundedJson(response:Response):Promise<unknown>{const reader=response.body?.getReader();if(!reader)throw new Error("contract");
  const chunks:Uint8Array[]=[],limit=64*1024;let size=0;try{for(;;){const part=await reader.read();if(part.done)break;
    size+=part.value.byteLength;if(size>limit){await reader.cancel();throw new Error("response_limit");}chunks.push(part.value);}}
  finally{reader.releaseLock();}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}

export async function dispatchProjectAlphaDirectoryLifecycleCommand(env:LifecycleEnvironment,sourceId:string,commandId:string,
  send:typeof fetch=fetch):Promise<LifecycleDispatchOutcome>{
  if(env.PROJECT_ALPHA_DIRECTORY_LIFECYCLE_ENABLED!=="true")return{status:"blocked",reason:"configuration"};
  const initial=await env.OPS_DB.prepare(`SELECT current.command_id,current.mutation_id,current.record_id,current.action,current.source_id,
    current.source_instance_id,current.application_id,current.history_epoch_id,current.destination_origin,current.project_alpha_public_id,
    current.command_json,current.state,current.attempts,current.next_attempt_at,current.lease_expires_at,current.outcome_json,
    EXISTS(SELECT 1 FROM project_alpha_directory_lifecycle_outbox sibling WHERE sibling.mutation_id=current.mutation_id
      AND sibling.command_id<>current.command_id AND sibling.state='terminal') terminal_sibling
    FROM project_alpha_directory_lifecycle_outbox current WHERE current.command_id=?`).bind(commandId).first<Row>();
  if(!initial)return{status:"blocked",reason:"in_progress"};
  if(initial.source_id!==sourceId)return{status:"conflict"};
  if(initial.state==="acknowledged"&&initial.outcome_json){try{const response=JSON.parse(initial.outcome_json).response;
    return{status:"acknowledged",commandId,replayed:true,revision:response.result.resource.revision};}catch{return{status:"uncertain",reason:"evidence"};}}
  if(initial.state==="terminal")return{status:"conflict"};
  if(initial.terminal_sibling===1)return{status:"conflict"};
  const selected=await withEnabledConfiguredProjectAlphaApiV2Connection(env,sourceId,async connection=>{
    if(!exact(initial,connection))return{status:"blocked" as const,reason:"destination" as const};
    const now=Date.now();if(initial.state==="pending"&&initial.next_attempt_at>now)return{status:"blocked" as const,reason:"not_due" as const};
    if(initial.state==="leased"&&(initial.lease_expires_at===null||initial.lease_expires_at>now))return{status:"blocked" as const,reason:"in_progress" as const};
    const token=crypto.randomUUID(),claim=await env.OPS_DB.prepare(`UPDATE project_alpha_directory_lifecycle_outbox SET state='leased',
      attempts=attempts+1,lease_token=?,lease_expires_at=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE command_id=? AND command_json=? AND attempts=? AND next_attempt_at=? AND state=?
        AND (state='pending' OR (state='leased' AND lease_expires_at<=?))
        AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_lifecycle_outbox sibling
          WHERE sibling.mutation_id=project_alpha_directory_lifecycle_outbox.mutation_id
            AND sibling.command_id<>project_alpha_directory_lifecycle_outbox.command_id AND sibling.state='terminal')`)
      .bind(token,now+LEASE_MS,commandId,initial.command_json,initial.attempts,initial.next_attempt_at,initial.state,now).run();
    if(claim.meta.changes!==1)return{status:"blocked" as const,reason:"in_progress" as const};
    const event=await env.OPS_DB.prepare("SELECT record_kind FROM operations_directory_lifecycle_events WHERE mutation_id=?")
      .bind(initial.mutation_id).first<string>("record_kind");
    if(event!=="client"&&event!=="organization")return{status:"uncertain" as const,reason:"event"};
    const plural=event==="client"?"clients":"organizations",url=new URL(`/api/v2/directory/${plural}/${initial.project_alpha_public_id}/${initial.action}/commands`,connection.baseUrl);
    const headers=new Headers({Accept:"application/json","Content-Type":"application/json; charset=utf-8",Authorization:`Bearer ${connection.apiKey}`,
      "X-PA-Source-Instance-ID":initial.source_instance_id,"X-PA-Application-ID":initial.application_id,"X-PA-History-Epoch":initial.history_epoch_id});
    if(connection.accessClientId&&connection.accessClientSecret){headers.set("CF-Access-Client-Id",connection.accessClientId);headers.set("CF-Access-Client-Secret",connection.accessClientSecret);}
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10_000);
    let response:Response;try{response=await send(url,{method:"POST",headers,body:initial.command_json,redirect:"manual",credentials:"omit",cache:"no-store",signal:controller.signal});}
    catch{clearTimeout(timer);return{status:"uncertain" as const,reason:"transport"};}
    const requestId=response.headers.get("X-Request-ID")??undefined;
    if(response.status===409){clearTimeout(timer);await response.body?.cancel();const settled=await env.OPS_DB.prepare(`UPDATE project_alpha_directory_lifecycle_outbox SET state='terminal',outcome_json=?,
      lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='leased' AND lease_token=?`).bind(JSON.stringify({status:"conflict",httpStatus:409,...(requestId?{requestId}:{})}),commandId,token).run();
      return settled.meta.changes===1?{status:"conflict" as const,httpStatus:409,...(requestId?{requestId}:{})}
        :{status:"uncertain" as const,reason:"lost_lease"};}
    if(response.status!==200){clearTimeout(timer);await response.body?.cancel();return{status:"uncertain" as const,reason:"http_status",httpStatus:response.status,...(requestId?{requestId}:{})};}
    const length=response.headers.get("Content-Length");if(length&&(!/^\d+$/.test(length)||Number(length)>64*1024)){
      clearTimeout(timer);await response.body?.cancel();return{status:"uncertain" as const,reason:"response_limit"};}
    let payload:unknown;try{payload=await boundedJson(response);}catch(error){clearTimeout(timer);return{status:"uncertain" as const,
      reason:error instanceof Error&&error.message==="response_limit"?"response_limit":controller.signal.aborted?"transport":"contract"};}
    clearTimeout(timer);
    let command:unknown;try{command=JSON.parse(initial.command_json);}catch{return{status:"uncertain" as const,reason:"command"};}
    const expected=object(command)?command:null;
    if(!expected||Object.keys(expected).length!==3||!decimal(expected.expectedRevision,true)||!decimal(expected.expectedAuthorizationGeneration)
      ||!object(payload)||Object.keys(payload).length!==6||!uuid(payload.requestId)||payload.requestId!==requestId||payload.sourceInstanceId!==initial.source_instance_id
      ||payload.applicationId!==initial.application_id||payload.historyEpoch!==initial.history_epoch_id||typeof payload.replayed!=="boolean"
      ||!object(payload.result)||Object.keys(payload.result).length!==3||payload.result.action!==initial.action||!decimal(payload.result.authorizationGeneration)
      ||!object(payload.result.resource)||Object.keys(payload.result.resource).length!==4||payload.result.resource.type!==event||payload.result.resource.publicId!==initial.project_alpha_public_id
      ||payload.result.resource.present!==(initial.action==="restore")||!decimal(payload.result.resource.revision,true)
      ||!greater(payload.result.resource.revision,expected.expectedRevision)||greater(expected.expectedAuthorizationGeneration,payload.result.authorizationGeneration))
      return{status:"uncertain" as const,reason:"contract"};
    const outcome=JSON.stringify({status:"acknowledged",response:payload});
    const results=await env.OPS_DB.batch([env.OPS_DB.prepare(`UPDATE project_alpha_directory_lifecycle_outbox SET state='acknowledged',outcome_json=?,
      lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE command_id=? AND state='leased' AND lease_token=?`).bind(outcome,commandId,token),
      env.OPS_DB.prepare(`UPDATE operations_directory_lifecycle_state SET status=CASE status WHEN 'archive_pending' THEN 'archived'
        WHEN 'restore_pending' THEN 'restored_unbound' ELSE status END,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE record_id=?
        AND last_mutation_id=? AND status IN ('archive_pending','restore_pending') AND NOT EXISTS(
          SELECT 1 FROM project_alpha_directory_lifecycle_outbox WHERE mutation_id=? AND state<>'acknowledged')`)
        .bind(initial.record_id,initial.mutation_id,initial.mutation_id)]);
    return results[0]!.meta.changes===1?{status:"acknowledged" as const,commandId,replayed:payload.replayed,revision:payload.result.resource.revision as string}
      :{status:"uncertain" as const,reason:"lost_lease"};
  });
  return selected.status==="enabled"?selected.value:{status:"blocked",reason:"configuration"};
}
