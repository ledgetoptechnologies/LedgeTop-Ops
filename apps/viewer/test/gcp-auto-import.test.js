'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {GcpRepository}=require('../server/gcpRepository');
const {autoImportAttachedEmlidGcp}=require('../server/datasetOperationWorker');
const {purgeExpiredTrash}=require('../server/storageLifecycle');

const validCsv='Name,Code,Code description,Easting,Northing,Elevation,Description,Longitude,Latitude,Ellipsoidal height,CS name\nGCP-1,,,903241.652,549596.746,833.164,Hub,-88.62836667,42.98018648,720.437,"NAD83(2011) / WISCRS Dodge (ftUS) + NAVD88(GEOID18) height (ftUS)"\n';
function fixture(t,rows){const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-gcp-auto-')),db=openDatabase(path.join(root,'viewer.sqlite')),processing=new ProcessingRepository(db),project=processing.createProject({displayName:'GCP auto import'}),dataset=processing.createDataset({projectId:project.id,displayName:'Raw data',storageMode:'managed',rootKey:'datasets',relativePath:'flight'}),files=[];for(const row of rows){const content=Buffer.from(row.content),relativePath=row.name,absolute=path.join(root,'datasets','flight',relativePath);fs.mkdirSync(path.dirname(absolute),{recursive:true});fs.writeFileSync(absolute,content);files.push({id:row.id,relativePath,byteSize:content.length,sha256:crypto.createHash('sha256').update(content).digest('hex'),contentType:'text/csv'});}processing.finalizeDataset(dataset.id,files,'a'.repeat(64));const storage={resolve(_root,relative,{mustExist}={}){const value=path.join(root,'datasets',...relative.split('/'));if(mustExist&&!fs.existsSync(value))throw Object.assign(new Error('missing'),{code:'ENOENT'});return value;}};t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});return{db,processing,dataset,storage};}

test('a valid attached Emlid CSV is auto-imported and the raw source is retained',async t=>{
  const f=fixture(t,[{id:'raw-gcp',name:'survey.csv',content:validCsv}]);
  const set=await autoImportAttachedEmlidGcp(f.dataset.id,f,'ops:test');
  assert.equal(set.sourceFileId,'raw-gcp');assert.equal(set.sourceFilename,'survey.csv');assert.equal(set.pointCount,1);
  assert.equal(f.processing.getDataset(f.dataset.id,true).files.length,1);
  assert.equal(fs.readFileSync(f.storage.resolve('datasets','flight/survey.csv',{mustExist:true}),'utf8'),validCsv);
  assert.equal(new GcpRepository(f.db).getSet(set.id,true).points[0].externalId,'GCP-1');
  assert.equal((await autoImportAttachedEmlidGcp(f.dataset.id,f,'ops:test')),null,'retries do not duplicate the imported set');
  assert.equal(f.processing.hasRetainedRawCsv(f.dataset.id),true);
  f.db.prepare("UPDATE datasets SET status='trashed' WHERE id=?").run(f.dataset.id);
  f.db.prepare("INSERT INTO storage_trash(id,entity_type,entity_id,root_key,relative_path,byte_size,purge_after,created_by,created_at) VALUES (?,'dataset',?,'trash','dataset/retained-flight',?,?,?,?)")
    .run('gcp-source-trash',f.dataset.id,Buffer.byteLength(validCsv),'2000-01-01T00:00:00.000Z','ops:test',new Date().toISOString());
  const removals=[];
  const purge=purgeExpiredTrash(f.processing,{removeExact:(...args)=>removals.push(args)},{actor:'maintenance'});
  assert.deepEqual(purge,[{trashId:'gcp-source-trash',status:'deferred',errorCode:'gcp_source_retained'}]);
  assert.equal(f.processing.beginPurgeMutation('gcp-source-trash','maintenance'),null,'manual purge mutation is refused too');
  assert.deepEqual(removals,[],'retention never removes a raw GCP CSV');
  assert.equal(fs.readFileSync(f.storage.resolve('datasets','flight/survey.csv',{mustExist:true}),'utf8'),validCsv);
});

test('invalid, ambiguous-unit, and multiple valid CSV attachments are ignored without changing raw data',async t=>{
  const invalid=fixture(t,[{id:'bad',name:'notes.csv',content:'not an Emlid export\n'}]);
  assert.equal(await autoImportAttachedEmlidGcp(invalid.dataset.id,invalid),null);
  assert.equal(invalid.processing.getDataset(invalid.dataset.id,true).files.length,1);
  const ambiguous=fixture(t,[{id:'ambiguous',name:'survey.csv',content:validCsv.replaceAll('(ftUS)','')}]);
  assert.equal(await autoImportAttachedEmlidGcp(ambiguous.dataset.id,ambiguous),null);
  const duplicate=fixture(t,[{id:'one',name:'one.csv',content:validCsv},{id:'two',name:'two.csv',content:validCsv.replace('GCP-1','GCP-2')}]);
  assert.equal(await autoImportAttachedEmlidGcp(duplicate.dataset.id,duplicate),null,'multiple valid survey files are not guessed');
  assert.equal(duplicate.processing.getDataset(duplicate.dataset.id,true).files.length,2);
});
