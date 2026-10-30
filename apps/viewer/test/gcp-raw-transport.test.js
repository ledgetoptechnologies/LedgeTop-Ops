'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {mountDraftRawGcpRoutes,RAW_GCP_JSON_LIMIT}=require('../server/gcpRawTransport');
const {MAX_SOURCE_BYTES}=require('../server/gcpImport');

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'raw-gcp-transport-')), db=openDatabase(path.join(root,'db.sqlite'));
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  const p=new ProcessingRepository(db), project=p.createProject({displayName:'Synthetic'}),dataset=p.createDataset({projectId:project.id,displayName:'Synthetic',storageMode:'managed',rootKey:'datasets',relativePath:'flight'});
  p.finalizeDataset(dataset.id,[],'a'.repeat(64));
  const routes=new Map(),calls=[];
  const router={post:(name,...handlers)=>routes.set(name,handlers)};
  const authorize=permission=>{assert.equal(permission,'viewer.gcp.write');return (req,res,next)=>{calls.push('authorize');if(!req.allowed)return res.status(403).json({code:'denied'});req.actorId='synthetic-admin';next();};};
  const jsonParser=options=>{assert.equal(options.limit,RAW_GCP_JSON_LIMIT);assert.ok(options.limit>Math.ceil(MAX_SOURCE_BYTES/3)*4);return(req,_res,next)=>{calls.push('parse');const raw=Buffer.from(JSON.stringify(req.body));options.verify(req,null,raw);next();};};
  const mutate=(req,_res,next)=>{calls.push('mutate');assert.ok(req.rawBody?.length);next();};
  mountDraftRawGcpRoutes(router,{processing:p,authorize,mutate,jsonParser,capacityPolicy:{maxJournalBytes:3*MAX_SOURCE_BYTES,maxJournalEntries:5}});
  function invoke(suffix,body,{allowed=true,key='request-123'}={}){
    const req={params:{datasetId:dataset.id},body,allowed,get:name=>name==='Idempotency-Key'?key:undefined};
    const res={statusCode:200,status(n){this.statusCode=n;return this},json(value){this.value=value;return this}};
    const chain=routes.get(`/api/v1/datasets/:datasetId/gcp-sets/raw/${suffix}`);let index=0;
    function next(){const handler=chain[index++];if(handler)handler(req,res,next)}next();return res;
  }
  return {db,dataset,calls,invoke};
}
const bytes=Buffer.from('\ufeffpoint_id,label,latitude,longitude,elevation_m\r\nA,A,44,-88,250\r\n');
const previewBody={encoded:bytes.toString('base64'),format:'generic-csv-v1'};

test('authorization occurs before large-body parser on both draft routes',t=>{
  const f=fixture(t);for(const route of ['preview','prepare']){f.calls.length=0;assert.equal(f.invoke(route,previewBody,{allowed:false}).statusCode,403);assert.deepEqual(f.calls,['authorize']);}
});
test('preview binds exact bytes and preparation only returns pending',t=>{
  const f=fixture(t), preview=f.invoke('preview',previewBody);assert.equal(preview.statusCode,200);assert.equal(preview.value.byteSize,bytes.length);
  const body={...previewBody,confirmationToken:preview.value.confirmationToken,fileName:'survey.csv',displayName:'Control',requestKey:'request-123'};
  f.calls.length=0;const prepared=f.invoke('prepare',body);assert.equal(prepared.statusCode,202);assert.equal(prepared.value.status,'pending');assert.deepEqual(f.calls,['authorize','parse','mutate']);
  assert.deepEqual(Buffer.from(f.db.prepare('SELECT source_bytes FROM viewer_gcp_raw_sources WHERE id=?').get(prepared.value.journalId).source_bytes),bytes);
  assert.equal(f.db.prepare('SELECT count(*) n FROM gcp_sets').get().n,0);
  assert.equal(f.invoke('prepare',{...body,encoded:Buffer.from('other').toString('base64')}).statusCode,400);
  assert.equal(f.invoke('prepare',body,{key:'different-key'}).statusCode,400);
});
