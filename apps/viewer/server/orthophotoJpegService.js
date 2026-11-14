'use strict';
const path=require('node:path');
const {OrthophotoJpegJobs}=require('./orthophotoJpegJobs');
const {createJpegProcessExecutor}=require('./orthophotoJpegProcess');
const {createOrthophotoJpegIo}=require('./orthophotoJpegIo');
const {createOrthophotoJpegWorker}=require('./orthophotoJpegWorker');

// Trusted dedicated-service composition. Not mounted by HTTP, imported by the
// normal processing worker or started from environment configuration. Physical
// admission and qualified runtime evidence belong to the deployment owner.
function createOrthophotoJpegService({enabled=false,database,storage,owner,stagingParent,
  assertRuntimeQualified}={}){
  if(enabled!==true)return Object.freeze({runOne:async()=>({status:'disabled'})});
  if(!database||typeof database.prepare!=='function'||typeof database.exec!=='function'||
    typeof storage?.resolve!=='function'||typeof storage?.requireSpace!=='function'||
    typeof owner!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(owner)||
    typeof stagingParent!=='string'||stagingParent.length>4096||stagingParent==='/'||
    !stagingParent.startsWith('/')||stagingParent.endsWith('/')||
    /[\x00-\x1f\x7f\\:]/.test(stagingParent)||path.posix.normalize(stagingParent)!==stagingParent||
    typeof assertRuntimeQualified!=='function')
    throw Object.assign(new Error('jpeg_service_composition_required'),{code:'jpeg_service_composition_required'});
  const jobs=new OrthophotoJpegJobs(database);
  const io=createOrthophotoJpegIo({storage,jobs,stagingParent,processExecutor:createJpegProcessExecutor()});
  const worker=createOrthophotoJpegWorker({enabled:true,dedicated:true,jobs,owner,
    assertRuntimeQualified,...io});
  // No looping, retry, signal handler or DB close: the caller owns the admitted
  // lifetime, cancellation and database. Unknown cleanup remains fenced by worker.
  return Object.freeze({runOne:({signal=null}={})=>worker.runOne({signal})});
}
module.exports={createOrthophotoJpegService};
