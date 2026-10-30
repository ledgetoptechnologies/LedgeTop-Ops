'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {copyPilotPhotos}=require('./helpers/pilot-photo-fixture.cjs');
test('pilot photo copies are bounded, verified and reject symlinks',{skip:process.platform!=='linux'},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-pilot-photos-')),input=path.join(root,'in'),out=path.join(root,'out');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(input);fs.mkdirSync(out);
 for(let i=0;i<40;i++)fs.writeFileSync(path.join(input,`photo-${i}.jpg`),`photo-${i}`);
 const result=copyPilotPhotos({input,destination:out,maxTotalBytes:1000});assert.equal(result.files.length,40);assert.equal(result.totalBytes,result.files.reduce((sum,f)=>sum+f.byteSize,0));
 for(const f of result.files)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(out,f.relativePath))).digest('hex'),f.sha256);
 const other=path.join(root,'other');fs.mkdirSync(other);assert.throws(()=>copyPilotPhotos({input,destination:other,maxTotalBytes:1}),/limit/);assert.deepEqual(fs.readdirSync(other),[]);
 const link=path.join(input,'photo-0.jpg');fs.unlinkSync(link);fs.symlinkSync(path.join(input,'photo-1.jpg'),link);assert.throws(()=>copyPilotPhotos({input,destination:other}));assert.deepEqual(fs.readdirSync(other),[]);
 fs.unlinkSync(link);assert.throws(()=>copyPilotPhotos({input,destination:other}),/count/);
});
test('pilot photo copy detects a source mutation during copy',{skip:process.platform!=='linux'},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-pilot-photo-mutation-')),input=path.join(root,'in'),out=path.join(root,'out');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(input);fs.mkdirSync(out);
 for(let i=0;i<40;i++)fs.writeFileSync(path.join(input,`photo-${i}.jpg`),`photo-${i}`);
 const copy=fs.copyFileSync;let injected=false;try{fs.copyFileSync=(source,target,flags)=>{copy(source,target,flags);if(!injected){injected=true;fs.writeFileSync(path.join(input,'photo-0.jpg'),'changed');}};assert.throws(()=>copyPilotPhotos({input,destination:out,maxTotalBytes:1000}),/source changed/);}finally{fs.copyFileSync=copy;}
 assert.equal(injected,true);assert.equal(fs.readdirSync(out).length,1,'fixture is held with its partial copy for inspection');
});
