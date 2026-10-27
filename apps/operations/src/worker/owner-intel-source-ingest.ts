import { IntelIngestError,strictIntelJson } from './competitor-intel-ingest-schema';
import { INTEL_INGEST_PATH,intelSignatureHeaders,readIntelBody,verifyIntelSignature,type ProducerKey } from './competitor-intel-ingest-security';
import { readIngestProducerKey } from './competitor-intel-ingest-store';
import { validateOwnerIntelV2Observation,type OwnerIntelV2Observation,type ReviewedOwnerIntelV2Context,OWNER_INTEL_V2_DRAFT_SHA } from './owner-intel-v2-observation';
import { parseDuplicateFreeJson } from './bounded-json';
import type { Env } from './types';

export type OwnerIntelSourceEnvironment=Pick<Env,'OPS_DB'|'ENVIRONMENT'|'INCOMING_BASE_URL'|'INCOMING_EXPECTED_HOST'|'COMPETITOR_INTEL_INGEST_ENABLED'>;
const READ_SCHEMA='ops.intel.owner-source.v1';
const encoder=new TextEncoder();
type StoredReceipt={operationId:string;payloadSha256:string;outcome:'accepted_head'|'accepted_history';acceptedAt:string;epoch:string;counter:string;headAfter:{epoch:string;counter:string}};
export type OwnerIntelSourceIngestResult={receipt:StoredReceipt;delivery:'first'|'duplicate'};
export type OwnerIntelSourceRead={id:string;revision:number;sourceKind:'search_console_summary'|'own_site';bindingId:string;configurationRevision:number;subjectKey:string;operationId:string;payloadSha256:string;acceptedAt:string;completedAt:string;reviewedContextJson:string;periodDays:number|null;observation:OwnerIntelV2Observation};
type BindingRow={producer_id:string;binding_id:string;configuration_revision:number;observation_kind:'search_console_summary'|'own_site';subject_key:string;source:string;source_account_ref:string|null;collected_by:string;reviewed_context_json:string;business_id:string;business_version:number;display_name:string;route_key:string;key_id:string;public_key:string;key_revision:number;key_state:ProducerKey['state'];epoch:string|null;head_epoch:string|null;head_counter:string|null;head_operation_id:string|null;projection_revision:number};
const tuple=(a:{epoch:string;counter:string},b:{epoch:string;counter:string})=>BigInt(a.epoch)<BigInt(b.epoch)?-1:BigInt(a.epoch)>BigInt(b.epoch)?1:BigInt(a.counter)<BigInt(b.counter)?-1:BigInt(a.counter)>BigInt(b.counter)?1:0;
const hashHex=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))).map(v=>v.toString(16).padStart(2,'0')).join('');
function json(value:unknown,status=200){return Response.json(value,{status,headers:{'Cache-Control':'no-store','Cloudflare-CDN-Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
function incoming(request:{url:string;method:string},env:OwnerIntelSourceEnvironment){
 const url=new URL(request.url);if(url.pathname!==INTEL_INGEST_PATH||url.username||url.password||request.method!=='POST'||url.search)return false;
 try{const base=new URL(env.INCOMING_BASE_URL);return base.origin===env.INCOMING_BASE_URL&&base.protocol==='https:'&&base.host===env.INCOMING_EXPECTED_HOST&&url.origin===base.origin&&(env.ENVIRONMENT!=='production'||base.origin==='https://incoming.ledgetopdroneservices.com');}catch{return false;}
}

/** Source lane shares only the frozen signed bytes/headers. Its v2 validator,
 * tables and projector are independent; the v1 schema and receiver stay frozen. */
export function dispatchOwnerIntelSourceIngest(request:Request,env:OwnerIntelSourceEnvironment,now=Date.now()):Promise<Response|null>|null{
 if(!incoming(request,env))return null;
 return (async()=>{
  try{
   if(env.COMPETITOR_INTEL_INGEST_ENABLED!=='true')return json({error:'not_found'},404);
   const db=env.OPS_DB.withSession('first-primary');
   // Preserve the frozen receiver's ordering and its independence from the
   // source migration: the shared gates, signature headers and producer key
   // are checked before the cloned body is read or inspected.
   const ingestGate=await db.prepare('SELECT enabled FROM ci_ingest_control WHERE singleton=1').first<{enabled:number}>();
   if(ingestGate?.enabled!==1)return json({error:'not_found'},404);
   const headers=intelSignatureHeaders(request,now);
   const key=await readIngestProducerKey(env.OPS_DB,headers.producer,headers.keyId);
   if(!['active','previous'].includes(key.state))throw new IntelIngestError('key_not_active',403);
   const raw=await readIntelBody(request.clone());
   await verifyIntelSignature(raw,headers,key);
   const decoded=strictIntelJson(raw) as Record<string,unknown>;
   const semantics=decoded&&typeof decoded==='object'?decoded.semantics as Record<string,unknown>|undefined:undefined;
   if(semantics?.observation!=='ci.obs.v2')return null;
   if(decoded.observationKind!=='search_console_summary'&&decoded.observationKind!=='own_site')throw new IntelIngestError('schema_invalid',400);
   // Only a recognized v2 source envelope depends on migration 0229. v1
   // falls through to the frozen receiver without querying new tables.
   const sourceGate=await db.prepare('SELECT enabled,storage_accepted FROM owner_intel_source_control WHERE singleton=1').first<{enabled:number;storage_accepted:number}>();
   if(sourceGate?.enabled!==1||sourceGate.storage_accepted!==1)return json({error:'not_found'},404);
   const candidate=decoded as unknown as OwnerIntelV2Observation;
   const binding=await db.prepare(`SELECT s.producer_id,s.binding_id,s.configuration_revision,s.observation_kind,s.subject_key,s.source,s.source_account_ref,s.collected_by,s.reviewed_context_json,
    b.business_id,b.version business_version,b.display_name,x.route_key,k.key_id,k.public_key,k.key_revision,k.state key_state,
    (SELECT epoch FROM owner_intel_source_epochs WHERE binding_id=s.binding_id AND configuration_revision=s.configuration_revision) epoch,
    h.epoch head_epoch,h.counter head_counter,h.operation_id head_operation_id,
    (SELECT COALESCE(MAX(revision),0) FROM owner_intel_source_projections p WHERE p.binding_id=s.binding_id AND p.configuration_revision=s.configuration_revision AND p.observation_kind=s.observation_kind AND p.subject_key=s.subject_key) projection_revision
    FROM owner_intel_source_bindings s JOIN owner_intel_bindings m ON m.binding_id=s.binding_id AND m.configuration_revision=s.configuration_revision AND m.status='reviewed'
    JOIN owner_intel_businesses b ON b.business_id=m.business_id AND b.status='reviewed'
    JOIN owner_intel_business_aliases x ON x.business_id=b.business_id AND x.status='active'
    JOIN ci_ingest_producer_bindings pb ON pb.producer_id=s.producer_id AND pb.binding_id=s.binding_id AND pb.configuration_revision=m.configuration_revision AND pb.active=1
    JOIN ci_ingest_producer_keys k ON k.producer_id=s.producer_id AND k.key_id=? AND k.state IN('active','previous')
    LEFT JOIN owner_intel_source_subject_heads h ON h.binding_id=s.binding_id AND h.configuration_revision=s.configuration_revision AND h.subject_key=s.subject_key
    WHERE s.producer_id=? AND s.binding_id=? AND s.configuration_revision=? AND s.observation_kind=? AND s.subject_key=? AND s.active=1 AND s.source_account_ref IS ? AND s.collected_by=? LIMIT 2`)
    .bind(key.key_id,headers.producer,candidate.monitoringBindingId,candidate.configurationRevision,candidate.observationKind,candidate.subjectKey,
     (candidate.payload as {provenance?:{sourceAccountRef?:string|null}}|undefined)?.provenance?.sourceAccountRef??null,
     (candidate.payload as {provenance?:{collectedBy?:string}}|undefined)?.provenance?.collectedBy??'').all<BindingRow>();
   if(binding.results.length!==1)throw new IntelIngestError('binding_not_active',403);
   const b=binding.results[0]!;
   if(b.key_revision!==key.key_revision||b.public_key!==key.public_key||b.key_state!==key.state)throw new IntelIngestError('producer_not_allowed',403);
   let reviewed:ReviewedOwnerIntelV2Context;
   try{reviewed=JSON.parse(b.reviewed_context_json) as ReviewedOwnerIntelV2Context;}catch{throw new IntelIngestError('retryable',503);}
   const observation=validateOwnerIntelV2Observation(raw,reviewed,now);
   return json(await acceptOwnerIntelSourceObservation(env.OPS_DB,key,observation,raw,headers.digest,b,now));
  }catch(error){
   if(error instanceof IntelIngestError)return json({error:error.code},error.status);
   if(error instanceof SyntaxError)return json({error:'schema_invalid'},400);
   return json({error:'retryable'},503);
  }
 })();
}

export async function acceptOwnerIntelSourceObservation(database:D1Database,key:ProducerKey,o:OwnerIntelV2Observation,raw:Uint8Array,digest:string,b:BindingRow,now:number):Promise<OwnerIntelSourceIngestResult>{
 const db=database.withSession('first-primary');
 const prior=await db.prepare('SELECT producer_id,payload_sha256,receipt_json FROM owner_intel_source_inbox WHERE operation_id=?').bind(o.operationId).first<{producer_id:string;payload_sha256:string;receipt_json:string}>();
 if(prior){if(prior.producer_id!==key.producer_id||prior.payload_sha256!==digest)throw new IntelIngestError('operation_hash_conflict',409);return {receipt:JSON.parse(prior.receipt_json) as StoredReceipt,delivery:'duplicate'};}
 const crossLane=await db.prepare('SELECT operation_id FROM ci_ingest_inbox WHERE operation_id=?').bind(o.operationId).first();
 if(crossLane)throw new IntelIngestError('operation_hash_conflict',409);
 const args=[o.monitoringBindingId,o.configurationRevision] as const;
 if(b.epoch!==null&&BigInt(o.sourceSequence.epoch)<BigInt(b.epoch))throw new IntelIngestError('source_epoch_regressed',409);
 const previous=b.head_epoch===null||b.head_counter===null?null:{epoch:b.head_epoch,counter:b.head_counter};
 const same=await db.prepare('SELECT operation_id FROM owner_intel_source_inbox WHERE binding_id=? AND configuration_revision=? AND subject_key=? AND epoch=? AND counter=?').bind(...args,o.subjectKey,o.sourceSequence.epoch,o.sourceSequence.counter).first();
 if(same)throw new IntelIngestError('source_sequence_conflict',409);
 const isHead=!previous||tuple(o.sourceSequence,previous)>0;
 let rangeHead:{epoch:string;counter:string;operation_id:string}|null=null,periodDays:number|null=null;
 if(o.observationKind==='search_console_summary'){
  periodDays=o.payload.period.days;
  const current=await db.prepare(`SELECT i.epoch,i.counter,i.operation_id FROM owner_intel_source_range_heads h JOIN owner_intel_source_inbox i ON i.operation_id=h.operation_id
   WHERE h.binding_id=? AND h.configuration_revision=? AND h.subject_key=? AND h.period_days=?`).bind(...args,o.subjectKey,periodDays).first<{epoch:string;counter:string;operation_id:string}>();
  rangeHead=current??null;
 }
 const updateRange=periodDays!==null&&(!rangeHead||tuple(o.sourceSequence,rangeHead)>0);
 const shouldProject=o.observationKind==='search_console_summary'?updateRange:isHead;
 const projectionRevision=b.projection_revision;
 if(!Number.isSafeInteger(projectionRevision)||projectionRevision<0||projectionRevision===Number.MAX_SAFE_INTEGER)throw new IntelIngestError('retryable',503);
 const acceptedAt=new Date(now).toISOString().replace(/\.\d{3}Z$/,'Z');
 const receipt:StoredReceipt={operationId:o.operationId,payloadSha256:digest,outcome:isHead?'accepted_head':'accepted_history',acceptedAt,epoch:o.sourceSequence.epoch,counter:o.sourceSequence.counter,
  headAfter:isHead?o.sourceSequence:previous!};
 const sourceDto=JSON.stringify({schema:READ_SCHEMA,sourceKind:o.observationKind,bindingId:o.monitoringBindingId,configurationRevision:o.configurationRevision,
  subjectKey:o.subjectKey,operationId:o.operationId,payloadSha256:digest,acceptedAt,completedAt:o.completedAt,observation:o});
 if(encoder.encode(sourceDto).byteLength>262144)throw new IntelIngestError('retryable',503);
 const dtoHash=await hashHex(sourceDto),body=new TextDecoder('utf-8',{fatal:true}).decode(raw);
 const statements:D1PreparedStatement[]=[];
 statements.push(db.prepare(`INSERT INTO owner_intel_source_batch_guards(operation_id,assertion) SELECT ?,CASE WHEN
  EXISTS(SELECT 1 FROM ci_ingest_control WHERE singleton=1 AND enabled=1)
  AND EXISTS(SELECT 1 FROM owner_intel_source_control WHERE singleton=1 AND enabled=1 AND storage_accepted=1)
  AND EXISTS(SELECT 1 FROM ci_ingest_producer_keys WHERE producer_id=? AND key_id=? AND key_revision=? AND public_key=? AND state IN('active','previous'))
  AND NOT EXISTS(SELECT 1 FROM ci_ingest_inbox WHERE operation_id=?)
  AND EXISTS(SELECT 1 FROM owner_intel_source_bindings s JOIN owner_intel_bindings m ON m.binding_id=s.binding_id JOIN owner_intel_businesses b ON b.business_id=m.business_id
   JOIN owner_intel_business_aliases x ON x.business_id=b.business_id JOIN ci_ingest_producer_bindings p ON p.binding_id=m.binding_id
   WHERE s.producer_id=? AND s.binding_id=? AND s.configuration_revision=? AND s.observation_kind=? AND s.subject_key=? AND s.active=1
    AND s.source=? AND s.source_account_ref IS ? AND s.collected_by=? AND s.reviewed_context_json=?
    AND m.configuration_revision=s.configuration_revision AND m.status='reviewed' AND b.status='reviewed' AND b.version=? AND b.display_name=?
    AND x.route_key=? AND x.status='active' AND (SELECT COUNT(*) FROM owner_intel_business_aliases aa WHERE aa.business_id=b.business_id AND aa.status='active')=1
    AND p.producer_id=s.producer_id AND p.active=1 AND p.configuration_revision=m.configuration_revision
    AND (SELECT COUNT(*) FROM owner_intel_source_bindings ss WHERE ss.producer_id=s.producer_id AND ss.binding_id=s.binding_id AND ss.configuration_revision=s.configuration_revision
     AND ss.observation_kind=s.observation_kind AND ss.subject_key=s.subject_key AND ss.active=1)=1)
  AND (SELECT epoch FROM owner_intel_source_epochs WHERE binding_id=? AND configuration_revision=?) IS ?
  AND (SELECT operation_id FROM owner_intel_source_subject_heads WHERE binding_id=? AND configuration_revision=? AND subject_key=?) IS ?
  AND (SELECT operation_id FROM owner_intel_source_range_heads WHERE binding_id=? AND configuration_revision=? AND subject_key=? AND period_days=?) IS ?
  AND (SELECT COALESCE(MAX(revision),0) FROM owner_intel_source_projections WHERE binding_id=? AND configuration_revision=? AND observation_kind=? AND subject_key=?)=?
  THEN 1 ELSE 0 END`).bind(o.operationId,key.producer_id,key.key_id,key.key_revision,key.public_key,o.operationId,
   b.producer_id,...args,o.observationKind,o.subjectKey,o.payload.provenance.source,o.payload.provenance.sourceAccountRef,o.payload.provenance.collectedBy,b.reviewed_context_json,b.business_version,b.display_name,b.route_key,
   ...args,b.epoch,...args,o.subjectKey,b.head_operation_id,...args,o.subjectKey,periodDays,rangeHead?.operation_id??null,...args,o.observationKind,o.subjectKey,projectionRevision));
 statements.push(db.prepare(`INSERT INTO owner_intel_source_inbox(operation_id,producer_id,key_id,key_revision,binding_id,configuration_revision,subject_key,observation_kind,epoch,counter,payload_sha256,raw_body,observation_json,receipt_json,accepted_at,outcome)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(o.operationId,key.producer_id,key.key_id,key.key_revision,...args,o.subjectKey,o.observationKind,o.sourceSequence.epoch,o.sourceSequence.counter,digest,body,JSON.stringify(o),JSON.stringify(receipt),acceptedAt,receipt.outcome));
 if(b.epoch===null||BigInt(o.sourceSequence.epoch)>BigInt(b.epoch)){
  statements.push(db.prepare(`INSERT INTO owner_intel_source_epochs VALUES(?,?,?) ON CONFLICT(binding_id,configuration_revision) DO UPDATE SET epoch=excluded.epoch`).bind(...args,o.sourceSequence.epoch));
  statements.push(db.prepare('INSERT INTO owner_intel_source_epoch_audit VALUES(?,?,?,?,?,?)').bind(o.operationId,...args,b.epoch,o.sourceSequence.epoch,acceptedAt));
 }
 if(isHead){
  statements.push(db.prepare(`INSERT INTO owner_intel_source_subject_heads VALUES(?,?,?,?,?,?) ON CONFLICT(binding_id,configuration_revision,subject_key) DO UPDATE SET epoch=excluded.epoch,counter=excluded.counter,operation_id=excluded.operation_id`).bind(...args,o.subjectKey,o.sourceSequence.epoch,o.sourceSequence.counter,o.operationId));
  statements.push(db.prepare(`INSERT INTO owner_intel_source_kind_heads VALUES(?,?,?,?,?) ON CONFLICT(binding_id,configuration_revision,subject_key,observation_kind) DO UPDATE SET operation_id=excluded.operation_id`).bind(...args,o.subjectKey,o.observationKind,o.operationId));
 }
 if(updateRange&&periodDays!==null){
  statements.push(db.prepare(`INSERT INTO owner_intel_source_range_heads VALUES(?,?,?,?,?) ON CONFLICT(binding_id,configuration_revision,subject_key,period_days) DO UPDATE SET operation_id=excluded.operation_id`).bind(...args,o.subjectKey,periodDays,o.operationId));
 }
 if(shouldProject){
  statements.push(db.prepare(`INSERT INTO owner_intel_source_projections VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),...args,o.observationKind,o.subjectKey,projectionRevision+1,o.operationId,OWNER_INTEL_V2_DRAFT_SHA,READ_SCHEMA,sourceDto,dtoHash,acceptedAt));
 }
 statements.push(db.prepare('DELETE FROM owner_intel_source_batch_guards WHERE operation_id=?').bind(o.operationId));
 try{await db.batch(statements);}catch{
  const raced=await db.prepare('SELECT producer_id,payload_sha256,receipt_json FROM owner_intel_source_inbox WHERE operation_id=?').bind(o.operationId).first<{producer_id:string;payload_sha256:string;receipt_json:string}>();
  if(raced){if(raced.producer_id!==key.producer_id||raced.payload_sha256!==digest)throw new IntelIngestError('operation_hash_conflict',409);return {receipt:JSON.parse(raced.receipt_json) as StoredReceipt,delivery:'duplicate'};}
  throw new IntelIngestError('retryable',503);
 }
 return {receipt,delivery:'first'};
}

/** Read the latest accepted projection for one exact current reviewed source
 * binding. The source DTO hash, receipt, allowlisted context and head pointer
 * are rechecked before the authorized owner router renders it. */
export async function readOwnerIntelSourceProjection(database:D1Database,bindingId:string,configurationRevision:number,kind:'search_console_summary'|'own_site',periodDays?:7|28|90,now=Date.now()):Promise<OwnerIntelSourceRead|null>{
 const db=database.withSession('first-primary');
 const source=await db.prepare(`SELECT producer_id,binding_id,configuration_revision,observation_kind,subject_key,source,source_account_ref,collected_by,reviewed_context_json
  FROM owner_intel_source_bindings WHERE binding_id=? AND configuration_revision=? AND observation_kind=? AND active=1 LIMIT 2`)
  .bind(bindingId,configurationRevision,kind).all<Omit<BindingRow,'business_id'|'business_version'|'display_name'|'route_key'|'key_id'|'public_key'|'key_revision'|'key_state'|'epoch'|'head_epoch'|'head_counter'|'head_operation_id'|'projection_revision'>>();
 if(source.results.length>1)throw new IntelIngestError('retryable',503);
 const selected=source.results[0];if(!selected)return null;
 let context:ReviewedOwnerIntelV2Context;
 try{context=JSON.parse(selected.reviewed_context_json) as ReviewedOwnerIntelV2Context;}catch{throw new IntelIngestError('retryable',503);}
 if(kind==='search_console_summary'&&periodDays===undefined)throw new IntelIngestError('schema_invalid',400);
 const head=kind==='search_console_summary'
  ?await db.prepare('SELECT operation_id FROM owner_intel_source_range_heads WHERE binding_id=? AND configuration_revision=? AND subject_key=? AND period_days=?').bind(bindingId,configurationRevision,selected.subject_key,periodDays).first<string>('operation_id')
  :await db.prepare('SELECT operation_id FROM owner_intel_source_kind_heads WHERE binding_id=? AND configuration_revision=? AND subject_key=? AND observation_kind=?').bind(bindingId,configurationRevision,selected.subject_key,kind).first<string>('operation_id');
 if(!head)return null;
 const row=await db.prepare(`SELECT projection_id id,revision,source_contract_sha256 contract,read_schema,dto_json,dto_sha256
  FROM owner_intel_source_projections WHERE binding_id=? AND configuration_revision=? AND observation_kind=? AND subject_key=? AND source_operation_id=? LIMIT 1`)
  .bind(bindingId,configurationRevision,kind,selected.subject_key,head).first<{id:string;revision:number;contract:string;read_schema:string;dto_json:string;dto_sha256:string}>();
 if(!row)return null;
 if(row.contract!==OWNER_INTEL_V2_DRAFT_SHA||row.read_schema!==READ_SCHEMA||encoder.encode(row.dto_json).byteLength>262144||await hashHex(row.dto_json)!==row.dto_sha256)throw new IntelIngestError('retryable',503);
 let value:unknown;try{value=parseDuplicateFreeJson(row.dto_json);}catch{throw new IntelIngestError('retryable',503);}
 if(!value||typeof value!=='object'||Array.isArray(value))throw new IntelIngestError('retryable',503);
 const dto=value as Record<string,unknown>;
 if(dto.schema!==READ_SCHEMA||dto.sourceKind!==kind||dto.bindingId!==bindingId||dto.configurationRevision!==configurationRevision||dto.subjectKey!==selected.subject_key
   ||typeof dto.operationId!=='string'||typeof dto.payloadSha256!=='string'||typeof dto.acceptedAt!=='string'||typeof dto.completedAt!=='string'||!dto.observation||typeof dto.observation!=='object')throw new IntelIngestError('retryable',503);
 const observation=validateOwnerIntelV2Observation(encoder.encode(JSON.stringify(dto.observation)),context,now);
 if(observation.operationId!==dto.operationId||observation.observationKind!==kind||observation.monitoringBindingId!==bindingId||observation.configurationRevision!==configurationRevision||observation.subjectKey!==selected.subject_key
   ||observation.payload.provenance.source!==selected.source||observation.payload.provenance.sourceAccountRef!==selected.source_account_ref||observation.payload.provenance.collectedBy!==selected.collected_by)throw new IntelIngestError('retryable',503);
 const inbox=await db.prepare('SELECT payload_sha256 FROM owner_intel_source_inbox WHERE operation_id=? AND binding_id=? AND configuration_revision=? AND subject_key=?').bind(dto.operationId,bindingId,configurationRevision,selected.subject_key).first<{payload_sha256:string}>();
 if(!inbox||inbox.payload_sha256!==dto.payloadSha256)throw new IntelIngestError('retryable',503);
 const currentHead=kind==='search_console_summary'
  ?await db.prepare('SELECT operation_id FROM owner_intel_source_range_heads WHERE binding_id=? AND configuration_revision=? AND subject_key=? AND period_days=?').bind(bindingId,configurationRevision,selected.subject_key,periodDays).first<string>('operation_id')
  :await db.prepare('SELECT operation_id FROM owner_intel_source_kind_heads WHERE binding_id=? AND configuration_revision=? AND subject_key=? AND observation_kind=?').bind(bindingId,configurationRevision,selected.subject_key,kind).first<string>('operation_id');
 if(currentHead!==dto.operationId)throw new IntelIngestError('retryable',503);
 const observedPeriodDays=observation.observationKind==='search_console_summary'?observation.payload.period.days:null;
 return {id:row.id,revision:row.revision,sourceKind:kind,bindingId,configurationRevision,subjectKey:selected.subject_key,operationId:dto.operationId,payloadSha256:dto.payloadSha256,
  acceptedAt:dto.acceptedAt,completedAt:dto.completedAt,reviewedContextJson:selected.reviewed_context_json,periodDays:observedPeriodDays,observation};
}

export async function ownerIntelSourceProjectionStillCurrent(database:D1Database,source:OwnerIntelSourceRead):Promise<boolean>{
 const db=database.withSession('first-primary');
 const gate=await db.prepare('SELECT enabled,storage_accepted FROM owner_intel_source_control WHERE singleton=1').first<{enabled:number;storage_accepted:number}>();
 if(gate?.enabled!==1||gate.storage_accepted!==1)return false;
 const binding=await db.prepare(`SELECT reviewed_context_json FROM owner_intel_source_bindings WHERE producer_id=? AND binding_id=? AND configuration_revision=? AND observation_kind=? AND subject_key=? AND active=1`)
  .bind(source.observation.producerId,source.bindingId,source.configurationRevision,source.sourceKind,source.subjectKey).first<string>('reviewed_context_json');
 if(binding!==source.reviewedContextJson)return false;
 const head=source.sourceKind==='search_console_summary'
  ?await db.prepare('SELECT operation_id FROM owner_intel_source_range_heads WHERE binding_id=? AND configuration_revision=? AND subject_key=? AND period_days=?').bind(source.bindingId,source.configurationRevision,source.subjectKey,source.periodDays).first<string>('operation_id')
  :await db.prepare('SELECT operation_id FROM owner_intel_source_kind_heads WHERE binding_id=? AND configuration_revision=? AND subject_key=? AND observation_kind=?').bind(source.bindingId,source.configurationRevision,source.subjectKey,source.sourceKind).first<string>('operation_id');
 if(head!==source.operationId)return false;
 const projection=await db.prepare('SELECT projection_id FROM owner_intel_source_projections WHERE binding_id=? AND configuration_revision=? AND observation_kind=? AND subject_key=? AND source_operation_id=?')
  .bind(source.bindingId,source.configurationRevision,source.sourceKind,source.subjectKey,source.operationId).first<string>('projection_id');
 return projection===source.id;
}
