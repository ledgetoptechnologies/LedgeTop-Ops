'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),express=require('express');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');
const {detectGcpInterchange}=require('../server/gcpImport');
const {discoverDatasetGcpSources}=require('../server/gcpSourceDiscovery');
const {createProcessingApi}=require('../server/processingApi');
const auth=require('../server/auth');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const generic='point_id,label,latitude,longitude,elevation_m\r\nA,Control,44.5,-88.1,250\r\n';
const emlid='Name,Easting,Northing,Elevation,Latitude,Longitude,Ellipsoidal height,CS name\r\n'+
  'A,100,200,800,44.5,-88.1,900,Test horizontal (ftUS) vertical (ftUS)\r\n';

async function fixture(t){
  const database=openDatabase(':memory:'),processing=new ProcessingRepository(database),repository=new ViewerRepository(database);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-gcp-discovery-')),identity=fs.statSync(root,{bigint:true});
  const project=processing.createProject({displayName:'Synthetic discovery'}),dataset=processing.createDataset({projectId:project.id,
    displayName:'Flight',storageMode:'managed',rootKey:'datasets',relativePath:'flight'});
  const contents=[['source-a','emlid.csv',emlid],['source-b','invalid.csv','unrelated,notes\r\n1,hello\r\n'],
    ['source-c','points.csv',generic],['source-d','broken.csv',generic]];
  const files=contents.map(([id,relativePath,content])=>{const bytes=Buffer.from(content),target=path.join(root,'flight',relativePath);
    fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
    return{id,relativePath,byteSize:bytes.length,sha256:hash(bytes),processingRole:'gcp_source'};});
  processing.finalizeDataset(dataset.id,files,hash(Buffer.from('manifest')));
  fs.writeFileSync(path.join(root,'flight','broken.csv'),'tampered');
  const storage={resolve(key,relative){assert.equal(key,'datasets');const target=path.resolve(root,relative);
    assert.ok(target.startsWith(root+path.sep));return target;}};
  const writer=crypto.randomBytes(32).toString('base64url'),reader=crypto.randomBytes(32).toString('base64url');
  for(const [token,permissions] of [[writer,['viewer.gcp.read','viewer.gcp.write']],[reader,['viewer.gcp.read']]])
    processing.createAdminSession({tokenHash:auth.hashToken(token),subject:'synthetic:staff',permissions,
      expiresAt:new Date(Date.now()+60000).toISOString()});
  const app=express();app.use(express.json({verify(req,res,bytes){req.rawBody=Buffer.from(bytes);}}));
  app.use(createProcessingApi({processing,repository,storage}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));database.close();const current=fs.statSync(root,{bigint:true});
    assert.equal(current.dev,identity.dev);assert.equal(current.ino,identity.ino);
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'ltds-gcp-discovery-'));fs.rmSync(root,{recursive:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(suffix,{token=writer,method='GET',body}={})=>fetch(base+suffix,{method,headers:{authorization:`Bearer ${token}`,
    'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},...(body?{body:JSON.stringify(body)}:{})});
  return{database,processing,repository,storage,dataset,writer,reader,root,request,path:`/api/v1/datasets/${dataset.id}`};
}

test('automatic detection recognizes explicit Emlid/generic CSV and ignores invalid or ambiguous numbers/units',()=>{
  assert.equal(detectGcpInterchange(emlid).format,'emlid-all-columns-v1');
  assert.equal(detectGcpInterchange(generic).pointCount,1);
  for(const invalid of ['notes,only\nhello,world',generic.replace('44.5',''),generic.replace('250','0x10'),
    generic.replace('44.5','Infinity'),emlid.replaceAll('(ftUS)',''),emlid.replace('100,200','100,'),
    generic.replace('point_id,label','point_id,point_id')])assert.equal(detectGcpInterchange(invalid),null);
  assert.equal(detectGcpInterchange('x\n'.repeat(6000)),null);
});

test('hybrid schemas and malformed quoted numeric cells are ignored without choosing an authority',()=>{
  const hybrid=emlid.replace('CS name\r\n','CS name,point_id,label,elevation_m\r\n')
    .replace('(ftUS)\r\n','(ftUS),B,Other,9999\r\n');
  assert.equal(detectGcpInterchange(hybrid),null);
  assert.equal(detectGcpInterchange(generic.replace('44.5','"44".5')),null);
  assert.equal(detectGcpInterchange(emlid.replace('100,200','"1"00,200')),null);
});

test('valid quoted commas, escaped quotes, multiline fields and CRLF remain detectable',()=>{
  const quoted=generic.replace('A,Control,44.5,-88.1,250','A,"North, ""target""\r\nsecond line","44.5","-88.1","250"');
  assert.equal(detectGcpInterchange(quoted).pointCount,1);
});

test('bounded discovery pages valid candidates without mutating raw files or the database',async t=>{
  const c=await fixture(t),before=c.database.prepare('SELECT total_changes() n').get().n;
  const first=discoverDatasetGcpSources({database:c.database,storage:c.storage,datasetId:c.dataset.id,limit:2});
  assert.deepEqual(first.candidates.map(value=>value.sourceFileId),['source-a']);assert.equal(first.ignored,1);
  const next=discoverDatasetGcpSources({database:c.database,storage:c.storage,datasetId:c.dataset.id,afterId:first.nextAfterId,limit:2});
  assert.deepEqual(next.candidates.map(value=>value.sourceFileId),['source-c']);assert.equal(next.unavailable,1);assert.equal(next.nextAfterId,null);
  assert.equal(c.database.prepare('SELECT total_changes() n').get().n,before);
  assert.equal(fs.readFileSync(path.join(c.root,'flight','emlid.csv'),'utf8'),emlid);
  assert.throws(()=>discoverDatasetGcpSources({database:c.database,storage:c.storage,datasetId:c.dataset.id,limit:6}),{code:'invalid_gcp_discovery_page'});
});

test('staff discovery is read-scoped; dataset source IDs preview and import through existing confirmation',async t=>{
  const c=await fixture(t),listed=await c.request(c.path+'/gcp-source-candidates?limit=2',{token:c.reader});
  assert.equal(listed.status,200);assert.equal(listed.headers.get('cache-control'),'private, no-store');
  const candidate=(await listed.json()).candidates[0];assert.equal(candidate.sourceFileId,'source-a');
  assert.doesNotMatch(JSON.stringify(candidate),/relative_path|root_key|content|sample/);
  const previewBody={format:candidate.format,sourceFileId:candidate.sourceFileId};
  assert.equal((await c.request(c.path+'/gcp-sets/import-preview',{token:c.reader,method:'POST',body:previewBody})).status,403);
  const preview=await c.request(c.path+'/gcp-sets/import-preview',{method:'POST',body:previewBody});assert.equal(preview.status,200);
  const parsed=await preview.json();assert.equal(parsed.pointCount,1);
  const imported=await c.request(c.path+'/gcp-sets/import',{method:'POST',body:{...previewBody,displayName:'Detected control',confirmationToken:parsed.confirmationToken}});
  assert.equal(imported.status,201);const result=await imported.json();assert.equal(result.points.length,1);
  assert.equal(result.set.sourceOriginal.fileName,'emlid.csv');
  assert.equal(c.database.prepare('SELECT count(*) n FROM viewer_gcp_source_originals').get().n,1);
});

test('source substitution, wrong dataset, bad input and missing confirmation never create a set',async t=>{
  const c=await fixture(t),base={format:'emlid-all-columns-v1',sourceFileId:'source-a'};
  assert.equal((await c.request(c.path+'/gcp-sets/import',{method:'POST',body:{...base,displayName:'No confirmation'}})).status,409);
  assert.equal((await c.request(c.path+'/gcp-sets/import-preview',{method:'POST',body:{format:'generic-csv-v1',sourceFileId:'source-b'}})).status,400);
  assert.equal((await c.request(c.path+'/gcp-sets/import-preview',{method:'POST',body:{...base,sourceFileId:'source-d'}})).status,400);
  assert.equal((await c.request('/api/v1/datasets/other/gcp-sets/import-preview',{method:'POST',body:base})).status,400);
  const preview=await(await c.request(c.path+'/gcp-sets/import-preview',{method:'POST',body:base})).json();
  fs.writeFileSync(path.join(c.root,'flight','emlid.csv'),emlid.replace('100,200','999,200'));
  assert.equal((await c.request(c.path+'/gcp-sets/import',{method:'POST',body:{...base,displayName:'Changed',confirmationToken:preview.confirmationToken}})).status,400);
  assert.equal(c.database.prepare('SELECT count(*) n FROM gcp_sets').get().n,0);
});
