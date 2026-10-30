'use strict';
// Source-only planning seam. Does not pin files, persist a submission, authorize
// a holder or perform network I/O. Never treat this result as a custody receipt.
const path=require('node:path');
const p=require('./referenceProtocol');
const {validateReferenceOptions}=require('./referenceOptions');
const fail=()=>Object.assign(new Error('reference submission cannot be prepared'),{code:'reference_prepare_invalid'});
function relative(value){return typeof value==='string'&&value.length>0&&!/[\x00-\x1f\x7f:]/.test(value)&&!value.includes('\\')&&!value.startsWith('/')&&value.split('/').every(part=>part&&part!=='.'&&part!=='..')&&path.posix.normalize(value)===value}
function media(name){const ext=path.posix.extname(name).toLowerCase();return ({'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.tif':'image/tiff','.tiff':'image/tiff'})[ext]||null}
function prepareReferenceSubmission({enabled=false,dataset,managedGcp=null,submissionId,capabilities,optionsCatalog,odmOptions={}}={}){
 if(enabled!==true)throw Object.assign(new Error('reference provider disabled'),{code:'reference_disabled'});
 if(!dataset||dataset.status!=='finalized'||dataset.storageMode!=='managed'||!Array.isArray(dataset.files))throw fail();
 p.validateCapabilities(capabilities);
 let allowed;try{allowed=validateReferenceOptions(optionsCatalog,capabilities)}catch{throw fail()}
 if(!odmOptions||Object.getPrototypeOf(odmOptions)!==Object.prototype||Object.keys(odmOptions).some(k=>!allowed.has(k)))throw fail();
 for(const value of Object.values(odmOptions)){if(value!==null&&!['string','boolean','number'].includes(typeof value))throw fail();if(typeof value==='number'&&(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER))throw fail();if(typeof value==='string'&&(value.includes('://')||value.includes('\\')||/(?:^|[\s=])(?:[A-Za-z]:)?\//.test(value)||/(?:^|\/)\.\.(?:\/|$)/.test(value)))throw fail()}
 const objects=[],sourceFiles=Object.create(null),permanentCsvIds=[];
 for(const file of dataset.files){if(!file||!relative(file.relativePath)||typeof file.id!=='string')throw fail();const name=path.posix.basename(file.relativePath),role=file.processingRole||'auto';if(/\.csv$/i.test(name))permanentCsvIds.push(file.id);if(['gcp_source','administrative'].includes(role)||(role==='auto'&&!media(name)))continue;const mime=media(name);if(!mime||!['auto','image'].includes(role))throw fail();objects.push({id:file.id,name,byteSize:file.byteSize,sha256:file.sha256,kind:'image',mediaType:mime});sourceFiles[file.id]=file.relativePath}
 if(managedGcp){if(typeof managedGcp.id!=='string'||!relative(managedGcp.relativePath)||path.posix.basename(managedGcp.relativePath)!=='gcp_list.txt')throw fail();objects.push({id:managedGcp.id,name:'gcp_list.txt',byteSize:managedGcp.byteSize,sha256:managedGcp.sha256,kind:'auxiliary',mediaType:'text/plain'});sourceFiles[managedGcp.id]=managedGcp.relativePath}
 const total=objects.reduce((sum,o)=>sum+BigInt(o.byteSize),0n);if(total>BigInt(Number.MAX_SAFE_INTEGER)||!objects.some(o=>o.kind==='image'))throw fail();
 const manifest={id:`dataset-${dataset.id}`,revision:1,sha256:'0'.repeat(64),totalBytes:Number(total),objectCount:objects.length,inputCounts:{images:objects.filter(o=>o.kind==='image').length,lidarObjects:0,points:0},objects};manifest.sha256=p.manifestSha256(manifest);
 const submission={schemaVersion:1,submissionId,manifest,pipeline:{odm:{requested:true,options:structuredClone(odmOptions),optionsFingerprint:optionsCatalog.optionsFingerprint},treedar:{requested:false,inputObjectIds:[],provenanceReceiptId:null},gaussian_splat:{requested:false}},capabilityFingerprint:capabilities.capabilityFingerprint};p.validateSubmission(submission,{capabilities});
 return {submission,sourceFiles,permanentCsvIds};
}
module.exports={prepareReferenceSubmission};
