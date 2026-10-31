'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {authorizePilotPhase}=require('./helpers/pilot-phase-authorization.cjs');
test('isolated supervisor marker must bind the exact run, phase and nonce',{skip:process.platform!=='linux'},t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-pilot-phase-')),marker=path.join(dir,'phase');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const ownerId='pilot-'+'a'.repeat(32),nonce='b'.repeat(64),args={phase:'submit',synthetic:false,enabled:'1',ownerId,nonce,marker},value={schemaVersion:1,ownerId,phase:'submit',nonce};
 fs.writeFileSync(marker,JSON.stringify(value),{mode:0o600});assert.doesNotThrow(()=>authorizePilotPhase(args));
 for(const change of [{phase:'finish'},{ownerId:'pilot-'+'c'.repeat(32)},{nonce:'d'.repeat(64)}])assert.throws(()=>authorizePilotPhase({...args,...change}),/mismatch/);
 assert.throws(()=>authorizePilotPhase({...args,enabled:''}),/held/);assert.throws(()=>authorizePilotPhase({...args,synthetic:true}),/conflict/);assert.throws(()=>authorizePilotPhase({...args,phase:'resume-ingest'}),/held/);
 fs.chmodSync(marker,0o644);assert.throws(()=>authorizePilotPhase(args),/invalid/);fs.chmodSync(marker,0o600);
 const link=path.join(dir,'link');fs.symlinkSync(marker,link);assert.throws(()=>authorizePilotPhase({...args,marker:link}));
});
