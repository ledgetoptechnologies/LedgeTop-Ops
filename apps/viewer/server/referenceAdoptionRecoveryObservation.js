'use strict';
// Read-only offline diagnostic. Not a pin, lock, issuer, route, recovery or
// authorization to move/delete data. It cannot fence a concurrent writer.
const fs=require('node:fs');
const {safeRelativePath}=require('./processingSecurity');
const fail=()=>{throw Object.assign(new Error('adoption recovery observation unavailable'),{code:'adoption_observation_unavailable'})};
const relative=x=>typeof x==='string'&&safeRelativePath(x)===x&&!x.includes('\\')&&x.length>0;
const numeric=x=>typeof x==='string'&&/^\d+$/.test(x);
function inspect(path){try{return fs.lstatSync(path,{bigint:true})}catch(e){if(e.code==='ENOENT')return null;throw e}}
function same(a,b){return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&a.nlink===b.nlink}
async function observeAdoptionRecovery(storage,intent,{scope}={}){
 if(scope!=='isolated-adoption-observation'||!storage||!intent||!relative(intent.relativePath)||!relative(intent.datasetRelative)||!['terra_import','dataset_import'].includes(intent.rootKey)||!/^[a-f0-9]{64}$/.test(intent.sourceFingerprint||'')||!Number.isSafeInteger(intent.sourceByteSize)||intent.sourceByteSize<0||!numeric(intent.sourceDev)||!numeric(intent.sourceIno))fail();
 const source=storage.resolve(intent.rootKey,intent.relativePath),destination=storage.resolve('datasets',intent.datasetRelative),incomplete=storage.resolve('datasets',`${intent.datasetRelative}.incomplete`);
 const sourceBefore=inspect(source),d=inspect(destination),i=inspect(incomplete);if(sourceBefore||Boolean(d)===Boolean(i))fail();
 const candidate=d?destination:incomplete,relativeCandidate=d?intent.datasetRelative:`${intent.datasetRelative}.incomplete`,before=d||i;
 if(!before.isDirectory()||before.isSymbolicLink()||String(before.dev)!==intent.sourceDev||String(before.ino)!==intent.sourceIno)fail();
 let preview;try{preview=await storage.previewImport('datasets',relativeCandidate)}catch{fail()}
 const after=inspect(candidate),other=inspect(d?incomplete:destination);if(!after||!same(before,after)||other||inspect(source)||preview.byteSize!==intent.sourceByteSize||preview.treeFingerprint!==intent.sourceFingerprint)fail();
 return Object.freeze({scope:'observation_only_not_authority',candidateKind:d?'destination':'incomplete',byteSize:preview.byteSize,fileCount:preview.fileCount,treeFingerprint:preview.treeFingerprint,device:String(after.dev),inode:String(after.ino)});
}
module.exports={observeAdoptionRecovery};
