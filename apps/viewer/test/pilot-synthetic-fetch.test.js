'use strict';
// Run only in an isolated disposable container with an empty /fixture-state.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
test('synthetic transport validates all uploaded fixture bytes',{skip:process.env.LTDS_PILOT_SYNTHETIC_TEST!=='1'},async()=>{
 assert.equal(process.platform,'linux');assert.deepEqual(fs.readdirSync('/fixture-state'),[]);require('./helpers/pilot-synthetic-fetch.cjs');
 const base='https://127.0.0.1:28443',uuid='synthetic-task';
 await fetch(base+'/task/new/init',{method:'POST',headers:{'set-uuid':uuid}});
 const wrong=new FormData();wrong.append('images',new Blob(['wrong']),'photo-0.jpg');await assert.rejects(fetch(base+'/task/new/upload/'+uuid,{method:'POST',body:wrong}),/does not match/);
 const files=new FormData();for(let i=0;i<40;i++)files.append('images',new Blob([`synthetic-photo-${i}`]),`photo-${i}.jpg`);
 await fetch(base+'/task/new/upload/'+uuid,{method:'POST',body:files});await assert.rejects(fetch(base+'/task/new/upload/'+uuid,{method:'POST',body:files}),/does not match/);
 await fetch(base+'/task/new/commit/'+uuid,{method:'POST'});const status=await (await fetch(base+'/task/'+uuid+'/info')).json();assert.equal(status.imagesCount,40);assert.equal(status.status.code,40);
 await assert.rejects(fetch('https://elsewhere.invalid/info'),/unexpected endpoint/);
});
