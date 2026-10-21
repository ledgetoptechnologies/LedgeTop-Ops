import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectTaskPhotos,prepareTaskPhotos,uploadTaskPhotos,TASK_PHOTO_LIMITS} from '../workspace-task-upload.mjs';
const file=(path,text='photo')=>{const blob=new Blob([text]);return {name:path.split('/').at(-1),webkitRelativePath:path.includes('/')?path:'',size:blob.size,type:'image/jpeg',arrayBuffer:()=>blob.arrayBuffer(),slice:(...args)=>blob.slice(...args)};};
const selection=()=>[file('flightB/DJI.jpg'),file('flightA/DJI.jpg'),file('flightA/other.JPG'),file('flightA/notes.txt')];
test('recursive folders preserve photo paths and deterministically disambiguate flat provider names without modifying originals',()=>{
  const files=selection(),a=inspectTaskPhotos(files),b=inspectTaskPhotos([...files].reverse());
  assert.deepEqual(a.items.map(x=>[x.id,x.relativePath]),b.items.map(x=>[x.id,x.relativePath]));assert.equal(a.items.length,3);assert.deepEqual(a.ignored,['flightA/notes.txt']);assert.equal(a.renamed.length,2);
  assert.equal(new Set(a.items.map(x=>x.relativePath.split('/').at(-1).toLowerCase())).size,3);assert.equal(a.items.find(x=>x.sourcePath==='flightA/other.JPG').relativePath,'flightA/other.JPG');assert.equal(files[0].name,'DJI.jpg');assert.equal(files[0].webkitRelativePath,'flightB/DJI.jpg');
});
test('flat picks, case collisions and generated filename collisions remain distinct',()=>{
  const a=inspectTaskPhotos([file('A/DJI.jpg'),file('B/dji.JPG'),file('DJI--photo-1.jpg')]);assert.equal(new Set(a.items.map(x=>x.relativePath.split('/').at(-1).toLowerCase())).size,3);
  assert.equal(inspectTaskPhotos([file('single.jpeg')]).items[0].relativePath,'single.jpeg');
});
test('unsafe paths, duplicates, empty and oversized selections fail before reading any photo',()=>{
  for(const path of ['../x.jpg','/x.jpg','a/../x.jpg','a\\x.jpg','C:/x.jpg','a//x.jpg'])assert.throws(()=>inspectTaskPhotos([file(path)]),/unsafe/);
  assert.throws(()=>inspectTaskPhotos([file('a.jpg'),file('a.jpg')]),/more than once/);assert.throws(()=>inspectTaskPhotos([file('a.txt')]),/supported/);assert.throws(()=>inspectTaskPhotos([file('a.jpg','')]),/nonempty/);
  for(const limits of [{maxFiles:1},{maxFileBytes:1},{maxTotalBytes:1}])assert.throws(()=>inspectTaskPhotos([file('a.jpg'),file('b.jpg')],{limits:{...TASK_PHOTO_LIMITS,...limits}}));
});
test('preparation hashes one original file at a time with stable resumable manifest order',async()=>{
  let active=0,max=0;const files=selection();for(const f of files){const read=f.arrayBuffer;f.arrayBuffer=async()=>{max=Math.max(max,++active);await new Promise(resolve=>setImmediate(resolve));const value=await read();active--;return value;};}
  const progress=[],prepared=await prepareTaskPhotos(files,{onProgress:p=>progress.push(p)}),again=await prepareTaskPhotos([...files].reverse());assert.equal(max,1);assert.deepEqual(prepared.manifest,again.manifest);assert.ok(prepared.manifest.every(x=>x.processingRole==='image'&&/^[a-f0-9]{64}$/.test(x.sha256)));assert.equal(progress.at(-1).completed,3);
  await assert.rejects(prepareTaskPhotos(files,{limits:{...TASK_PHOTO_LIMITS,maxManifestBytes:1}}),/manifest is too large/);
});
async function transport({mutate=()=>{},rejectChunk=false,signal,onChunk=()=>{},onProgress,now}={}){
  const prepared=await prepareTaskPhotos([file('a.jpg','abcdef')]),calls=[],chunks=[];let active=0,max=0;
  const api=async(path,options)=>{calls.push({path,options});if(path.endsWith('/uploads')){const response={uploadToken:'scoped-upload',upload:{id:'upload-id',datasetId:'dataset',status:'open',chunkSize:2,files:prepared.manifest.map(x=>({...x,chunkCount:3,missingChunks:[1,2]}))}};mutate(response);return response;}return {operation:{id:'assembly',status:'queued'}};};
  const fetcher=async(path,options)=>{max=Math.max(max,++active);chunks.push({path,options});await new Promise(resolve=>setImmediate(resolve));active--;onChunk();return {ok:!rejectChunk,status:rejectChunk?503:201};};
  return {prepared,calls,chunks,max:()=>max,run:()=>uploadTaskPhotos({datasetId:'dataset',prepared,api,token:()=> 'staff-token',fetcher,signal,onProgress,now})};
}

