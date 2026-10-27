import { IntelIngestError } from './competitor-intel-ingest-schema';
import type { IntelSignature,ProducerKey } from './competitor-intel-ingest-security';
import { parseDuplicateFreeJson } from './bounded-json';
import { OWNER_GOOGLE_ADS_CONTRACT,parseStrictOwnerGoogleAdsObservation,validateOwnerGoogleAdsObservation,type OwnerGoogleAdsObservation,type OwnerGoogleAdsReviewedContext } from './owner-google-ads-observation';

const READ_SCHEMA='ops.intel.owner-google-ads.v1';
const encoder=new TextEncoder();
const ADS_TABLES=['owner_intel_google_ads_control','owner_intel_google_ads_bindings','owner_intel_google_ads_inbox','owner_intel_google_ads_epochs','owner_intel_google_ads_subject_heads','owner_intel_google_ads_range_heads','owner_intel_google_ads_epoch_audit','owner_intel_google_ads_projections','owner_intel_google_ads_batch_guards'] as const;
const ADS_TRIGGERS=['owner_intel_google_ads_binding_context_immutable','owner_intel_google_ads_binding_retained','owner_intel_google_ads_inbox_immutable','owner_intel_google_ads_inbox_retained','owner_intel_google_ads_epoch_audit_immutable','owner_intel_google_ads_epoch_audit_retained','owner_intel_google_ads_projection_immutable','owner_intel_google_ads_projection_retained','owner_intel_google_ads_no_v1_operation','owner_intel_v1_no_google_ads_operation','owner_intel_google_ads_no_source_operation','owner_intel_source_no_google_ads_operation','owner_intel_google_ads_inbox_subject_key'] as const;
type D1=D1Database;
type BindingRow={producer_id:string;binding_id:string;configuration_revision:number;subject_key:'own:google-ads';observation_kind:'google_ads_summary';account_state:'connected'|'no_account';manager_customer_ref:string|null;advertiser_customer_ref:string|null;source_account_ref:string|null;currency_code:string|null;time_zone:string|null;collected_by:string;active:number;reviewed_context_json:string;business_id:string;business_version:number;display_name:string;route_key:string;key_id:string;public_key:string;key_revision:number;key_state:ProducerKey['state'];epoch:string|null;head_epoch:string|null;head_counter:string|null;head_operation_id:string|null;range_head_operation_id:string|null;projection_revision:number};
type StoredReceipt={operationId:string;payloadSha256:string;outcome:'accepted_head'|'accepted_history';acceptedAt:string;epoch:string;counter:string;headAfter:{epoch:string;counter:string}};
export type OwnerGoogleAdsRead={id:string;revision:number;bindingId:string;configurationRevision:number;subjectKey:'own:google-ads';operationId:string;payloadSha256:string;acceptedAt:string;completedAt:string;accountState:'connected'|'no_account';contextJson:string;periodDays:7|28|90|null;observation:OwnerGoogleAdsObservation};
export type OwnerGoogleAdsReadState='schema_missing'|'disabled'|'binding_missing'|'ready';
const tuple=(a:{epoch:string;counter:string},b:{epoch:string;counter:string})=>BigInt(a.epoch)<BigInt(b.epoch)?-1:BigInt(a.epoch)>BigInt(b.epoch)?1:BigInt(a.counter)<BigInt(b.counter)?-1:BigInt(a.counter)>BigInt(b.counter)?1:0;
const hashHex=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))).map(v=>v.toString(16).padStart(2,'0')).join('');
function periodKey(o:OwnerGoogleAdsObservation){return o.payload.period?`${o.payload.period.days}d`:'status';}
function jsonObject(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function localDayAt(now:number,zone:string){
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now));
 const get=(type:Intl.DateTimeFormatPartTypes)=>parts.find(part=>part.type===type)?.value;
 return `${get('year')}-${get('month')}-${get('day')}`;
}
function shiftDay(value:string,days:number){const date=new Date(`${value}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10);}
function isLatestClosedWindow(period:NonNullable<OwnerGoogleAdsObservation['payload']['period']>,now:number){
 const end=shiftDay(localDayAt(now,period.timeZone),-1);
 return period.end===end&&period.start===shiftDay(end,1-period.days);
}

export async function ownerGoogleAdsReadState(database:D1Database,bindingId:string,configurationRevision:number):Promise<OwnerGoogleAdsReadState>{
 const db=database.withSession('first-primary');
 const inventory=await db.prepare(`SELECT COUNT(*) count FROM sqlite_schema WHERE type='table' AND name IN(${ADS_TABLES.map(()=>'?').join(',')})`).bind(...ADS_TABLES).first<number>('count');
 const guards=await db.prepare(`SELECT COUNT(*) count FROM sqlite_schema WHERE type='trigger' AND name IN(${ADS_TRIGGERS.map(()=>'?').join(',')})`).bind(...ADS_TRIGGERS).first<number>('count');
 if(inventory!==ADS_TABLES.length||guards!==ADS_TRIGGERS.length)return 'schema_missing';
 const gate=await db.prepare('SELECT enabled,storage_accepted FROM owner_intel_google_ads_control WHERE singleton=1').first<{enabled:number;storage_accepted:number}>();
 if(!gate||gate.enabled!==1||gate.storage_accepted!==1)return 'disabled';
 const binding=await db.prepare(`SELECT s.binding_id FROM owner_intel_google_ads_bindings s JOIN owner_intel_bindings m ON m.binding_id=s.binding_id AND m.configuration_revision=s.configuration_revision AND m.status='reviewed'
  JOIN owner_intel_businesses b ON b.business_id=m.business_id AND b.status='reviewed'
  JOIN owner_intel_business_aliases x ON x.business_id=b.business_id AND x.status='active'
  JOIN ci_ingest_producer_bindings p ON p.producer_id=s.producer_id AND p.binding_id=s.binding_id AND p.configuration_revision=m.configuration_revision AND p.active=1
  WHERE s.binding_id=? AND s.configuration_revision=? AND s.subject_key='own:google-ads' AND s.active=1
   AND (SELECT COUNT(*) FROM owner_intel_business_aliases aa WHERE aa.business_id=b.business_id AND aa.status='active')=1 LIMIT 2`).bind(bindingId,configurationRevision).all<{binding_id:string}>();
 if(binding.results.length>1)throw new IntelIngestError('retryable',503);
 return binding.results.length===1?'ready':'binding_missing';
}

/** The shared source dispatcher has already checked the incoming origin, global
 * gate, signature headers, producer key, bounded body, digest, and signature. */
export async function acceptOwnerGoogleAdsEnvelope(database:D1,key:ProducerKey,headers:IntelSignature,raw:Uint8Array,decoded:unknown,now:number):Promise<Response|null>{
 if(!jsonObject(decoded)||!jsonObject(decoded.semantics)||decoded.semantics.observation!=='ci.google_ads_owner.v1')return null;
 if(decoded.schemaVersion!=='ci.observation.v1'||decoded.observationKind!=='google_ads_summary')throw new IntelIngestError('schema_invalid',400);
 const db=database.withSession('first-primary');
 const inventory=await db.prepare(`SELECT COUNT(*) count FROM sqlite_schema WHERE type='table' AND name IN(${ADS_TABLES.map(()=>'?').join(',')})`).bind(...ADS_TABLES).first<number>('count');
 const guards=await db.prepare(`SELECT COUNT(*) count FROM sqlite_schema WHERE type='trigger' AND name IN(${ADS_TRIGGERS.map(()=>'?').join(',')})`).bind(...ADS_TRIGGERS).first<number>('count');
 if(inventory!==ADS_TABLES.length||guards!==ADS_TRIGGERS.length)return Response.json({error:'not_found'},{status:404,headers:{'Cache-Control':'no-store','Cloudflare-CDN-Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 const gate=await db.prepare('SELECT enabled,storage_accepted FROM owner_intel_google_ads_control WHERE singleton=1').first<{enabled:number;storage_accepted:number}>();
 if(gate?.enabled!==1||gate.storage_accepted!==1)return Response.json({error:'not_found'},{status:404,headers:{'Cache-Control':'no-store','Cloudflare-CDN-Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 const o=parseStrictOwnerGoogleAdsObservation(raw);
 if(o.producerId!==headers.producer)throw new IntelIngestError('producer_not_allowed',403);
 const p=o.payload,account=p.account;
 const rows=await db.prepare(`SELECT s.producer_id,s.binding_id,s.configuration_revision,s.subject_key,s.observation_kind,s.account_state,s.manager_customer_ref,s.advertiser_customer_ref,s.source_account_ref,s.currency_code,s.time_zone,s.collected_by,s.active,
  s.manager_customer_ref||'|'||COALESCE(s.advertiser_customer_ref,'') reviewed_context_json,
  b.business_id,b.version business_version,b.display_name,x.route_key,k.key_id,k.public_key,k.key_revision,k.state key_state,
  (SELECT epoch FROM owner_intel_google_ads_epochs WHERE binding_id=s.binding_id AND configuration_revision=s.configuration_revision) epoch,
  h.epoch head_epoch,h.counter head_counter,h.operation_id head_operation_id,
  rh.operation_id range_head_operation_id,
  (SELECT COALESCE(MAX(revision),0) FROM owner_intel_google_ads_projections q WHERE q.binding_id=s.binding_id AND q.configuration_revision=s.configuration_revision AND q.subject_key=s.subject_key AND q.period_key=?) projection_revision
  FROM owner_intel_google_ads_bindings s JOIN owner_intel_bindings m ON m.binding_id=s.binding_id AND m.configuration_revision=s.configuration_revision AND m.status='reviewed'
  JOIN owner_intel_businesses b ON b.business_id=m.business_id AND b.status='reviewed'
  JOIN owner_intel_business_aliases x ON x.business_id=b.business_id AND x.status='active'
  JOIN ci_ingest_producer_bindings pb ON pb.producer_id=s.producer_id AND pb.binding_id=s.binding_id AND pb.configuration_revision=m.configuration_revision AND pb.active=1
  JOIN ci_ingest_producer_keys k ON k.producer_id=s.producer_id AND k.key_id=? AND k.state IN('active','previous')
  LEFT JOIN owner_intel_google_ads_subject_heads h ON h.binding_id=s.binding_id AND h.configuration_revision=s.configuration_revision AND h.subject_key=s.subject_key
  LEFT JOIN owner_intel_google_ads_range_heads rh ON rh.binding_id=s.binding_id AND rh.configuration_revision=s.configuration_revision AND rh.subject_key=s.subject_key AND rh.period_key=?
  WHERE s.producer_id=? AND s.binding_id=? AND s.configuration_revision=? AND s.observation_kind=? AND s.subject_key=? AND s.active=1
   AND s.account_state=? AND s.manager_customer_ref IS ? AND s.advertiser_customer_ref IS ? AND s.source_account_ref IS ? AND s.currency_code IS ? AND s.time_zone IS ? AND s.collected_by=?
   AND (SELECT COUNT(*) FROM owner_intel_business_aliases aa WHERE aa.business_id=b.business_id AND aa.status='active')=1
  LIMIT 2`).bind(periodKey(o),key.key_id,periodKey(o),o.producerId,o.monitoringBindingId,o.configurationRevision,o.observationKind,o.subjectKey,
   account?'connected':'no_account',account?.managerCustomerRef??null,account?.advertiserCustomerRef??null,p.provenance.sourceAccountRef,p.currencyCode,p.period?.timeZone??null,p.provenance.collectedBy).all<BindingRow>();
 if(rows.results.length!==1)throw new IntelIngestError('binding_not_active',403);
 const b=rows.results[0]!;
 if(b.key_revision!==key.key_revision||b.public_key!==key.public_key||b.key_state!==key.state)throw new IntelIngestError('producer_not_allowed',403);
 const context:OwnerGoogleAdsReviewedContext={producerId:b.producer_id,monitoringBindingId:b.binding_id,configurationRevision:b.configuration_revision,observationKind:b.observation_kind,subjectKey:b.subject_key,
  accountState:b.account_state,managerCustomerRef:b.manager_customer_ref,advertiserCustomerRef:b.advertiser_customer_ref,currencyCode:b.currency_code,timeZone:b.time_zone,sourceAccountRef:b.source_account_ref,collectedBy:b.collected_by};
 // Re-run complete exact binding-context validation now that the immutable
 // context is known; the initial strict parse only located this binding.
 const validated=validateOwnerGoogleAdsObservation(raw,context,now);
 const result=await acceptOwnerGoogleAdsObservation(database,key,validated,raw,headers.digest,b,now);
 return Response.json(result,{headers:{'Cache-Control':'no-store','Cloudflare-CDN-Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}

export async function acceptOwnerGoogleAdsObservation(database:D1,key:ProducerKey,o:OwnerGoogleAdsObservation,raw:Uint8Array,digest:string,b:BindingRow,now:number){
 const db=database.withSession('first-primary');
 const prior=await db.prepare('SELECT producer_id,payload_sha256,receipt_json FROM owner_intel_google_ads_inbox WHERE operation_id=?').bind(o.operationId).first<{producer_id:string;payload_sha256:string;receipt_json:string}>();
 if(prior){if(prior.producer_id!==key.producer_id||prior.payload_sha256!==digest)throw new IntelIngestError('operation_hash_conflict',409);return {receipt:JSON.parse(prior.receipt_json) as StoredReceipt,delivery:'duplicate' as const};}
 const cross=await db.prepare(`SELECT operation_id FROM ci_ingest_inbox WHERE operation_id=? UNION ALL SELECT operation_id FROM owner_intel_source_inbox WHERE operation_id=? LIMIT 1`).bind(o.operationId,o.operationId).first();
 if(cross)throw new IntelIngestError('operation_hash_conflict',409);
 const args=[o.monitoringBindingId,o.configurationRevision] as const,period=periodKey(o),previous=b.head_epoch===null||b.head_counter===null?null:{epoch:b.head_epoch,counter:b.head_counter};
 if(b.epoch!==null&&BigInt(o.sourceSequence.epoch)<BigInt(b.epoch))throw new IntelIngestError('source_epoch_regressed',409);
 const same=await db.prepare('SELECT operation_id FROM owner_intel_google_ads_inbox WHERE binding_id=? AND configuration_revision=? AND subject_key=? AND epoch=? AND counter=?').bind(...args,o.subjectKey,o.sourceSequence.epoch,o.sourceSequence.counter).first();
 if(same)throw new IntelIngestError('source_sequence_conflict',409);
 const isHead=!previous||tuple(o.sourceSequence,previous)>0;
 const rangeHead=b.range_head_operation_id?await db.prepare('SELECT i.epoch,i.counter,i.operation_id FROM owner_intel_google_ads_inbox i WHERE i.operation_id=?').bind(b.range_head_operation_id).first<{epoch:string;counter:string;operation_id:string}>():null;
 if(b.range_head_operation_id&&!rangeHead)throw new IntelIngestError('retryable',503);
 const updateRange=!rangeHead||tuple(o.sourceSequence,rangeHead)>0,shouldProject=updateRange;
 if(!Number.isSafeInteger(b.projection_revision)||b.projection_revision<0||b.projection_revision===Number.MAX_SAFE_INTEGER)throw new IntelIngestError('retryable',503);
 const acceptedAt=new Date(now).toISOString().replace(/\.\d{3}Z$/,'Z'),receipt:StoredReceipt={operationId:o.operationId,payloadSha256:digest,outcome:isHead?'accepted_head':'accepted_history',acceptedAt,epoch:o.sourceSequence.epoch,counter:o.sourceSequence.counter,headAfter:isHead?o.sourceSequence:previous!};
 const dto=JSON.stringify({schema:READ_SCHEMA,bindingId:o.monitoringBindingId,configurationRevision:o.configurationRevision,subjectKey:o.subjectKey,periodKey:period,periodDays:o.payload.period?.days??null,
  operationId:o.operationId,payloadSha256:digest,acceptedAt,completedAt:o.completedAt,observation:o});
 if(encoder.encode(dto).byteLength>262144)throw new IntelIngestError('retryable',503);
 const dtoHash=await hashHex(dto),body=new TextDecoder('utf-8',{fatal:true}).decode(raw),statements:D1PreparedStatement[]=[];
 statements.push(db.prepare(`INSERT INTO owner_intel_google_ads_batch_guards(operation_id,assertion) SELECT ?,CASE WHEN
  EXISTS(SELECT 1 FROM ci_ingest_control WHERE singleton=1 AND enabled=1)
  AND EXISTS(SELECT 1 FROM owner_intel_google_ads_control WHERE singleton=1 AND enabled=1 AND storage_accepted=1)
  AND EXISTS(SELECT 1 FROM ci_ingest_producer_keys WHERE producer_id=? AND key_id=? AND key_revision=? AND public_key=? AND state IN('active','previous'))
  AND NOT EXISTS(SELECT 1 FROM ci_ingest_inbox WHERE operation_id=?) AND NOT EXISTS(SELECT 1 FROM owner_intel_source_inbox WHERE operation_id=?)
  AND EXISTS(SELECT 1 FROM owner_intel_google_ads_bindings s JOIN owner_intel_bindings m ON m.binding_id=s.binding_id AND m.configuration_revision=s.configuration_revision
   JOIN owner_intel_businesses b ON b.business_id=m.business_id JOIN owner_intel_business_aliases x ON x.business_id=b.business_id
   JOIN ci_ingest_producer_bindings p ON p.producer_id=s.producer_id AND p.binding_id=s.binding_id
   WHERE s.producer_id=? AND s.binding_id=? AND s.configuration_revision=? AND s.subject_key=? AND s.observation_kind='google_ads_summary' AND s.active=1
    AND s.account_state=? AND s.manager_customer_ref IS ? AND s.advertiser_customer_ref IS ? AND s.source_account_ref IS ? AND s.currency_code IS ? AND s.time_zone IS ? AND s.collected_by=?
    AND m.status='reviewed' AND b.status='reviewed' AND b.version=? AND b.display_name=? AND x.route_key=? AND x.status='active'
    AND (SELECT COUNT(*) FROM owner_intel_business_aliases aa WHERE aa.business_id=b.business_id AND aa.status='active')=1
    AND p.active=1 AND p.configuration_revision=m.configuration_revision
    AND (SELECT COUNT(*) FROM owner_intel_google_ads_bindings ss WHERE ss.producer_id=s.producer_id AND ss.binding_id=s.binding_id AND ss.configuration_revision=s.configuration_revision AND ss.subject_key=s.subject_key AND ss.active=1)=1)
  AND (SELECT epoch FROM owner_intel_google_ads_epochs WHERE binding_id=? AND configuration_revision=?) IS ?
  AND (SELECT operation_id FROM owner_intel_google_ads_subject_heads WHERE binding_id=? AND configuration_revision=? AND subject_key=?) IS ?
  AND (SELECT operation_id FROM owner_intel_google_ads_range_heads WHERE binding_id=? AND configuration_revision=? AND subject_key=? AND period_key=?) IS ?
  AND (SELECT COALESCE(MAX(revision),0) FROM owner_intel_google_ads_projections WHERE binding_id=? AND configuration_revision=? AND subject_key=? AND period_key=?)=?
  THEN 1 ELSE 0 END`).bind(o.operationId,key.producer_id,key.key_id,key.key_revision,key.public_key,o.operationId,o.operationId,
  b.producer_id,...args,o.subjectKey,b.account_state,b.manager_customer_ref,b.advertiser_customer_ref,b.source_account_ref,b.currency_code,b.time_zone,b.collected_by,b.business_version,b.display_name,b.route_key,
  ...args,b.epoch,...args,o.subjectKey,b.head_operation_id,...args,o.subjectKey,period,b.range_head_operation_id??null,...args,o.subjectKey,period,b.projection_revision));
 statements.push(db.prepare('INSERT INTO owner_intel_google_ads_inbox(operation_id,producer_id,key_id,key_revision,binding_id,configuration_revision,subject_key,epoch,counter,period_key,period_days,payload_sha256,raw_body,observation_json,receipt_json,accepted_at,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .bind(o.operationId,key.producer_id,key.key_id,key.key_revision,...args,o.subjectKey,o.sourceSequence.epoch,o.sourceSequence.counter,period,o.payload.period?.days??null,digest,body,JSON.stringify(o),JSON.stringify(receipt),acceptedAt,receipt.outcome));
 if(b.epoch===null||BigInt(o.sourceSequence.epoch)>BigInt(b.epoch)){
  statements.push(db.prepare('INSERT INTO owner_intel_google_ads_epochs VALUES(?,?,?) ON CONFLICT(binding_id,configuration_revision) DO UPDATE SET epoch=excluded.epoch').bind(...args,o.sourceSequence.epoch));
  statements.push(db.prepare('INSERT INTO owner_intel_google_ads_epoch_audit VALUES(?,?,?,?,?,?)').bind(o.operationId,...args,b.epoch,o.sourceSequence.epoch,acceptedAt));
 }
 if(isHead)statements.push(db.prepare('INSERT INTO owner_intel_google_ads_subject_heads VALUES(?,?,?,?,?,?) ON CONFLICT(binding_id,configuration_revision,subject_key) DO UPDATE SET epoch=excluded.epoch,counter=excluded.counter,operation_id=excluded.operation_id').bind(...args,o.subjectKey,o.sourceSequence.epoch,o.sourceSequence.counter,o.operationId));
 if(updateRange)statements.push(db.prepare('INSERT INTO owner_intel_google_ads_range_heads VALUES(?,?,?,?,?) ON CONFLICT(binding_id,configuration_revision,subject_key,period_key) DO UPDATE SET operation_id=excluded.operation_id').bind(...args,o.subjectKey,period,o.operationId));
 if(shouldProject)statements.push(db.prepare(`INSERT INTO owner_intel_google_ads_projections(projection_id,binding_id,configuration_revision,subject_key,period_key,period_days,revision,source_operation_id,source_contract,read_schema,dto_json,dto_sha256,accepted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .bind(crypto.randomUUID(),...args,o.subjectKey,period,o.payload.period?.days??null,b.projection_revision+1,o.operationId,OWNER_GOOGLE_ADS_CONTRACT,READ_SCHEMA,dto,dtoHash,acceptedAt));
 statements.push(db.prepare('DELETE FROM owner_intel_google_ads_batch_guards WHERE operation_id=?').bind(o.operationId));
 try{await db.batch(statements);}catch{
  const raced=await db.prepare('SELECT producer_id,payload_sha256,receipt_json FROM owner_intel_google_ads_inbox WHERE operation_id=?').bind(o.operationId).first<{producer_id:string;payload_sha256:string;receipt_json:string}>();
  if(raced){if(raced.producer_id!==key.producer_id||raced.payload_sha256!==digest)throw new IntelIngestError('operation_hash_conflict',409);return {receipt:JSON.parse(raced.receipt_json) as StoredReceipt,delivery:'duplicate' as const};}
  const sequence=await db.prepare('SELECT operation_id FROM owner_intel_google_ads_inbox WHERE binding_id=? AND configuration_revision=? AND subject_key=? AND epoch=? AND counter=?').bind(...args,o.subjectKey,o.sourceSequence.epoch,o.sourceSequence.counter).first<string>('operation_id');
  if(sequence)throw new IntelIngestError('source_sequence_conflict',409);
  const cross=await db.prepare(`SELECT operation_id FROM ci_ingest_inbox WHERE operation_id=? UNION ALL SELECT operation_id FROM owner_intel_source_inbox WHERE operation_id=? LIMIT 1`).bind(o.operationId,o.operationId).first();
  if(cross)throw new IntelIngestError('operation_hash_conflict',409);
  throw new IntelIngestError('retryable',503);
 }
 return {receipt,delivery:'first' as const};
}

export async function readOwnerGoogleAdsProjection(database:D1Database,bindingId:string,configurationRevision:number,range:'7d'|'28d'|'90d',now=Date.now()):Promise<OwnerGoogleAdsRead|null>{
 const db=database.withSession('first-primary'),period=Number(range.slice(0,-1)) as 7|28|90;
 const binding=await db.prepare(`SELECT s.producer_id,s.binding_id,s.configuration_revision,s.subject_key,s.account_state,s.manager_customer_ref,s.advertiser_customer_ref,s.source_account_ref,s.currency_code,s.time_zone,s.collected_by,s.active
  FROM owner_intel_google_ads_bindings s JOIN owner_intel_bindings m ON m.binding_id=s.binding_id AND m.configuration_revision=s.configuration_revision AND m.status='reviewed'
  JOIN owner_intel_businesses b ON b.business_id=m.business_id AND b.status='reviewed'
  JOIN owner_intel_business_aliases x ON x.business_id=b.business_id AND x.status='active'
  JOIN ci_ingest_producer_bindings pb ON pb.producer_id=s.producer_id AND pb.binding_id=s.binding_id AND pb.configuration_revision=m.configuration_revision AND pb.active=1
  WHERE s.binding_id=? AND s.configuration_revision=? AND s.subject_key='own:google-ads' AND s.active=1
   AND EXISTS(SELECT 1 FROM ci_ingest_producer_keys k WHERE k.producer_id=s.producer_id AND k.state IN('active','previous'))
   AND (SELECT COUNT(*) FROM owner_intel_business_aliases aa WHERE aa.business_id=b.business_id AND aa.status='active')=1 LIMIT 2`).bind(bindingId,configurationRevision).all<BindingRow>();
 if(binding.results.length>1)throw new IntelIngestError('retryable',503);
 const selected=binding.results[0];if(!selected)return null;
 const gate=await db.prepare('SELECT enabled,storage_accepted FROM owner_intel_google_ads_control WHERE singleton=1').first<{enabled:number;storage_accepted:number}>();
 if(gate?.enabled!==1||gate.storage_accepted!==1)return null;
 const context:OwnerGoogleAdsReviewedContext={producerId:selected.producer_id,monitoringBindingId:selected.binding_id,configurationRevision:selected.configuration_revision,observationKind:'google_ads_summary',subjectKey:'own:google-ads',
  accountState:selected.account_state,managerCustomerRef:selected.manager_customer_ref,advertiserCustomerRef:selected.advertiser_customer_ref,currencyCode:selected.currency_code,timeZone:selected.time_zone,sourceAccountRef:selected.source_account_ref,collectedBy:selected.collected_by};
 const selectedPeriod=selected.account_state==='no_account'?'status':range;
 const head=await db.prepare('SELECT operation_id FROM owner_intel_google_ads_range_heads WHERE binding_id=? AND configuration_revision=? AND subject_key=? AND period_key=?').bind(bindingId,configurationRevision,'own:google-ads',selectedPeriod).first<string>('operation_id');
 if(!head)return null;
 const row=await db.prepare(`SELECT projection_id id,revision,period_days,source_contract,read_schema,dto_json,dto_sha256 FROM owner_intel_google_ads_projections WHERE binding_id=? AND configuration_revision=? AND subject_key=? AND period_key=? AND source_operation_id=? LIMIT 1`)
  .bind(bindingId,configurationRevision,'own:google-ads',selectedPeriod,head).first<{id:string;revision:number;period_days:number|null;source_contract:string;read_schema:string;dto_json:string;dto_sha256:string}>();
 if(!row)return null;
 if(!Number.isSafeInteger(row.revision)||row.revision<1||row.period_days!==(selected.account_state==='no_account'?null:period)||row.source_contract!==OWNER_GOOGLE_ADS_CONTRACT||row.read_schema!==READ_SCHEMA||encoder.encode(row.dto_json).byteLength>262144||await hashHex(row.dto_json)!==row.dto_sha256)throw new IntelIngestError('retryable',503);
 let value:unknown;try{value=parseDuplicateFreeJson(row.dto_json);}catch{throw new IntelIngestError('retryable',503);}
 if(!jsonObject(value)||value.schema!==READ_SCHEMA||value.bindingId!==bindingId||value.configurationRevision!==configurationRevision||value.subjectKey!=='own:google-ads'
  ||value.periodKey!==selectedPeriod||value.periodDays!==(selected.account_state==='no_account'?null:period)||typeof value.operationId!=='string'||typeof value.payloadSha256!=='string'||typeof value.acceptedAt!=='string'||typeof value.completedAt!=='string'||!jsonObject(value.observation))throw new IntelIngestError('retryable',503);
 const observation=validateOwnerGoogleAdsObservation(encoder.encode(JSON.stringify(value.observation)),context,now);
 if(observation.operationId!==value.operationId||observation.monitoringBindingId!==bindingId||observation.configurationRevision!==configurationRevision)throw new IntelIngestError('retryable',503);
 // Historical, fully closed windows remain immutable in the inbox. The
 // current owner read never labels an older window as the selected 7/28/90d
 // report: only the latest completed account-local day can anchor a result.
 if(observation.payload.period&&!isLatestClosedWindow(observation.payload.period,now))return null;
 const inbox=await db.prepare('SELECT producer_id,payload_sha256,observation_json,receipt_json,period_key FROM owner_intel_google_ads_inbox WHERE operation_id=? AND binding_id=? AND configuration_revision=?').bind(value.operationId,bindingId,configurationRevision).first<{producer_id:string;payload_sha256:string;observation_json:string;receipt_json:string;period_key:string}>();
 if(!inbox||inbox.producer_id!==selected.producer_id||inbox.payload_sha256!==value.payloadSha256||inbox.observation_json!==JSON.stringify(observation)||inbox.period_key!==selectedPeriod)throw new IntelIngestError('retryable',503);
 const receipt=JSON.parse(inbox.receipt_json) as StoredReceipt;if(receipt.operationId!==value.operationId||receipt.payloadSha256!==value.payloadSha256||receipt.acceptedAt!==value.acceptedAt)throw new IntelIngestError('retryable',503);
 const currentHead=await db.prepare('SELECT operation_id FROM owner_intel_google_ads_range_heads WHERE binding_id=? AND configuration_revision=? AND subject_key=? AND period_key=?').bind(bindingId,configurationRevision,'own:google-ads',selectedPeriod).first<string>('operation_id');
 if(currentHead!==value.operationId)throw new IntelIngestError('retryable',503);
 return {id:row.id,revision:row.revision,bindingId,configurationRevision,subjectKey:'own:google-ads',operationId:value.operationId,payloadSha256:value.payloadSha256,acceptedAt:value.acceptedAt,completedAt:value.completedAt,
  accountState:selected.account_state,contextJson:JSON.stringify(context),periodDays:observation.payload.period?.days??null,observation};
}

export async function ownerGoogleAdsProjectionStillCurrent(database:D1Database,source:OwnerGoogleAdsRead):Promise<boolean>{
 if(source.observation.payload.period&&!isLatestClosedWindow(source.observation.payload.period,Date.now()))return false;
 const db=database.withSession('first-primary');
 const gate=await db.prepare('SELECT enabled,storage_accepted FROM owner_intel_google_ads_control WHERE singleton=1').first<{enabled:number;storage_accepted:number}>();
 if(gate?.enabled!==1||gate.storage_accepted!==1)return false;
 const binding=await db.prepare(`SELECT s.producer_id,s.account_state,s.manager_customer_ref,s.advertiser_customer_ref,s.source_account_ref,s.currency_code,s.time_zone,s.collected_by
  FROM owner_intel_google_ads_bindings s JOIN owner_intel_bindings m ON m.binding_id=s.binding_id AND m.configuration_revision=s.configuration_revision AND m.status='reviewed'
  JOIN owner_intel_businesses b ON b.business_id=m.business_id AND b.status='reviewed'
  JOIN owner_intel_business_aliases x ON x.business_id=b.business_id AND x.status='active'
  JOIN ci_ingest_producer_bindings pb ON pb.producer_id=s.producer_id AND pb.binding_id=s.binding_id AND pb.configuration_revision=m.configuration_revision AND pb.active=1
  WHERE s.binding_id=? AND s.configuration_revision=? AND s.subject_key=? AND s.active=1
   AND EXISTS(SELECT 1 FROM ci_ingest_producer_keys k WHERE k.producer_id=s.producer_id AND k.state IN('active','previous'))
   AND (SELECT COUNT(*) FROM owner_intel_business_aliases aa WHERE aa.business_id=b.business_id AND aa.status='active')=1`).bind(source.bindingId,source.configurationRevision,source.subjectKey).first<{producer_id:string;account_state:'connected'|'no_account';manager_customer_ref:string|null;advertiser_customer_ref:string|null;source_account_ref:string|null;currency_code:string|null;time_zone:string|null;collected_by:string}>();
 if(!binding||binding.producer_id!==source.observation.producerId||binding.account_state!==source.accountState||JSON.stringify({producerId:binding.producer_id,monitoringBindingId:source.bindingId,configurationRevision:source.configurationRevision,observationKind:'google_ads_summary',subjectKey:source.subjectKey,
  accountState:binding.account_state,managerCustomerRef:binding.manager_customer_ref,advertiserCustomerRef:binding.advertiser_customer_ref,currencyCode:binding.currency_code,timeZone:binding.time_zone,sourceAccountRef:binding.source_account_ref,collectedBy:binding.collected_by})!==source.contextJson)return false;
 const key=source.periodDays===null?'status':`${source.periodDays}d`;
 const head=await db.prepare('SELECT operation_id FROM owner_intel_google_ads_range_heads WHERE binding_id=? AND configuration_revision=? AND subject_key=? AND period_key=?').bind(source.bindingId,source.configurationRevision,source.subjectKey,key).first<string>('operation_id');
 if(head!==source.operationId)return false;
 const projection=await db.prepare('SELECT projection_id FROM owner_intel_google_ads_projections WHERE binding_id=? AND configuration_revision=? AND subject_key=? AND period_key=? AND source_operation_id=?').bind(source.bindingId,source.configurationRevision,source.subjectKey,key,source.operationId).first<string>('projection_id');
 return projection===source.id;
}
