import { IntelIngestError,envelopeSchema,type IntelObservation } from './competitor-intel-ingest-schema';
import type { ProducerKey } from './competitor-intel-ingest-security';
import { projectOwnerIntel,INTEL_FROZEN_CONTRACT,type AcceptedIntel } from './competitor-intel-ingest-projection';

type Inbox={producer_id:string;payload_sha256:string;receipt_json:string};
type Head={epoch:string;counter:string;operation_id:string};
type Binding={binding_id:string;configuration_revision:number;business_id:string;display_name:string;version:number;route_key:string;status:string};
export type IngestReceipt={operationId:string;payloadSha256:string;outcome:'accepted_head'|'accepted_history';acceptedAt:string;
 epoch:string;counter:string;headAfter:{epoch:string;counter:string}};
export type IngestResult={receipt:IngestReceipt;delivery:'first'|'duplicate'};
const tuple=(a:{epoch:string;counter:string},b:{epoch:string;counter:string})=>BigInt(a.epoch)<BigInt(b.epoch)?-1:BigInt(a.epoch)>BigInt(b.epoch)?1:BigInt(a.counter)<BigInt(b.counter)?-1:BigInt(a.counter)>BigInt(b.counter)?1:0;
export async function readIngestProducerKey(db:D1Database,producer:string,keyId:string):Promise<ProducerKey> {
 const row=await db.withSession('first-primary').prepare('SELECT producer_id,key_id,public_key,key_revision,state FROM ci_ingest_producer_keys WHERE producer_id=? AND key_id=?').bind(producer,keyId).first<ProducerKey>();
 if(!row)throw new IntelIngestError('producer_not_allowed',403);return row;
}
export async function acceptIntelObservation(database:D1Database,key:ProducerKey,o:IntelObservation,raw:Uint8Array,digest:string,now:number):Promise<IngestResult> {
 const db=database.withSession('first-primary');
 async function replay():Promise<IngestResult|null>{const prior=await db.prepare('SELECT producer_id,payload_sha256,receipt_json FROM ci_ingest_inbox WHERE operation_id=?').bind(o.operationId).first<Inbox>();
  if(!prior)return null;if(prior.producer_id!==key.producer_id||prior.payload_sha256!==digest)throw new IntelIngestError('operation_hash_conflict',409);
  return {receipt:JSON.parse(prior.receipt_json) as IngestReceipt,delivery:'duplicate'};}
 const duplicate=await replay();if(duplicate)return duplicate;
 const binding=await db.prepare(`SELECT m.binding_id,m.configuration_revision,m.business_id,m.status,b.display_name,b.version,x.route_key
  FROM owner_intel_bindings m JOIN owner_intel_businesses b ON b.business_id=m.business_id AND b.status='reviewed'
  JOIN owner_intel_business_aliases x ON x.business_id=b.business_id AND x.status='active'
  JOIN ci_ingest_producer_bindings p ON p.binding_id=m.binding_id AND p.producer_id=? AND p.active=1
  WHERE m.binding_id=? AND m.status='reviewed' AND p.configuration_revision=m.configuration_revision LIMIT 2`)
  .bind(key.producer_id,o.monitoringBindingId).all<Binding>();
 if(binding.results.length!==1)throw new IntelIngestError('binding_not_active',403);
 const b=binding.results[0]!;
 if(b.configuration_revision!==o.configurationRevision)throw new IntelIngestError('configuration_revision_stale',409);
 const args=[o.monitoringBindingId,o.configurationRevision] as const;
 const epoch=(await db.prepare('SELECT epoch FROM ci_ingest_binding_epochs WHERE binding_id=? AND configuration_revision=?').bind(...args).first<{epoch:string}>())?.epoch??null;
 if(epoch!==null&&BigInt(o.sourceSequence.epoch)<BigInt(epoch))throw new IntelIngestError('source_epoch_regressed',409);
 const previous=await db.prepare('SELECT epoch,counter,operation_id FROM ci_ingest_subject_heads WHERE binding_id=? AND configuration_revision=? AND subject_key=?').bind(...args,o.subjectKey).first<Head>();
 const same=await db.prepare('SELECT payload_sha256 FROM ci_ingest_inbox WHERE binding_id=? AND configuration_revision=? AND subject_key=? AND epoch=? AND counter=?').bind(...args,o.subjectKey,o.sourceSequence.epoch,o.sourceSequence.counter).first();
 if(same)throw new IntelIngestError('source_sequence_conflict',409);
 const isHead=!previous||tuple(o.sourceSequence,previous)>0;
 const projectionRevision=(await db.prepare('SELECT COALESCE(MAX(revision),0) revision FROM owner_intel_competitor_projections WHERE binding_id=? AND configuration_revision=?').bind(...args).first<{revision:number}>())?.revision??0;
 if(!Number.isSafeInteger(projectionRevision)||projectionRevision<0||projectionRevision===Number.MAX_SAFE_INTEGER)throw new IntelIngestError('retryable',503);
 let dto:string|null=null;
 if(isHead){
  // Bound reconstruction in the SAME SQLite snapshot before any JSON blobs
  // cross into the Worker. Raw bodies can contain 256 KiB of whitespace each;
  // keep those immutable bytes, but project from normalized accepted JSON.
  const heads=await db.prepare(`WITH selected AS (
   SELECT i.observation_json,i.payload_sha256 FROM ci_ingest_kind_heads h JOIN ci_ingest_inbox i ON i.operation_id=h.operation_id
   WHERE h.binding_id=? AND h.configuration_revision=? AND h.observation_kind NOT IN('scan_run','self_assessment')
  ),totals AS (SELECT COUNT(*) total,COALESCE(SUM(length(CAST(observation_json AS BLOB))),0) bytes FROM selected)
  SELECT s.observation_json raw_body,s.payload_sha256,t.total,t.bytes FROM totals t LEFT JOIN selected s
   ON t.total<=350 AND t.bytes<=1048576 LIMIT 351`).bind(...args).all<{raw_body:string|null;payload_sha256:string;total:number;bytes:number}>();
  if(!heads.results.length||heads.results[0]!.total>350||heads.results[0]!.bytes>1048576)throw new IntelIngestError('retryable',503);
  const accepted:AcceptedIntel[]=heads.results.filter(row=>row.raw_body!==null).map(row=>({observation:envelopeSchema.parse(JSON.parse(row.raw_body!)),digest:row.payload_sha256}));
  for(const kind of ['scan_run','self_assessment']){
   const row=await db.prepare(`SELECT i.observation_json raw_body,i.payload_sha256 FROM ci_ingest_kind_heads h JOIN ci_ingest_inbox i ON i.operation_id=h.operation_id
    WHERE h.binding_id=? AND h.configuration_revision=? AND h.observation_kind=?
     AND NOT(h.observation_kind=? AND h.subject_key=?)
    ORDER BY json_extract(i.raw_body,'$.completedAt') DESC,i.operation_id DESC LIMIT 1`)
    .bind(...args,kind,o.observationKind,o.subjectKey).first<{raw_body:string;payload_sha256:string}>();
   if(row)accepted.push({observation:envelopeSchema.parse(JSON.parse(row.raw_body)),digest:row.payload_sha256});
  }
  const filtered=accepted.filter(row=>!(row.observation.observationKind===o.observationKind&&row.observation.subjectKey===o.subjectKey));
  filtered.push({observation:o,digest});dto=projectOwnerIntel(filtered,b);
 }
 const acceptedAt=new Date(now).toISOString().replace(/\.\d{3}Z$/,'Z');
 const receipt:IngestReceipt={operationId:o.operationId,payloadSha256:digest,outcome:isHead?'accepted_head':'accepted_history',acceptedAt,
  epoch:o.sourceSequence.epoch,counter:o.sourceSequence.counter,headAfter:isHead?o.sourceSequence:{epoch:previous!.epoch,counter:previous!.counter}};
 const body=new TextDecoder('utf-8',{fatal:true}).decode(raw),receiptJson=JSON.stringify(receipt);
 const statements:D1PreparedStatement[]=[];
 statements.push(db.prepare(`INSERT INTO ci_ingest_batch_guards(operation_id,assertion) SELECT ?,CASE WHEN
  EXISTS(SELECT 1 FROM ci_ingest_control WHERE singleton=1 AND enabled=1)
  AND EXISTS(SELECT 1 FROM ci_ingest_producer_keys WHERE producer_id=? AND key_id=? AND key_revision=? AND public_key=? AND state IN('active','previous'))
  AND EXISTS(SELECT 1 FROM owner_intel_bindings m JOIN owner_intel_businesses b ON b.business_id=m.business_id
   JOIN owner_intel_business_aliases x ON x.business_id=b.business_id JOIN ci_ingest_producer_bindings p ON p.binding_id=m.binding_id
   WHERE m.binding_id=? AND m.configuration_revision=? AND m.status='reviewed' AND m.business_id=? AND b.status='reviewed'
    AND b.version=? AND b.display_name=? AND x.route_key=? AND x.status='active' AND p.producer_id=? AND p.active=1 AND p.configuration_revision=m.configuration_revision
    AND (SELECT COUNT(*) FROM owner_intel_business_aliases aliases WHERE aliases.business_id=m.business_id AND aliases.status='active')=1)
  AND (SELECT epoch FROM ci_ingest_binding_epochs WHERE binding_id=? AND configuration_revision=?) IS ?
  AND (SELECT operation_id FROM ci_ingest_subject_heads WHERE binding_id=? AND configuration_revision=? AND subject_key=?) IS ?
  AND (SELECT COALESCE(MAX(revision),0) FROM owner_intel_competitor_projections WHERE binding_id=? AND configuration_revision=?)=?
  THEN 1 ELSE 0 END`).bind(o.operationId,key.producer_id,key.key_id,key.key_revision,key.public_key,...args,b.business_id,b.version,b.display_name,b.route_key,key.producer_id,
   ...args,epoch,...args,o.subjectKey,previous?.operation_id??null,...args,projectionRevision));
 statements.push(db.prepare(`INSERT INTO ci_ingest_inbox(operation_id,producer_id,key_id,key_revision,binding_id,configuration_revision,subject_key,observation_kind,epoch,counter,payload_sha256,raw_body,observation_json,receipt_json,accepted_at,outcome)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(o.operationId,key.producer_id,key.key_id,key.key_revision,...args,o.subjectKey,o.observationKind,o.sourceSequence.epoch,o.sourceSequence.counter,digest,body,JSON.stringify(o),receiptJson,acceptedAt,receipt.outcome));
 if(epoch===null||BigInt(o.sourceSequence.epoch)>BigInt(epoch)){
  statements.push(db.prepare(`INSERT INTO ci_ingest_binding_epochs VALUES(?,?,?) ON CONFLICT(binding_id,configuration_revision) DO UPDATE SET epoch=excluded.epoch`).bind(...args,o.sourceSequence.epoch));
  statements.push(db.prepare('INSERT INTO ci_ingest_epoch_audit VALUES(?,?,?,?,?,?)').bind(o.operationId,...args,epoch,o.sourceSequence.epoch,acceptedAt));
 }
 if(isHead){
  statements.push(db.prepare(`INSERT INTO ci_ingest_subject_heads VALUES(?,?,?,?,?,?) ON CONFLICT(binding_id,configuration_revision,subject_key) DO UPDATE SET epoch=excluded.epoch,counter=excluded.counter,operation_id=excluded.operation_id`).bind(...args,o.subjectKey,o.sourceSequence.epoch,o.sourceSequence.counter,o.operationId));
  statements.push(db.prepare(`INSERT INTO ci_ingest_kind_heads VALUES(?,?,?,?,?) ON CONFLICT(binding_id,configuration_revision,subject_key,observation_kind) DO UPDATE SET operation_id=excluded.operation_id`).bind(...args,o.subjectKey,o.observationKind,o.operationId));
  const dtoHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(dto!)))).map(v=>v.toString(16).padStart(2,'0')).join('');
  statements.push(db.prepare(`INSERT INTO owner_intel_competitor_projections VALUES(?,?,?,?,?,'ops.intel.competitors.v1',?,?,?)`).bind(crypto.randomUUID(),...args,projectionRevision+1,INTEL_FROZEN_CONTRACT,dto,dtoHash,acceptedAt));
 }
 statements.push(db.prepare('DELETE FROM ci_ingest_batch_guards WHERE operation_id=?').bind(o.operationId));
 try{await db.batch(statements);}catch{
  const raced=await replay();if(raced)return raced;
  // A raced sequence, epoch, authority or projection witness is retried from
  // fresh primary state. No partial inbox/head/projection can commit.
  throw new IntelIngestError('retryable',503);
 }
 return {receipt,delivery:'first'};
}
