'use strict';
// Unmounted schema candidate only. Validation is not authentication or custody.
const crypto=require('node:crypto');
const fail=()=>{throw Object.assign(new Error('source copy contract invalid'),{code:'SOURCE_COPY_CONTRACT_INVALID'});};
const closed=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const relative=v=>typeof v==='string'&&v.length>0&&v.length<=4096&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)&&!v.includes('\\')&&!v.includes(':')&&v.split('/').length<=128&&v.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!/[\x00-\x1f\x7f]/.test(p));
const digest=v=>crypto.createHash('sha256').update(JSON.stringify(v),'utf8').digest('hex');
function validateClaim(c){
 if(!closed(c,['version','operationId','directoryId','attemptId','generation','datasetId','rootKey','datasetRelativePath','manifestSha256','sourceInventorySha256','fileCount','byteSize','files'])||c.version!==1||!id(c.operationId)||!id(c.directoryId)||c.operationId!==c.directoryId||!id(c.attemptId)||!Number.isSafeInteger(c.generation)||c.generation<1||c.directoryId!==`${c.attemptId}-g${c.generation}`||!id(c.datasetId)||c.rootKey!=='datasets'||!relative(c.datasetRelativePath)||!hash(c.manifestSha256)||!hash(c.sourceInventorySha256)||!Array.isArray(c.files)||!Number.isSafeInteger(c.fileCount)||c.fileCount<1||c.fileCount>10000||c.fileCount!==c.files.length||!Number.isSafeInteger(c.byteSize)||c.byteSize<1||c.byteSize>68719476736)fail();
 let wire;try{wire=JSON.stringify(c);}catch{fail();}if(Buffer.byteLength(wire,'utf8')>4*1024*1024)fail();
 const ids=new Set(),paths=new Set();let total=0;
 for(const f of c.files){if(!closed(f,['id','relativePath','byteSize','sha256'])||!id(f.id)||!relative(f.relativePath)||!Number.isSafeInteger(f.byteSize)||f.byteSize<1||!hash(f.sha256)||ids.has(f.id)||paths.has(f.relativePath))fail();ids.add(f.id);paths.add(f.relativePath);total+=f.byteSize;if(!Number.isSafeInteger(total))fail();}
 if(total!==c.byteSize||digest(c.files.map(f=>({relativePath:f.relativePath,byteSize:f.byteSize,sha256:f.sha256})))!==c.manifestSha256||digest(c.files.map(f=>({id:f.id,relativePath:f.relativePath,byteSize:f.byteSize,sha256:f.sha256})))!==c.sourceInventorySha256)fail();
 return c;
}
function expectedReceipt(c){validateClaim(c);return {version:1,operationId:c.operationId,directoryId:c.directoryId,attemptId:c.attemptId,generation:c.generation,datasetId:c.datasetId,manifestSha256:c.manifestSha256,sourceInventorySha256:c.sourceInventorySha256,sealSha256:digest({version:1,attemptId:c.attemptId,manifestSha256:c.manifestSha256,objects:c.files.map(f=>({id:f.id,byteSize:f.byteSize,sha256:f.sha256}))}),fileCount:c.fileCount,byteSize:c.byteSize,sealed:true};}
function validateReceipt(receipt,claim){const expected=expectedReceipt(claim);if(!closed(receipt,Object.keys(expected))||Object.keys(expected).some(k=>receipt[k]!==expected[k]))fail();return receipt;}
function canonicalClaim(c){validateClaim(c);return {version:c.version,operationId:c.operationId,directoryId:c.directoryId,attemptId:c.attemptId,generation:c.generation,datasetId:c.datasetId,rootKey:c.rootKey,datasetRelativePath:c.datasetRelativePath,manifestSha256:c.manifestSha256,sourceInventorySha256:c.sourceInventorySha256,fileCount:c.fileCount,byteSize:c.byteSize,files:c.files.map(f=>({id:f.id,relativePath:f.relativePath,byteSize:f.byteSize,sha256:f.sha256}))};}
module.exports={validateClaim,expectedReceipt,validateReceipt,canonicalClaim};