test('preparation reports local byte/photo progress and rejects oversized manifests before reading',async()=>{
  const progress=[],photos=[file('a.jpg','abc'),file('b.jpg','defgh')];
  await prepareTaskPhotos(photos,{onProgress:value=>progress.push(value)});
  assert.deepEqual(progress.map(({completed,completedBytes,total,totalBytes})=>[completed,completedBytes,total,totalBytes]),[[0,0,2,8],[1,3,2,8],[2,8,2,8]]);
  let reads=0;photos[0].arrayBuffer=async()=>{reads++;throw new Error('must not read');};
  await assert.rejects(prepareTaskPhotos(photos,{limits:{...TASK_PHOTO_LIMITS,maxManifestBytes:1}}),/manifest is too large/);
  assert.equal(reads,0);
});

test('upload reports acknowledged progress and average speed excluding resumed bytes',async()=>{
  let clock=1000;const progress=[],f=await transport({now:()=>clock,onChunk:()=>{clock+=1000;},onProgress:value=>progress.push(value)});
  await f.run();
  assert.equal(progress[0].completedBytes,2);assert.equal(progress[0].resumedBytes,2);assert.equal(progress[0].completed,0);assert.equal(progress[0].bytesPerSecond,0);
  const last=progress.at(-1);
  assert.equal(last.phase,'queued');assert.equal(last.completed,1);assert.equal(last.total,1);assert.equal(last.completedBytes,6);assert.equal(last.totalBytes,6);assert.equal(last.transferredBytes,4);assert.equal(last.bytesPerSecond,2);
  assert.equal(progress.at(-2).phase,'finalizing');
  assert.ok(progress.every((p,i)=>i===0||p.completedBytes>=progress[i-1].completedBytes));
});

test('fully resumed photos count as complete without invented transfer speed',async()=>{
  const progress=[],f=await transport({mutate:r=>r.upload.files[0].missingChunks=[],onProgress:value=>progress.push(value),now:()=>1000});
  await f.run();assert.equal(f.chunks.length,0);
  assert.ok(progress.every(p=>p.completed===1&&p.completedBytes===6&&p.transferredBytes===0&&p.bytesPerSecond===0));
});

test('failed chunks never inflate acknowledged progress or announce finalizing',async()=>{
  const progress=[],f=await transport({rejectChunk:true,onProgress:value=>progress.push(value)});
  await assert.rejects(f.run(),/503/);
  assert.deepEqual(progress.map(p=>[p.phase,p.completed,p.completedBytes,p.transferredBytes]),[['uploading',0,2,0]]);
});
test('upload sends only missing sequential hashed chunks then queues assembly without claiming task completion',async()=>{
  const f=await transport(),result=await f.run();assert.equal(f.max(),1);assert.equal(f.chunks.length,2);assert.match(f.chunks[0].path,/chunks\/1$/);assert.equal(new TextDecoder().decode(f.chunks[0].options.body),'cd');assert.equal(f.chunks[0].options.headers.Authorization,'Bearer staff-token');assert.equal(f.chunks[0].options.headers['X-Upload-Token'],'scoped-upload');assert.match(f.chunks[0].options.headers['X-Chunk-SHA256'],/^[a-f0-9]{64}$/);assert.equal(result.operation.status,'queued');assert.equal(f.calls.length,2);assert.match(f.calls[1].path,/\/finalize$/);
});
test('mismatched server manifests and unbounded chunk sizes fail before sending bytes',async()=>{
  for(const mutate of [r=>r.upload.chunkSize=99*1024**2,r=>r.upload.datasetId='other',r=>r.upload.files[0].sha256='f'.repeat(64),r=>r.upload.files[0].missingChunks=[3],r=>r.upload.files[0].missingChunks=[1,1]]){const f=await transport({mutate});await assert.rejects(f.run(),/invalid upload|does not match/);assert.equal(f.chunks.length,0);assert.equal(f.calls.length,1);}
});
test('failed chunk or cancelled upload never finalizes and can be resumed by reselection',async()=>{
  const failure=await transport({rejectChunk:true});await assert.rejects(failure.run(),/503.*resume/);assert.equal(failure.calls.length,1);
  const controller=new AbortController(),f=await transport({signal:controller.signal,onChunk:()=>controller.abort()});await assert.rejects(f.run(),{name:'AbortError'});assert.equal(f.chunks.length,1);assert.equal(f.calls.length,1);
  await assert.rejects(prepareTaskPhotos([file('a.jpg')],{signal:controller.signal}),{name:'AbortError'});
});
