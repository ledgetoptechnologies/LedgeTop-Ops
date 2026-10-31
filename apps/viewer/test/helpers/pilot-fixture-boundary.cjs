'use strict';
// Review-only pilot guard. The externally controlled supervisor owns the
// marker, mounts and endpoint; this guard does not establish network isolation.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');

function checkPilotBoundary({root,input,endpoint,ownerId,phase,parent='/fixture-state',source='/fixture-input',expectedEndpoint='https://127.0.0.1:28443'}){
 if(process.platform!=='linux'||!['prepare','submit','status','prime-archive','finish','resume-ingest'].includes(phase))throw new Error('unsupported pilot context');
 if(typeof ownerId!=='string'||!/^pilot-[a-f0-9]{32}$/.test(ownerId))throw new Error('invalid fixture owner');
 if(root!==path.join(parent,'viewer')||input!==source||endpoint!==expectedEndpoint)throw new Error('pilot boundary mismatch');
 const parentReal=fs.realpathSync.native(parent),inputReal=fs.realpathSync.native(input);
 if(parentReal!==parent||inputReal!==input||parentReal===inputReal||parentReal.startsWith(inputReal+path.sep)||inputReal.startsWith(parentReal+path.sep))throw new Error('pilot mounts overlap or are redirected');
 const parentStat=fs.statSync(parentReal),inputStat=fs.statSync(inputReal);
 if(!parentStat.isDirectory()||!inputStat.isDirectory()||parentStat.uid!==process.getuid()||(parentStat.mode&0o077)!==0)throw new Error('pilot directory is not private');
 const marker=path.join(parent,'.viewer-pilot-owner'),fd=fs.openSync(marker,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o077)!==0||stat.size>128||fs.readFileSync(fd,'utf8').trim()!==ownerId)throw new Error('pilot owner marker mismatch');}finally{fs.closeSync(fd);}
 if(phase==='prepare'){if(fs.existsSync(root))throw new Error('pilot root already exists');}
 else{const stat=fs.lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077)!==0||fs.realpathSync.native(root)!==root)throw new Error('pilot root changed');const db=fs.lstatSync(path.join(root,'viewer.sqlite'),{bigint:true}),identity=readDbIdentity(parent,ownerId);if(!db.isFile()||db.isSymbolicLink()||db.nlink!==1n||db.uid!==BigInt(process.getuid())||(db.mode&0o077n)!==0n||String(db.dev)!==identity.device||String(db.ino)!==identity.inode)throw new Error('pilot database identity mismatch');}
 return{root,input,endpoint};
}
function readDbIdentity(parent,ownerId){
 const fd=fs.openSync(path.join(parent,'.viewer-pilot-db-identity'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o077)!==0||stat.size>512)throw Error('pilot database identity unavailable');const v=JSON.parse(fs.readFileSync(fd,'utf8'));if(v.ownerId!==ownerId||!/^\d+$/.test(v.device)||!/^\d+$/.test(v.inode)||!/^[a-f0-9]{64}$/.test(v.nonce))throw Error('pilot database identity mismatch');return v;}finally{fs.closeSync(fd);}
}
function sealPilotDbIdentity({parent,root,ownerId,database}){
 const db=fs.lstatSync(path.join(root,'viewer.sqlite'),{bigint:true});if(!db.isFile()||db.isSymbolicLink()||db.nlink!==1n||db.uid!==BigInt(process.getuid())||(db.mode&0o077n)!==0n)throw Error('pilot database invalid');
 const nonce=crypto.randomBytes(32).toString('hex');database.prepare('INSERT INTO app_state(key,value,updated_at) VALUES(?,?,?)').run('viewer-pilot-fixture-identity',nonce,new Date().toISOString());
 const fd=fs.openSync(path.join(parent,'.viewer-pilot-db-identity'),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,JSON.stringify({ownerId,device:String(db.dev),inode:String(db.ino),nonce}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const parentFd=fs.openSync(parent,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(parentFd);}finally{fs.closeSync(parentFd);}
}
function verifyPilotDbIdentity({database,parent,ownerId}){const identity=readDbIdentity(parent,ownerId),row=database.prepare('SELECT value FROM app_state WHERE key=?').get('viewer-pilot-fixture-identity');if(!row||row.value!==identity.nonce)throw Error('pilot database internal identity mismatch');return true;}
module.exports={checkPilotBoundary,sealPilotDbIdentity,verifyPilotDbIdentity};
