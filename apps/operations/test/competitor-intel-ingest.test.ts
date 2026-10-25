import { readFileSync } from 'node:fs';
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { dispatchCompetitorIntelIngest,type IntelIngestEnvironment } from '../src/worker/competitor-intel-ingest-routes';
import { strictIntelJson,validateIntelObservation,type IntelObservation } from '../src/worker/competitor-intel-ingest-schema';
import { INTEL_INGEST_PATH,base64url,intelDigest,intelSigningBytes,intelSignatureHeaders,verifyIntelSignature,readIntelBody,type ProducerKey } from '../src/worker/competitor-intel-ingest-security';
import { acceptIntelObservation } from '../src/worker/competitor-intel-ingest-store';

const ORIGIN='https://incoming.ledgetopdroneservices.com',TS='2026-10-22T23:30:00Z',NOW=Date.parse(TS);
// Frozen published TEST vector only; no installed producer key is accessed.
const key:ProducerKey={producer_id:'hermes-competitor-intel',key_id:'test-key-1',public_key:'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg',key_revision:1,state:'active'};
const encoder=new TextEncoder();
let privateKey:CryptoKey,runtime:Miniflare,db:D1Database,serial=0;
const id=()=>`00000000-0000-4000-8000-${(++serial).toString(16).padStart(12,'0')}`;
const source={url:'https://synthetic.example/',title:null,observedAt:TS,fetchStatus:'not_checked'};
const score=(scale='concern_0_10')=>({value:null,scale,state:'unknown',reason:'not_checked',confidence:null});
const stated={value:null,state:'unknown',reason:'not_checked'};
function observation(kind='competitor_profile',counter='1'):Record<string,unknown>{
 const payloads:Record<string,unknown>={
  competitor_profile:{name:'Synthetic Competitor',canonicalDomain:'synthetic.example',verifiedHomeUrl:null,homepageStatus:source,monitoringSince:null,lastSuccessfulCheckAt:null,
   sitePageCount:{...stated,source:null,checkedAt:null},monitoredPageCount:0,socialProfiles:[],active:false,scopeKey:'synthetic'},
  baseline_assessment:{competitorSubjectKey:'comp:one',assessedAt:TS,threat:score(),serviceOverlap:score('overlap_0_10'),geographicOverlap:stated,hasPricing:stated,marketPosition:stated,
   explanation:'Not checked',factors:{helps:[],hurts:[]},basisSnapshotCount:0,homepageStateAtAssessment:'not_checked'},
  change:{competitorSubjectKey:'comp:one',detectedAt:TS,pageUrl:source,pageTitle:null,changeType:'content_changed',significance:{value:null,confidence:null},category:{value:null,confidence:null},
   isNewService:stated,isPricingChange:stated,impact:score(),summary:'Synthetic change',addedSentences:[],removedSentences:[],producerReview:{state:'unreviewed',verdict:null,reviewedAt:null}},
  ad_activity:{competitorSubjectKey:'comp:one',checkedAt:TS,status:'unknown',reason:'not_checked',adCount:{value:null,approximate:false},lastShownDate:null,formats:[],policyRemovalNotice:null,
   activityEvidence:score('activity_evidence_0_10'),adCopyConcern:score(),sampledCreatives:[],sourceUrl:source},
  scan_run:{scanType:'website',trigger:'schedule',startedAt:TS,completedAt:null,nextScheduledAt:null,competitorsScanned:0,pages:{attempted:0,succeeded:0},changesDetected:0,errors:1,state:'failed'},
  self_assessment:{scopeKey:'synthetic',assessedAt:TS,positioning:score(),serviceCoverage:score(),geographicMessaging:score(),pricingClarity:score(),differentiation:score(),competitiveReadiness:score(),overall:score(),strengths:[],weaknesses:[],recommendedActions:[]},
 };
 return {schemaVersion:'ci.observation.v1',producerId:key.producer_id,operationId:id(),monitoringBindingId:'binding-synthetic',configurationRevision:1,
  observationKind:kind,subjectKey:kind==='change'?'change:one':kind==='scan_run'?'scan:one':kind==='self_assessment'?'self:one':'comp:one',
  sourceSequence:{epoch:'1',counter},commandBinding:null,observedAt:TS,completedAt:TS,semantics:{observation:'ci.obs.v1',scoring:'concern_0_10.v1'},payload:payloads[kind]??{}};
}
async function signed(value:unknown,url=`${ORIGIN}${INTEL_INGEST_PATH}`){
 const body=typeof value==='string'?value:JSON.stringify(value),digest=await intelDigest(encoder.encode(body));
 const headers={producer:key.producer_id,keyId:key.key_id,timestamp:TS,digest};
 const signature=base64url(new Uint8Array(await crypto.subtle.sign('Ed25519',privateKey,intelSigningBytes(headers) as BufferSource)));
 return new Request(url,{method:'POST',headers:{'Content-Type':'application/json','X-CI-Producer':headers.producer,'X-CI-Key-Id':headers.keyId,
  'X-CI-Timestamp':headers.timestamp,'X-CI-Content-SHA256':digest,'X-CI-Signature':signature},body});
}
function env():IntelIngestEnvironment{return {OPS_DB:db,ENVIRONMENT:'production',INCOMING_BASE_URL:ORIGIN,INCOMING_EXPECTED_HOST:'incoming.ledgetopdroneservices.com',COMPETITOR_INTEL_INGEST_ENABLED:'true'};}
async function post(value:unknown){return (await dispatchCompetitorIntelIngest(await signed(value),env(),NOW))!;}
async function direct(value:Record<string,unknown>,database=db){const bytes=encoder.encode(JSON.stringify(value)),o=validateIntelObservation(strictIntelJson(bytes),key.producer_id,NOW);return acceptIntelObservation(database,key,o,bytes,await intelDigest(bytes),NOW);}
async function count(table:string){return db.prepare(`SELECT COUNT(*) count FROM ${table}`).first<number>('count');}

