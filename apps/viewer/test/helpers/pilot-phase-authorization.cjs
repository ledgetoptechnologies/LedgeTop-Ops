'use strict';
// The supervisor must provide an exclusive private fixture and prevent replay.
// This marker is a launch condition, not proof of network or process isolation.
const fs=require('node:fs');
function authorizePilotPhase({phase,synthetic,enabled,ownerId,nonce,marker='/fixture-state/.viewer-pilot-phase'}){
 if(synthetic&&enabled)throw Error('synthetic and real pilot modes conflict');
 if(phase==='prepare')return;
 if(phase==='resume-ingest'&&(synthetic||enabled==='1'))throw Error('ambiguous ingest must remain held');
 if(synthetic)return;
 if(enabled!=='1'||!/^pilot-[a-f0-9]{32}$/.test(ownerId||'')||!/^[a-f0-9]{64}$/.test(nonce||''))throw Error('pilot execution held pending integrated supervision and receipt review');
 const fd=fs.openSync(marker,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o077)!==0||(typeof process.getuid==='function'&&stat.uid!==process.getuid())||stat.size<1||stat.size>512)throw Error('pilot phase authorization invalid');const value=JSON.parse(fs.readFileSync(fd,'utf8'));if(value.schemaVersion!==1||value.ownerId!==ownerId||value.phase!==phase||value.nonce!==nonce)throw Error('pilot phase authorization mismatch');}finally{fs.closeSync(fd);}
}
module.exports={authorizePilotPhase};
