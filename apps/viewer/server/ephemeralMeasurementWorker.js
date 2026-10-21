'use strict';
const {EphemeralMeasurementRepository}=require('./ephemeralMeasurementRepository');
const {localAccess}=require('./ephemeralMeasurementAccess');
const {sourceAuthorizationValidator}=require('./sourceAuthorization');
const {validateTransectRequest,sameTransectEvidence}=require('./measurementTransectRequest');
const {emitMeasurementTiming,readQueueTiming}=require('./measurementTiming');
async function processOneEphemeralMeasurement({repository,storage,config,runCalculation,validator=sourceAuthorizationValidator},owner){
 if(config.measurementCalculationsEnabled===false)return false;
 const jobs=new EphemeralMeasurementRepository(repository.database),job=jobs.claim(owner);if(!job)return false;const request=job.request;
 emitMeasurementTiming(request,readQueueTiming(repository.database,'ephemeral_measurement_jobs',job.id));
 let timer=null,externalLive=true,lastExternalCheck=0,checking=false;
 const access=()=>localAccess(request.ephemeralAuthority,repository);
 const parentLive=value=>{if(request.method!=='surface-transect')return true;try{const measurement={...request,id:job.measurementId,kind:'polygon',revision:1},version={...value.model.activeVersion,assets:value.model.activeVersion.assets.filter(asset=>request.ephemeralAuthority.kind==='viewer'||asset.published===true)},rebuilt=validateTransectRequest({revision:1,method:'surface-transect',parentCalculationId:request.parentCalculationId,line:request.line},measurement,version,jobs.parent(job.scopeKey,job.pageHash,request.parentCalculationId),{temporary:true,allowPointSurface:true});return sameTransectEvidence(request,rebuilt);}catch{return false;}};
 const permittedMethod=()=>request.source?.kind==='ept'?request.requireEncodedVerticalUnits===true&&['point-surface-cut-fill','surface-transect'].includes(request.method):['dsm','dtm'].includes(request.source?.kind)&&['surface-cut-fill','surface-transect'].includes(request.method);
 const current=()=>{const value=access();return Boolean(value&&jobs.live(job,owner)&&permittedMethod()&&request.modelId===value.model.id&&request.modelVersionId===value.model.activeVersion.id&&(request.ephemeralAuthority.kind==='viewer'||value.model.activeVersion.assets.some(asset=>asset.id===request.source.id&&asset.published===true))&&parentLive(value));};
 const checkExternal=async()=>{if(checking)return;checking=true;let deadline;try{const value=access();externalLive=Boolean(value&&(!value.share||await Promise.race([validator.allows(value.share),new Promise(resolve=>{deadline=setTimeout(()=>resolve(false),3500);})])));lastExternalCheck=Date.now();}catch{externalLive=false;lastExternalCheck=Date.now();}finally{clearTimeout(deadline);checking=false;}};
 try{
  await checkExternal();if(!current()||!externalLive)throw Object.assign(new Error('authorization lost'),{code:'measurement_authorization_lost'});
  const asset=access().model.activeVersion.assets.find(a=>a.id===request.source.id);
  if(!asset||['sha256','rootKey','relativePath','byteSize','kind'].some(k=>asset[k]!==request.source[k])||(request.ephemeralAuthority.kind!=='viewer'&&!asset.published))throw Object.assign(new Error('source changed'),{code:'measurement_source_changed'});
  let sourceFiles;
  if(request.source.kind==='ept'){
   if(!/^[a-f0-9]{64}$/i.test(asset.manifestSha256||'')||asset.manifestSha256!==request.source.manifestSha256)throw Object.assign(new Error('source changed'),{code:'measurement_source_changed'});
   sourceFiles=repository.database.prepare('SELECT relative_path AS relativePath,byte_size AS byteSize,sha256 FROM model_asset_files WHERE asset_id=? ORDER BY relative_path LIMIT 200001').all(asset.id);
   if(sourceFiles.length>200000)throw Object.assign(new Error('source index too large'),{code:'measurement_ept_selection_limit'});
  }
  timer=setInterval(()=>{void checkExternal();},1000);
  const result=await runCalculation(storage.resolve(asset.rootKey,asset.relativePath,{mustExist:true}),request,{config,sourceFiles,isLive:()=>current()&&externalLive&&Date.now()-lastExternalCheck<6000&&jobs.heartbeat(job,owner)});
  // Do not accept a result under a stale positive source-authorization cache.
  clearInterval(timer);timer=null;
  while(checking)await new Promise(resolve=>setTimeout(resolve,10));await checkExternal();
  if(!current()||!externalLive)throw Object.assign(new Error('authorization lost'),{code:'measurement_authorization_lost'});
  jobs.finish(job,owner,result);
 }catch(e){jobs.finish(job,owner,null,/^[a-z][a-z0-9_]{0,79}$/.test(e.code||'')?e.code:'measurement_calculation_failed');}
 finally{clearInterval(timer);}return true;
}
module.exports={processOneEphemeralMeasurement};