beforeAll(async()=>{
 const der=new Uint8Array(48);der.set(Uint8Array.from([0x30,0x2e,0x02,0x01,0,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]));der.set(Uint8Array.from({length:32},(_,n)=>n),16);
 privateKey=await crypto.subtle.importKey('pkcs8',der,{name:'Ed25519'},false,['sign']);
 runtime=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:"export default {fetch(){return new Response('ok')}}",d1Databases:{OPS_DB:'intel-ingest-synthetic'}});
 db=await runtime.getD1Database('OPS_DB') as unknown as D1Database;
 await db.exec('CREATE TABLE staff_users(id TEXT PRIMARY KEY);');
 for(const name of ['0227_owner_intel_reads.sql','0228_competitor_intel_ingest.sql']){
  for(const statement of splitD1MigrationStatements(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8')))await db.prepare(statement).run();
 }
});
afterAll(async()=>{await runtime?.dispose();});
beforeEach(async()=>{
 // Independent exact binding per test avoids mutating immutable audit history.
 serial+=100;
 await db.prepare("INSERT OR REPLACE INTO ci_ingest_control VALUES(1,1)").run();
 await db.prepare("INSERT OR REPLACE INTO ci_ingest_producer_keys VALUES(?,?,?,?,?)").bind(key.producer_id,key.key_id,key.public_key,key.key_revision,key.state).run();
 // Clear mutable authority only; old evidence remains retained under earlier revisions.
 const b=await db.prepare("SELECT configuration_revision revision FROM owner_intel_bindings WHERE binding_id='binding-synthetic'").first<{revision:number}>();
 if(!b){await db.batch([db.prepare("INSERT INTO owner_intel_businesses VALUES('business-synthetic','Synthetic Business',1,'reviewed')"),db.prepare("INSERT INTO owner_intel_business_aliases VALUES('synthetic','business-synthetic','active')"),db.prepare("INSERT INTO owner_intel_bindings VALUES('binding-synthetic','business-synthetic',1,'reviewed')")]);}
 else {
  await db.prepare("UPDATE owner_intel_bindings SET configuration_revision=configuration_revision+1,status='reviewed' WHERE binding_id='binding-synthetic'").run();
 }
 const revision=await db.prepare("SELECT configuration_revision FROM owner_intel_bindings WHERE binding_id='binding-synthetic'").first<number>('configuration_revision');
 await db.prepare("INSERT OR REPLACE INTO ci_ingest_producer_bindings VALUES(?,?,?,1)").bind(key.producer_id,'binding-synthetic',revision).run();
});
async function current(value:Record<string,unknown>){value.configurationRevision=await db.prepare("SELECT configuration_revision FROM owner_intel_bindings WHERE binding_id='binding-synthetic'").first<number>('configuration_revision');return value;}

