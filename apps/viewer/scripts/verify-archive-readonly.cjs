'use strict';
// Operator-only point-in-time observation; no migrations, directory creation,
// production wiring or physical custody claim. Never print input or error text.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const digest=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
const result=(status,category)=>({status,category});
async function check({db,modelsRoot,taskId,providerTaskId}){
 if(!uuid(taskId)||!uuid(providerTaskId)||typeof modelsRoot!=='string'||!path.isAbsolute(modelsRoot))return result('UNAVAILABLE','configuration');
 try{
  const rows=db.prepare('SELECT a.id,a.task_id,a.provider_task_id,p.archive_json FROM processing_attempts a JOIN processing_tasks t ON t.id=a.task_id LEFT JOIN processing_attempt_transfer_provenance p ON p.attempt_id=a.id WHERE a.task_id=? AND a.provider_task_id=? LIMIT 2').all(taskId,providerTaskId);
  if(rows.length!==1||!uuid(rows[0].id)||!rows[0].archive_json)return result('UNAVAILABLE','identity');
  const r=JSON.parse(rows[0].archive_json);if(r.schemaVersion!==1||r.attemptId!==rows[0].id||r.providerTaskId!==providerTaskId||!digest(r.archiveSha256)||!digest(r.archiveManifestSha256)||!Number.isSafeInteger(r.archiveByteSize)||r.archiveByteSize<22||!Array.isArray(r.archiveFiles)||!r.archiveFiles.length||r.archiveFiles.length>10000)return result('UNAVAILABLE','receipt');
  const seen=new Set();let total=0;for(const f of r.archiveFiles){if(!f||JSON.stringify(Object.keys(f).sort())!==JSON.stringify(['byteSize','relativePath','sha256'])||typeof f.relativePath!=='string'||f.relativePath.length>1024||f.relativePath.includes('\\')||f.relativePath.startsWith('/')||f.relativePath.split('/').some(x=>!x||x==='.'||x==='..')||seen.has(f.relativePath.toLowerCase())||!Number.isSafeInteger(f.byteSize)||f.byteSize<0||!digest(f.sha256))return result('UNAVAILABLE','receipt');seen.add(f.relativePath.toLowerCase());total+=f.byteSize;if(!Number.isSafeInteger(total)||total>500*1024**3)return result('UNAVAILABLE','limits');}
  if(r.archiveFiles.some(f=>/[\x00-\x1f:]/.test(f.relativePath))||sha(JSON.stringify(r.archiveFiles))!==r.archiveManifestSha256)return result('UNAVAILABLE','receipt');
  const expected=new Map(r.archiveFiles.map(f=>[f.relativePath,f]));
  // Refuse symlinked root/ancestors, then inventory one file at a time.
  const root=path.resolve(modelsRoot),task=path.join(root,taskId),dest=path.join(task,rows[0].id);for(const dir of [root,task,dest]){const s=fs.lstatSync(dir),real=fs.realpathSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||(process.platform==='win32'?real.toLowerCase()!==dir.toLowerCase():real!==dir))return result('MISMATCH','contents');}
  const actual=[];let entries=0;
  async function walk(dir,rel=''){for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){if(++entries>10000)throw Error('limit');const name=rel?`${rel}/${entry.name}`:entry.name,absolute=path.join(dir,entry.name),before=fs.lstatSync(absolute,{bigint:true});if(before.isSymbolicLink())throw Error('mismatch');if(before.isDirectory()){await walk(absolute,name);continue}if(!before.isFile()||before.nlink!==1n||before.size>BigInt(Number.MAX_SAFE_INTEGER)||!expected.has(name)||BigInt(expected.get(name).byteSize)!==before.size)throw Error('mismatch');const h=crypto.createHash('sha256'),handle=await fs.promises.open(absolute,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const opened=await handle.stat({bigint:true});if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)throw Error('mismatch');const buffer=Buffer.alloc(1024*1024);let pos=0;while(pos<Number(before.size)){const n=(await handle.read(buffer,0,Math.min(buffer.length,Number(before.size)-pos),pos)).bytesRead;if(!n)throw Error('mismatch');h.update(buffer.subarray(0,n));pos+=n;}const after=await handle.stat({bigint:true});if(after.size!==before.size||after.mtimeNs!==before.mtimeNs||after.ctimeNs!==before.ctimeNs)throw Error('mismatch');actual.push({relativePath:name,byteSize:pos,sha256:h.digest('hex')});}finally{await handle.close();}}}
  try{await walk(dest)}catch{return result('MISMATCH','contents')}
  actual.sort((a,b)=>a.relativePath<b.relativePath?-1:a.relativePath>b.relativePath?1:0);
  return JSON.stringify(actual)===JSON.stringify(r.archiveFiles)?result('PASS','point-in-time'):result('MISMATCH','contents');
 }catch{return result('UNAVAILABLE','read')}
}
async function main(){let db;try{const {config}=require('../server/config');db=new DatabaseSync(config.databasePath,{readOnly:true});const answer=await check({db,modelsRoot:config.modelsMount,taskId:process.argv[2],providerTaskId:process.argv[3]});process.stdout.write(`${answer.status} ${answer.category}\n`);process.exitCode=answer.status==='PASS'?0:1;}catch{process.stdout.write('UNAVAILABLE configuration\n');process.exitCode=1;}finally{db?.close()}}
if(require.main===module)main();
module.exports={check};
