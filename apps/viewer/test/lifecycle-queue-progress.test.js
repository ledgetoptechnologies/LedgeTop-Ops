'use strict';
// Retention can refuse a delete or purge for a long time. Maintenance tries
// twenty of each per pass, so refused work must not hide later work, and must
// itself stay untouched. All fixtures are invented.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {reconcileStorageMutations,purgeExpiredTrash}=require('../server/storageLifecycle');

const LIMIT=20;
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const EXPIRED='2020-01-01T00:00:00.000Z';

function fixture(t){
  const database=openDatabase(':memory:'),processing=new ProcessingRepository(database);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-lifecycle-queue-'));
  t.after(()=>{database.close();fs.rmSync(root,{recursive:true,force:true});});
  const storage={resolve:(key,relative)=>path.resolve(root,key,relative),
    pathExistsStrict(key,relative){return fs.existsSync(this.resolve(key,relative));},
    moveExact(a,source,b,destination){const target=this.resolve(b,destination);fs.mkdirSync(path.dirname(target),{recursive:true});fs.renameSync(this.resolve(a,source),target);},
    removeExact(key,relative){assert.equal(key,'trash');fs.rmSync(this.resolve(key,relative),{recursive:true});}};
  const project=processing.createProject({displayName:'Invented lifecycle'});
  let next=0;
  // `refused`: an indexed CSV that is missing from disk and was never retained.
  function dataset(refused){
    const value=processing.createDataset({projectId:project.id,displayName:`Dataset ${next++}`,storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
    const photo=storage.resolve('datasets',`${value.relativePath}/photo.jpg`);
    fs.mkdirSync(path.dirname(photo),{recursive:true});fs.writeFileSync(photo,'p');
    const files=[{relativePath:'photo.jpg',byteSize:1,sha256:sha('p')}];
    if(refused)files.push({relativePath:'control.csv',byteSize:3,sha256:sha('a,b')});
    processing.finalizeDataset(value.id,files,sha(value.id));
    return value;
  }
  function trashIntent(refused,index){
    const value=dataset(refused),mutation=processing.beginTrashMutation(value.id,'invented:staff');
    const at=new Date(1_700_000_000_000+index*1000).toISOString();
    database.prepare('UPDATE storage_mutations SET created_at=?,updated_at=? WHERE id=?').run(at,at,mutation.id);
    return {dataset:value,mutation};
  }
  // A dataset an earlier release moved to the Recycle Bin, now past its date.
  // Ids descend, because the unordered query returned the highest id first.
  function trashed(refused,{status='trashed'}={}){
    const value=dataset(refused),relative=`dataset/${value.id}`,id=`trash-${String(999-next).padStart(3,'0')}-${crypto.randomUUID()}`;
    storage.moveExact('datasets',value.relativePath,'trash',relative);
    database.prepare('UPDATE datasets SET status=? WHERE id=?').run(status,value.id);
    database.prepare("INSERT INTO storage_trash(id,entity_type,entity_id,root_key,relative_path,byte_size,purge_after,created_by,created_at) VALUES (?,'dataset',?,'datasets',?,1,?,'invented:staff',?)")
      .run(id,value.id,relative,EXPIRED,EXPIRED);
    return {id,dataset:value,photo:storage.resolve('trash',`${relative}/photo.jpg`)};
  }
  const row=id=>({...database.prepare('SELECT * FROM storage_trash WHERE id=?').get(id)});
  return {database,processing,storage,trashIntent,trashed,row};
}

test('refused deletes never hide a later delete from the bounded reconciliation',t=>{
  const c=fixture(t),refused=[];
  for(let index=0;index<LIMIT+5;index+=1)refused.push(c.trashIntent(true,index));
  const later=c.trashIntent(false,LIMIT+5);
  for(let pass=0;pass<2;pass+=1)reconcileStorageMutations(c.processing,c.storage,LIMIT);
  assert.equal(c.processing.getStorageMutation(later.mutation.id).status,'complete');
  for(const {dataset,mutation} of refused){
    assert.equal(c.processing.getStorageMutation(mutation.id).status,'intent');
    assert.ok(c.storage.pathExistsStrict('datasets',`${dataset.relativePath}/photo.jpg`),'nothing was moved');
  }
});

test('every pending delete is tried within a bounded number of passes',t=>{
  const c=fixture(t),ids=new Set(),tried=new Set();
  for(let index=0;index<LIMIT*2+5;index+=1)ids.add(c.trashIntent(true,index).mutation.id);
  for(let pass=0;pass<3;pass+=1)for(const result of reconcileStorageMutations(c.processing,c.storage,LIMIT))tried.add(result.id);
  assert.deepEqual([...tried].sort(),[...ids].sort());
});

test('a restored source lets a refused delete finish in its turn',t=>{
  const c=fixture(t),all=[];
  for(let index=0;index<LIMIT+5;index+=1)all.push(c.trashIntent(true,index));
  reconcileStorageMutations(c.processing,c.storage,LIMIT);
  const fixed=all[0];
  fs.writeFileSync(c.storage.resolve('datasets',`${fixed.dataset.relativePath}/control.csv`),'a,b');
  for(let pass=0;pass<2;pass+=1)reconcileStorageMutations(c.processing,c.storage,LIMIT);
  assert.equal(c.processing.getStorageMutation(fixed.mutation.id).status,'complete');
});

for(const [label,options] of [['by retention',{}],['before a purge record exists',{status:'finalized'}]]){
  test(`purges refused ${label} never hide a later purge and keep their files and date`,t=>{
    const c=fixture(t),refused=[];
    for(let index=0;index<LIMIT+5;index+=1)refused.push(c.trashed(true,options));
    const later=c.trashed(false),before=refused.map(item=>c.row(item.id));
    for(let pass=0;pass<2;pass+=1)purgeExpiredTrash(c.processing,c.storage,{limit:LIMIT});
    assert.equal(fs.existsSync(later.photo),false);
    assert.ok(c.row(later.id).permanently_deleted_at);
    refused.forEach((item,index)=>{assert.ok(fs.existsSync(item.photo));assert.deepEqual(c.row(item.id),before[index]);});
  });
}

test('every expired item is tried within a bounded number of passes, also by a new worker',t=>{
  const c=fixture(t),ids=new Set(),tried=new Set();
  for(let index=0;index<LIMIT*2+5;index+=1)ids.add(c.trashed(true).id);
  for(let pass=0;pass<3;pass+=1)
    for(const result of purgeExpiredTrash(new ProcessingRepository(c.database),c.storage,{limit:LIMIT}))tried.add(result.trashId);
  assert.deepEqual([...tried].sort(),[...ids].sort());
});

test('a pass that covers every item keeps the order and writes no position',t=>{
  const c=fixture(t),items=[];
  for(let index=0;index<3;index+=1)items.push(c.trashed(true));
  const listed=c.processing.expiredTrash().map(item=>item.id);
  assert.deepEqual(purgeExpiredTrash(c.processing,c.storage,{limit:LIMIT}).map(result=>result.trashId),listed);
  assert.deepEqual([...listed].sort(),items.map(item=>item.id).sort());
  assert.equal(c.database.prepare("SELECT COUNT(*) AS n FROM app_state WHERE key='trash_purge_cursor'").get().n,0);
});