describe('frozen v1 verifier and bounded JSON',()=>{
 it('matches the exact frozen Ed25519 wire vector',async()=>{
  const body='{"schemaVersion":"ci.observation.v1","producerId":"hermes-competitor-intel","operationId":"00000000-0000-4000-8000-000000000001"}';
  const request=new Request(`${ORIGIN}${INTEL_INGEST_PATH}`,{method:'POST',headers:{'Content-Type':'application/json','X-CI-Producer':key.producer_id,'X-CI-Key-Id':key.key_id,'X-CI-Timestamp':TS,
   'X-CI-Content-SHA256':'HVjmtzK4gpdI4pDyQLlyQOZy_fapwQY_2v2VG8hjeeM','X-CI-Signature':'-B85KRlcNNoCoAV8F9TTACno54PvI_ysZdalzIRe-wnvFWIxbTZlZ9n6jEwbSSX72c07fyV3KjxFV29uYUE4CQ'},body});
  const headers=intelSignatureHeaders(request,NOW);await expect(verifyIntelSignature(encoder.encode(body),headers,key)).resolves.toBeUndefined();
  await expect(verifyIntelSignature(encoder.encode(`${body} `),headers,key)).rejects.toMatchObject({code:'digest_mismatch'});
  expect(()=>intelSignatureHeaders(new Request(`${ORIGIN}${INTEL_INGEST_PATH}?x=1`,request),NOW)).toThrow('header_invalid');
  expect(()=>intelSignatureHeaders(new Request(`${ORIGIN}${INTEL_INGEST_PATH}?`,request),NOW)).toThrow('header_invalid');
  expect(()=>intelSignatureHeaders(request,NOW+301_000)).toThrow('timestamp_out_of_window');
  const padded=new Request(request);padded.headers.set('X-CI-Signature',padded.headers.get('X-CI-Signature')+'=');
  expect(()=>intelSignatureHeaders(padded,NOW)).toThrow('header_invalid');
  await expect(verifyIntelSignature(encoder.encode(body),{...headers,signature:new Uint8Array(64)},key)).rejects.toMatchObject({code:'signature_invalid'});
 });
 it('cancels a chunked body as soon as it exceeds 256 KiB',async()=>{
  const cancel=vi.fn();let sends=0;
  const stream=new ReadableStream<Uint8Array>({pull(controller){sends++;controller.enqueue(new Uint8Array(200_000));},cancel});
  const request=new Request(`${ORIGIN}${INTEL_INGEST_PATH}`,{method:'POST',body:stream,duplex:'half'} as RequestInit);
  await expect(readIntelBody(request)).rejects.toMatchObject({code:'body_too_large'});
  expect(cancel).toHaveBeenCalled();expect(sends).toBeLessThanOrEqual(3);
 });
 it.each(['{"a":1,"a":2}','{"a":{"x":1,"\\u0078":2}}','{"a":[[[[[[{}]]]]]]}','[1]','{"a":1} trailing'])('rejects malformed/duplicate/deep input: %s',raw=>{expect(()=>strictIntelJson(encoder.encode(raw))).toThrow('schema_invalid');});
 it.each([new Uint8Array([0xff]),new Uint8Array([0xef,0xbb,0xbf,0x7b,0x7d]),encoder.encode('{"x":"\0"}')])('rejects invalid UTF8/BOM/NUL',raw=>{expect(()=>strictIntelJson(raw)).toThrow('encoding_invalid');});
 it.each(['competitor_profile','baseline_assessment','change','ad_activity','scan_run','self_assessment'])('accepts the specified non-Ads kind %s',kind=>{
  expect(validateIntelObservation(observation(kind),key.producer_id,NOW).observationKind).toBe(kind);
 });
 it('rejects v2, own Ads, malformed int63, false observations and unsupported command binding',()=>{
  expect(()=>validateIntelObservation({...observation(),schemaVersion:'ci.observation.v2'},key.producer_id,NOW)).toThrow('schema_version_unsupported');
  expect(()=>validateIntelObservation(observation('own_ads_checkup'),key.producer_id,NOW)).toThrow('schema_invalid');
  expect(()=>validateIntelObservation({...observation(),sourceSequence:{epoch:'01',counter:'1'}},key.producer_id,NOW)).toThrow('schema_invalid');
  expect(()=>validateIntelObservation({...observation(),commandBinding:{intentId:id(),leaseId:id(),fencingToken:'1'}},key.producer_id,NOW)).toThrow('command_binding_stale');
 });
});
describe('incoming-only admission and atomic inbox/projector',()=>{
 it('keeps exact host/path admission and default off without intercepting human routes',async()=>{
  const value=await current(observation()),request=await signed(value);
  expect(dispatchCompetitorIntelIngest(new Request('https://ops.ledgetop.app/api/intel/businesses'),env(),NOW)).toBeNull();
  expect(dispatchCompetitorIntelIngest(await signed(value,`https://ops.ledgetop.app${INTEL_INGEST_PATH}`),env(),NOW)).toBeNull();
  expect(dispatchCompetitorIntelIngest(request,{...env(),INCOMING_EXPECTED_HOST:'other.example'},NOW)).toBeNull();
  expect((await dispatchCompetitorIntelIngest(request,{...env(),COMPETITOR_INTEL_INGEST_ENABLED:undefined},NOW))!.status).toBe(404);
  expect((await post(value)).status).toBe(200);
 });
 it('retains exact immutable receipt on same body replay and rejects operation hash reuse',async()=>{
  const value=await current(observation()),first=await (await post(value)).json() as any,second=await (await post(value)).json() as any;
  expect(first.delivery).toBe('first');expect(second).toEqual({...first,delivery:'duplicate'});
  const conflict=await post({...value,completedAt:'2026-10-22T23:30:01Z'});expect(conflict.status).toBe(409);expect(await conflict.json()).toEqual({error:'operation_hash_conflict'});
 });
 it('uses numeric ordering and one cross-kind subject head; history never updates projection',async()=>{
  const p=await current(observation('competitor_profile','2'));await direct(p);
  const b=await current(observation('baseline_assessment','10'));await direct(b);
  const projectionBefore=await count('owner_intel_competitor_projections');
  const history=await direct(await current(observation('ad_activity','3')));expect(history.receipt.outcome).toBe('accepted_history');
  expect(await count('owner_intel_competitor_projections')).toBe(projectionBefore);
  await expect(direct(await current(observation('ad_activity','10')))).rejects.toMatchObject({code:'source_sequence_conflict'});
  const projected=await db.prepare('SELECT dto_json FROM owner_intel_competitor_projections WHERE binding_id=? AND configuration_revision=? ORDER BY revision DESC LIMIT 1').bind(p.monitoringBindingId,p.configurationRevision).first<string>('dto_json');
  expect(JSON.parse(projected!).competitors[0]).toMatchObject({baseline:{operationId:b.operationId},adActivity:null});
 });
 it('audits epoch advance and rejects regressed binding epoch across subjects',async()=>{
  const value=await current(observation());await direct(value);
  await direct({...await current(observation()),subjectKey:'comp:two',sourceSequence:{epoch:'10',counter:'1'}});
  await expect(direct({...await current(observation()),subjectKey:'comp:three',sourceSequence:{epoch:'2',counter:'99'}})).rejects.toMatchObject({code:'source_epoch_regressed'});
  expect(await db.prepare('SELECT epoch FROM ci_ingest_binding_epochs WHERE binding_id=? AND configuration_revision=?').bind(value.monitoringBindingId,value.configurationRevision).first<string>('epoch')).toBe('10');
 });
 it('rejects current binding/revision/key changes and never selects a default tenant',async()=>{
  const value=await current(observation());
  expect((await post({...value,monitoringBindingId:'unknown-binding'})).status).toBe(403);
  expect((await post({...value,configurationRevision:99999})).status).toBe(409);
  await db.prepare("UPDATE ci_ingest_producer_keys SET state='revoked'").run();
  expect((await post(value)).status).toBe(403);
 });
 it('rolls back inbox, heads, epoch and receipt when projection insertion fails',async()=>{
  const value=await current(observation()),before=await count('ci_ingest_inbox');
  await db.exec("CREATE TRIGGER synthetic_projection_failure BEFORE INSERT ON owner_intel_competitor_projections BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END;");
  try {await expect(direct(value)).rejects.toMatchObject({code:'retryable'});}finally{await db.exec('DROP TRIGGER synthetic_projection_failure;');}
  expect(await count('ci_ingest_inbox')).toBe(before);
  expect(await db.prepare('SELECT operation_id FROM ci_ingest_subject_heads WHERE binding_id=? AND configuration_revision=?').bind(value.monitoringBindingId,value.configurationRevision).first()).toBeNull();
  expect(await count('ci_ingest_batch_guards')).toBe(0);
  expect(await db.prepare('SELECT epoch FROM ci_ingest_binding_epochs WHERE binding_id=? AND configuration_revision=?').bind(value.monitoringBindingId,value.configurationRevision).first()).toBeNull();
  expect(await db.prepare('SELECT operation_id FROM ci_ingest_epoch_audit WHERE operation_id=?').bind(value.operationId).first()).toBeNull();
 });
 it('projects all eleven accepted profiles without truncation or invented measurements',async()=>{
  let value!:Record<string,unknown>;
  for(let n=0;n<11;n++){value={...await current(observation()),subjectKey:`comp:inventory-${n}`};await direct(value);}
  const json=await db.prepare('SELECT dto_json FROM owner_intel_competitor_projections WHERE binding_id=? AND configuration_revision=? ORDER BY revision DESC LIMIT 1')
   .bind(value.monitoringBindingId,value.configurationRevision).first<string>('dto_json');
  const dto=JSON.parse(json!);expect(dto.competitors).toHaveLength(11);
  expect(dto.competitors.every((c:any)=>c.sitePageCount.value===null&&c.baseline===null&&c.adActivity===null)).toBe(true);
  expect(dto.ownAds).toBeNull();expect(dto.manifest).toBeNull();
 });
 it('retains exact large whitespace bodies while reconstructing from bounded normalized JSON',async()=>{
  const value=await current(observation()),raw=' '.repeat(200_000)+JSON.stringify(value);
  expect((await post(raw)).status).toBe(200);
  const row=await db.prepare('SELECT raw_body,observation_json FROM ci_ingest_inbox WHERE operation_id=?').bind(value.operationId).first<{raw_body:string;observation_json:string}>();
  expect(row!.raw_body).toBe(raw);expect(row!.observation_json.length).toBeLessThan(2000);
  await direct({...await current(observation()),subjectKey:'comp:second'});
  const dto=await db.prepare('SELECT dto_json FROM owner_intel_competitor_projections WHERE binding_id=? AND configuration_revision=? ORDER BY revision DESC LIMIT 1').bind(value.monitoringBindingId,value.configurationRevision).first<string>('dto_json');
  expect(JSON.parse(dto!).competitors).toHaveLength(2);
 });
 it.each(['scan_run','self_assessment'])('keeps the other subject as latest when a higher-tuple %s replacement regresses its timestamp',async kind=>{
  async function sample(subject:string,counter:string,second:string){
   const value=await current(observation(kind,counter));
   const completedAt=`2026-10-22T23:30:${second}Z`,p=value.payload as Record<string,unknown>;
   value.subjectKey=`${kind==='scan_run'?'scan':'self'}:${subject}`;
   value.observedAt='2026-10-22T23:29:00Z';value.completedAt=completedAt;
   if(kind==='scan_run')Object.assign(p,{state:'completed',startedAt:'2026-10-22T23:29:00Z',completedAt});
   else Object.assign(p,{scopeKey:subject,assessedAt:completedAt});
   return value;
  }
  const a10=await sample('a','1','10'),b9=await sample('b','1','09'),a8=await sample('a','2','08');
  await direct(a10);await direct(b9);const accepted=await direct(a8);
  expect(accepted.receipt.outcome).toBe('accepted_head');
  expect(accepted.receipt.headAfter).toEqual({epoch:'1',counter:'2'});
  const json=await db.prepare('SELECT dto_json FROM owner_intel_competitor_projections WHERE binding_id=? AND configuration_revision=? ORDER BY revision DESC LIMIT 1')
   .bind(a8.monitoringBindingId,a8.configurationRevision).first<string>('dto_json');
  const dto=JSON.parse(json!);
  expect(kind==='scan_run'?dto.latestScan.completedAt:dto.selfAssessment.assessedAt).toBe('2026-10-22T23:30:09Z');
  expect(await db.prepare('SELECT counter FROM ci_ingest_subject_heads WHERE binding_id=? AND configuration_revision=? AND subject_key=?')
   .bind(a8.monitoringBindingId,a8.configurationRevision,a8.subjectKey).first<string>('counter')).toBe('2');
 });
 it('fails reconstruction capacity before returning oversized normalized head blobs to the Worker',async()=>{
  const statements:D1PreparedStatement[]=[];
  for(let n=0;n<35;n++){
   const value=await current(observation()),p=value.payload as Record<string,unknown>;
   value.subjectKey=`comp:large-${n}`;p.socialProfiles=Array.from({length:10},()=>({platform:'other',url:`https://synthetic.example/${'é'.repeat(1700)}`}));
   validateIntelObservation(value,key.producer_id,NOW);
   const body=JSON.stringify(value),digest=await intelDigest(encoder.encode(body));
   const receipt=JSON.stringify({operationId:value.operationId,payloadSha256:digest,outcome:'accepted_head',acceptedAt:TS,epoch:'1',counter:'1',headAfter:{epoch:'1',counter:'1'}});
   statements.push(db.prepare('INSERT INTO ci_ingest_inbox VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(value.operationId,key.producer_id,key.key_id,1,value.monitoringBindingId,value.configurationRevision,value.subjectKey,'competitor_profile','1','1',digest,body,body,receipt,TS,'accepted_head'));
   statements.push(db.prepare('INSERT INTO ci_ingest_kind_heads VALUES(?,?,?,?,?)').bind(value.monitoringBindingId,value.configurationRevision,value.subjectKey,'competitor_profile',value.operationId));
  }
  await db.batch(statements);
  const next=await current(observation()),before=await count('ci_ingest_inbox');
  await expect(direct(next)).rejects.toMatchObject({code:'retryable'});
  expect(await count('ci_ingest_inbox')).toBe(before);
  expect(await db.prepare('SELECT revision FROM owner_intel_competitor_projections WHERE binding_id=? AND configuration_revision=?').bind(next.monitoringBindingId,next.configurationRevision).first()).toBeNull();
 });
 it('fences concurrent observations atomically, then retries the loser from current state',async()=>{
  const a=await current(observation('competitor_profile','1')),b=await current(observation('baseline_assessment','2'));
  let arrivals=0,release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
  const wrapped={withSession:()=>({prepare:db.prepare.bind(db),batch:async(statements:D1PreparedStatement[])=>{arrivals++;if(arrivals===2)release();await barrier;return db.batch(statements);}})} as unknown as D1Database;
  const result=await Promise.allSettled([direct(a,wrapped),direct(b,wrapped)]);
  expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(result.filter(r=>r.status==='rejected')).toHaveLength(1);
  const loser=result[0]!.status==='rejected'?a:b;await direct(loser);
  const head=await db.prepare('SELECT counter FROM ci_ingest_subject_heads WHERE binding_id=? AND configuration_revision=? AND subject_key=?').bind(a.monitoringBindingId,a.configurationRevision,a.subjectKey).first<string>('counter');
  expect(head).toBe('2');expect(await count('ci_ingest_batch_guards')).toBe(0);
 });
});
