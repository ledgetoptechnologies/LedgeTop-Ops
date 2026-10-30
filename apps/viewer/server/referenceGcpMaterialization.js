'use strict';
// Unexposed, default-off file preparation primitive. An open root descriptor
// does not attest mount topology, writer quiescence, custody, or CSV retention.
// Callers must establish those separately before any provider admission.
const fs=require('node:fs'),crypto=require('node:crypto');
const {descriptorMountId}=require('./storageManager');
const {decodeOptionsWire}=require('./referenceOptions');
const {validateManifest}=require('./referenceProtocol');
const fail=code=>Object.assign(new Error(code),{code});
const directoryFlags=fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC;
const readFlags=fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC|fs.constants.O_NONBLOCK;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function checkedBytes(db,attemptId){
 if(typeof attemptId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(attemptId))throw fail('reference_gcp_identity_invalid');
 const row=db.prepare('SELECT CASE WHEN length(CAST(a.object_id AS BLOB))<=128 THEN a.object_id END AS object_id,CASE WHEN length(CAST(a.relative_path AS BLOB))<=512 THEN a.relative_path END AS relative_path,CASE WHEN length(CAST(a.sha256 AS BLOB))=64 THEN a.sha256 END AS sha256,a.byte_size,CASE WHEN length(CAST(s.content_text AS BLOB))<=16777216 THEN s.content_text END AS content_text,CASE WHEN length(CAST(s.sha256 AS BLOB))=64 THEN s.sha256 END AS snapshot_sha256,CASE WHEN length(CAST(j.submission_id AS BLOB))=36 THEN j.submission_id END AS submission_id,CASE WHEN length(CAST(j.request_json AS BLOB))<=4194304 THEN j.request_json END AS request_json,CASE WHEN length(CAST(j.request_sha256 AS BLOB))=64 THEN j.request_sha256 END AS request_sha256,CASE WHEN length(CAST(j.input_manifest_sha256 AS BLOB))=64 THEN j.input_manifest_sha256 END AS input_manifest_sha256 FROM viewer_reference_gcp_artifacts a JOIN processing_attempt_gcp_snapshots s ON s.attempt_id=a.attempt_id JOIN viewer_reference_attempt_journal j ON j.attempt_id=a.attempt_id JOIN viewer_reference_attempt_protocols p ON p.attempt_id=a.attempt_id WHERE a.attempt_id=?').get(attemptId);
 if(!row||typeof row.submission_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.submission_id))throw fail('reference_gcp_identity_invalid');
 if(typeof row.content_text!=='string'||typeof row.request_json!=='string'||Buffer.byteLength(row.content_text,'utf8')>16*1024*1024||Buffer.byteLength(row.request_json,'utf8')>4*1024*1024)throw fail('reference_gcp_identity_invalid');
 const relative=`reference-gcp/${row.submission_id}/gcp_list.txt`,objectId=`gcp-${row.submission_id}`,bytes=Buffer.from(row.content_text,'utf8');
 if(bytes.toString('utf8')!==row.content_text||row.relative_path!==relative||row.object_id!==objectId||bytes.length<1||row.byte_size!==bytes.length||row.snapshot_sha256!==row.sha256||hash(bytes)!==row.sha256||hash(Buffer.from(row.request_json,'utf8'))!==row.request_sha256)throw fail('reference_gcp_identity_invalid');
 let request;try{request=decodeOptionsWire(Buffer.from(row.request_json,'utf8'));validateManifest(request.manifest);}catch{throw fail('reference_gcp_identity_invalid');}
 const objects=request.manifest.objects.filter(o=>o.id===objectId);if(request.submissionId!==row.submission_id||request.manifest.sha256!==row.input_manifest_sha256||objects.length!==1||objects[0].kind!=='auxiliary'||objects[0].name!=='gcp_list.txt'||objects[0].sha256!==row.sha256||objects[0].byteSize!==bytes.length)throw fail('reference_gcp_identity_invalid');
 return {bytes,sha256:row.sha256,relativePath:relative,submissionId:row.submission_id};
}
function materializeReferenceGcp({db,rootFd,attemptId,enabled=false,verifyRoot=null}={}){
 if(enabled!==true)throw fail('reference_gcp_disabled');
 if(process.platform!=='linux'||!Number.isInteger(rootFd)||rootFd<0||typeof verifyRoot!=='function')throw fail('reference_gcp_root_unavailable');
 const data=checkedBytes(db,attemptId),opened=[];let tempName=null,tempFd=null,mountId;
 const openDir=(parent,name)=>{const path=`/proc/self/fd/${parent}/${name}`;try{fs.mkdirSync(path,{mode:0o700});fs.fsyncSync(parent);}catch(e){if(e.code!=='EEXIST')throw e;}const fd=fs.openSync(path,directoryFlags);opened.push(fd);if(!fs.fstatSync(fd).isDirectory()||descriptorMountId(fd)!==mountId)throw fail('reference_gcp_root_unavailable');return fd;};
 try{
  const rootStat=fs.fstatSync(rootFd,{bigint:true});if(!rootStat.isDirectory())throw fail('reference_gcp_root_unavailable');mountId=descriptorMountId(rootFd);if(verifyRoot({rootFd,dev:String(rootStat.dev),ino:String(rootStat.ino),mountId})!==true)throw fail('reference_gcp_root_unavailable');
  // Bind closure value before directory traversal; every child must stay on
  // the same observed mount. A verified deployment root is still required.
  const base=openDir(rootFd,'reference-gcp'),dir=openDir(base,data.submissionId),finalPath=`/proc/self/fd/${dir}/gcp_list.txt`;
  const verify=()=>{let fd;try{fd=fs.openSync(finalPath,readFlags);const before=fs.fstatSync(fd,{bigint:true});if(!before.isFile()||before.size!==BigInt(data.bytes.length))throw fail('reference_gcp_existing_conflict');const content=Buffer.alloc(data.bytes.length);let offset=0;while(offset<content.length){const n=fs.readSync(fd,content,offset,content.length-offset,offset);if(n===0)throw fail('reference_gcp_existing_conflict');offset+=n;}const extra=Buffer.alloc(1);if(fs.readSync(fd,extra,0,1,offset)!==0)throw fail('reference_gcp_existing_conflict');const after=fs.fstatSync(fd,{bigint:true});if(after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeNs!==before.mtimeNs||after.ctimeNs!==before.ctimeNs||hash(content)!==data.sha256)throw fail('reference_gcp_existing_conflict');fs.fsyncSync(fd);}finally{if(fd!==undefined)fs.closeSync(fd);}};
  try{verify();fs.fsyncSync(dir);return {relativePath:data.relativePath,sha256:data.sha256,byteSize:data.bytes.length,reused:true};}catch(e){if(e.code!=='ENOENT')throw e;}
  tempName=`.gcp-${crypto.randomUUID()}.partial`;const tempPath=`/proc/self/fd/${dir}/${tempName}`;tempFd=fs.openSync(tempPath,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC,0o600);fs.writeFileSync(tempFd,data.bytes);fs.fsyncSync(tempFd);fs.closeSync(tempFd);tempFd=null;
  try{fs.linkSync(tempPath,finalPath);}catch(e){if(e.code!=='EEXIST')throw e;verify();fs.fsyncSync(dir);return {relativePath:data.relativePath,sha256:data.sha256,byteSize:data.bytes.length,reused:true};}
  // Keep the temporary hard link until a separately fenced cleanup exists;
  // unlinking a mutable path could erase a replacement placed by another writer.
  fs.fsyncSync(dir);verify();return {relativePath:data.relativePath,sha256:data.sha256,byteSize:data.bytes.length,reused:false};
 }finally{if(tempFd!==null)fs.closeSync(tempFd);for(const fd of opened.reverse())fs.closeSync(fd);}
}
module.exports={materializeReferenceGcp,validateReferenceGcpSnapshot:checkedBytes};
