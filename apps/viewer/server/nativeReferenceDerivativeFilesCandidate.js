'use strict';
// Disabled observation only: neither stable filesystem authority nor recovery permission.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {hashFileChunks}=require('./storageManager'),{safeRelativePath}=require('./processingSecurity');
const receipt=require('./nativeReferenceDerivativeReceiptInspectionCandidate');
const hold=()=>Object.assign(new Error('native derivative files require review'),{code:'native_derivative_files_hold'});
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function snapshot(db,attemptId,jobId){
  const row=db.prepare('SELECT j.derivative_type,a.result_model_version_id AS version_id FROM derivative_jobs j JOIN processing_attempts a ON a.id=j.attempt_id WHERE j.id=? AND a.id=?').get(jobId,attemptId);
  const kind=row?.derivative_type==='ept'?'ept':row?.derivative_type==='mesh_tiles'?'tiles':null;if(!kind)throw hold();
  const asset=db.prepare('SELECT id,version_id,kind,root_key,relative_path,byte_size,source_attempt_id,sha256,manifest_sha256,storage_mode FROM model_assets WHERE version_id=? AND kind=?').get(row.version_id,kind),journal=db.prepare('SELECT * FROM derivative_storage_journal WHERE job_id=?').get(jobId),component=db.prepare('SELECT * FROM model_output_storage_components WHERE output_id=? AND component_key=?').get(row.version_id,`derivative:${jobId}`),intent=db.prepare('SELECT request_json FROM native_derivative_intent_candidate WHERE job_id=?').get(jobId);
  if(!asset||!journal||!component||!intent)throw hold();const request=JSON.parse(intent.request_json),relative=path.posix.dirname(asset.relative_path),name=kind==='ept'?'ept.json':'tileset.json';
  if(asset.root_key!=='models'||asset.storage_mode!=='managed'||asset.source_attempt_id!==attemptId||path.posix.basename(asset.relative_path)!==name||safeRelativePath(relative)!==relative||journal.output_id!==row.version_id||journal.root_key!=='models'||journal.state!=='registered'||journal.lease_token!==request.leaseToken||journal.final_relative_path!==relative||journal.manifest_sha256!==asset.manifest_sha256||component.root_key!=='models'||component.relative_path!==relative||component.manifest_sha256!==asset.manifest_sha256)throw hold();
  const files=db.prepare('SELECT relative_path,byte_size,sha256 FROM model_asset_files WHERE asset_id=?').all(asset.id).map(x=>({relativePath:x.relative_path,byteSize:x.byte_size,sha256:x.sha256})).sort((a,b)=>a.relativePath.localeCompare(b.relativePath));
  if(!files.length||files.length>10000||files.some(file=>safeRelativePath(file.relativePath)!==file.relativePath||!Number.isSafeInteger(file.byteSize)||file.byteSize<0||!/^[a-f0-9]{64}$/.test(file.sha256)))throw hold();
  const bytes=files.reduce((n,file)=>n+file.byteSize,0),header=files.find(file=>file.relativePath===name);if(!Number.isSafeInteger(bytes)||!header||header.byteSize!==asset.byte_size||header.sha256!==asset.sha256||sha(JSON.stringify(files))!==asset.manifest_sha256||journal.actual_byte_size!==bytes||journal.accounted_byte_size!==bytes||component.byte_size!==bytes)throw hold();
  return{asset,journal,component,files,bytes,relative};
}
async function inspect({db,storage,attemptId,jobId,authorize,maxBytes,signal,enabled=false}){
  if(enabled!==true||!storage||typeof storage.resolve!=='function'||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw hold();
  const args={attemptId,jobId,authorize,enabled:true,requireActivation:true};
  try{
    const before=receipt.inspect(db,args),saved=snapshot(db,attemptId,jobId);if(saved.bytes>maxBytes)throw hold();const root=storage.resolve('models',saved.relative,{mustExist:true});if(!path.isAbsolute(root)||fs.realpathSync(root)!==path.resolve(root))throw hold();
    const expected=new Map(saved.files.map(file=>[file.relativePath,file])),seen=new Set();let entries=0;
    const walk=async(dir,prefix='')=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){signal?.throwIfAborted();if(++entries>20000)throw hold();const rel=prefix?`${prefix}/${entry.name}`:entry.name,absolute=path.join(dir,entry.name),stat=fs.lstatSync(absolute);if(stat.isSymbolicLink())throw hold();if(stat.isDirectory()){await walk(absolute,rel);continue;}const wanted=expected.get(rel);if(!stat.isFile()||!wanted||stat.size!==wanted.byteSize||seen.has(rel))throw hold();const file=await hashFileChunks(absolute,{signal});if(file.sha256!==wanted.sha256)throw hold();seen.add(rel);}};
    await walk(root);if(seen.size!==expected.size)throw hold();const after=receipt.inspect(db,args),current=snapshot(db,attemptId,jobId);if(JSON.stringify(before)!==JSON.stringify(after)||JSON.stringify(saved)!==JSON.stringify(current))throw hold();
    return{state:'file_evidence_only',attemptId,jobId,activationPlanSha256:before.activationPlanSha256,manifestSha256:saved.asset.manifest_sha256,fileCount:seen.size,byteSize:saved.bytes};
  }catch{throw hold();}
}
module.exports={inspect};
