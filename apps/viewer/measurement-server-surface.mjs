import {availableAdminSources,adminCalculationRequest} from './measurement-admin-dialog.mjs';
import {measurementGeometryHash} from './measurement-surface-client.mjs';
import {validatePointSamplingGrid} from './measurement-native-profile.mjs';

const guidance=Object.freeze({
  measurement_source_crs_mismatch:'The survey coordinates for this model need to be checked by the model owner before volume can be calculated. Your outline and area are unchanged.',
  measurement_source_vertical_units_required:'This dataset needs its height units verified before volume can be calculated. Your outline is saved. An administrator needs to check the original elevation data; do not guess meters or feet.',
  measurement_source_vertical_units_conflict:'The elevation data contains conflicting height units. Your outline is saved; an administrator needs to correct the dataset setup.',
  measurement_source_vertical_units_unsupported:'The elevation data uses height units that need administrator review. Your outline is saved.',
  measurement_source_vertical_metadata_invalid:'The elevation data needs administrator review before volume can be calculated. Your outline is saved.',
  measurement_source_value_transform_unsupported:'The elevation data needs its height conversion set up before volume can be calculated. Your outline is saved.',
  measurement_calculation_already_active:'A calculation with different settings is already running for this outline. Wait for it to finish, or cancel it here before calculating with new settings.',
  measurement_admin_required:'Calculation access is unavailable. Keep your Viewer workspace open and restore your authorized staff session, then try again.',
  measurement_admin_unavailable:'Open this model from your authorized Viewer workspace to calculate its volume.',
  measurement_workspace_unavailable:'The Viewer workspace is not responding. Reopen the model from your workspace, then reopen this measurement to check its calculation.',
  measurement_surface_session_required:'Volume calculation needs an active model session. Your outline remains available in this view; reopen the model from your workspace to restore access.',
  measurement_surface_access_unavailable:'Volume calculation access is unavailable for this model. Your outline has not been deleted. Restore access and try again.',
  measurement_calculation_not_found:'This calculation could not be accessed in the current session. Your saved outline and volume have not been changed. Reopen the model from your workspace and try again; ask the model owner to check access if it persists.',
  measurement_queue_full:'Other calculations are in progress. Your outline is unchanged; try calculating again shortly.',
  measurement_rate_limited:'Too many calculations were requested recently. Your outline is unchanged; wait a moment before trying again.',
  measurement_limit:'This area exceeds the calculation limit. Try a smaller outline around one pile.',
  measurement_boundary_elevation_unavailable:'Part of the outline has no elevation data. Move those points onto the surveyed surface and try again.',
});
export function surfaceCalculationError(error){
  const message=guidance[error?.code];
  return message?Object.assign(new Error(message),{code:error.code,status:error.status}):error;
}

const abortError=()=>Object.assign(new Error('Stopped watching this calculation. It may still be running; inspect its status before starting another.'),{name:'AbortError'});
function pause(ms,signal){return new Promise((resolve,reject)=>{if(signal?.aborted)return reject(abortError());const abort=()=>{clearTimeout(timer);reject(abortError());};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);signal?.addEventListener('abort',abort,{once:true});});}

// Uses a scoped raster client or staff broker. This is not a generic processing proxy,
// and a denied or failed server request never falls back to local calculation.
export function createServerSurfaceCalculator({request,isCurrent=()=>true,getRecord,pollMs=3000,wait=pause}){
  if(typeof request!=='function')throw new Error('Open this model from your authorized Viewer workspace to calculate volume.');
  return async function calculate(record,{signal,reference,sourceKind='auto',confirmMeters=false,onProgress=()=>{},onJob=()=>{}}={}){
    const current=()=>{if(signal?.aborted)throw abortError();if(!isCurrent())throw new Error('Measurement access or view changed. Reopen this measurement from the current authorized view.');};
    const send=async(operation,payload)=>{current();let response;try{response=await request(operation,payload,record);}catch(error){throw surfaceCalculationError(error);}current();return response;};
    current();record=structuredClone(getRecord?.()||record);
    onProgress('Checking the elevation data for your outline…');
    const capabilities=await send('capabilities',{});
    const rasterAllowed=capabilities?.capabilities?.rasterCalculations===true||capabilities?.capabilities?.serverCalculations===true;
    const pointAllowed=capabilities?.capabilities?.pointSurfaceCalculations===true;
    if(!rasterAllowed&&!pointAllowed)throw new Error('Your current access does not allow volume calculations.');
    const temporary=capabilities.capabilities.temporaryCalculations===true;
    const geometryHash=temporary?await measurementGeometryHash(record):null;current();
    if(temporary){
      if(!capabilities.modelVersionId||(record.modelVersionId&&record.modelVersionId!==capabilities.modelVersionId))throw new Error('The model version could not be verified. Reopen the model before calculating.');
      record={...record,revision:1,modelVersionId:capabilities.modelVersionId};
    }
    const sources=availableAdminSources({...capabilities,capabilities:{...capabilities.capabilities,serverCalculations:true}}).filter(s=>rasterAllowed&&['dsm','dtm'].includes(s.kind)&&s.methods.includes('surface-cut-fill')||pointAllowed&&s.kind==='ept'&&s.methods.includes('point-surface-cut-fill'));
    if(!['auto','dsm','dtm','ept'].includes(sourceKind))throw new Error('The calculation source needs review by the model owner. Your outline and area are unchanged.');
    const savedSource=record.results?.source;
    const savedKind=savedSource?.kind||record.results?.sourceKind;
    // Viewing mode is presentation, not a calculation setting. Prefer the same
    // original DSM for every new outline; only use points if no eligible DSM
    // exists. Saved sources remain pinned, including when no longer available.
    const kind=sourceKind==='auto'?(savedKind||(sources.some(s=>s.kind==='dsm')?'dsm':'ept')):sourceKind;
    // Do not silently substitute bare-earth DTM for a missing stockpile DSM.
    const source=sources.find(s=>s.kind===kind&&(!(savedSource?.assetId&&savedKind===kind)||s.assetId===savedSource.assetId));
    if(!source)throw new Error('The survey surface needed for this calculation is unavailable. Your outline and area are unchanged. Contact the model owner to check the elevation data.');
    reference=reference||record.results?.reference||{type:'boundary-triangulated',offsetM:0};
    // Reuse base validation, but ordinary point requests never assert source units.
    const baseSource={...source,methods:['surface-cut-fill']};
    const body=adminCalculationRequest(record,{method:'surface-cut-fill',sourceAssetId:source.assetId,reference:reference?.type,offsetM:reference?.offsetM??0,elevationM:reference?.elevationM,displayUnits:'metric',confirmMeters:source.kind!=='ept'&&confirmMeters},[baseSource]);
    if(source.kind==='ept')Object.assign(body,{method:'point-surface-cut-fill',cellSizeM:savedKind==='ept'?(savedSource?.samplingGrid?.cellSizeM??savedSource?.cellSizeM??.1):.1,classFilter:savedKind==='ept'?(savedSource?.classFilter??'all'):'all'});
    const matchesParameters=job=>{
      const p=job.parameters;
      return job.measurementId===record.id&&(!temporary||job.geometryHash===geometryHash)&&p?.method===body.method&&p.sourceAssetId===body.sourceAssetId&&p.reference?.type===body.reference.type&&(p.reference?.offsetM??0)===body.reference.offsetM&&(body.reference.type!=='custom'||p.reference?.elevationM===body.reference.elevationM)&&(p.sourceVerticalUnit??null)===(body.sourceVerticalUnit??null)&&(source.kind!=='ept'||p.cellSizeM===body.cellSizeM&&p.classFilter===body.classFilter);
    };
    const matches=job=>job.revision===record.revision&&matchesParameters(job);
    const currentBasePolicy=job=>source.kind==='ept'||body.reference.type==='custom'||job?.result?.source?.boundaryElevationBasis==='native-raster';
    const attachedMatch=job=>!temporary&&job?.status==='complete'&&currentBasePolicy(job)&&job.id===record.results?.calculationJobId&&Number.isSafeInteger(job.revision)&&job.revision<record.revision&&job.attachmentRevision===record.revision&&matchesParameters(job);
    const exposeCancel=job=>onJob({cancel:()=>send('cancel',{measurementId:record.id,jobId:job.id})});
    const recover=async()=>{
      const response=await send('list',{measurementId:record.id});
      if(!Array.isArray(response?.calculations))throw new Error('Could not check existing volume calculations. No duplicate calculation was started.');
      const relevant=response.calculations.filter(j=>j.measurementId===record.id&&j.revision===record.revision);
      const active=relevant.find(j=>['queued','running'].includes(j.status));
      if(active&&!matches(active)){exposeCancel(active);throw surfaceCalculationError({code:'measurement_calculation_already_active'});}
      const existing=active||relevant.find(j=>j.status==='complete'&&currentBasePolicy(j)&&matches(j))||response.calculations.find(attachedMatch);
      if(existing)return existing;
      if(!temporary&&record.results?.calculationJobId&&!response.calculations.some(j=>j.id===record.results.calculationJobId)){
        let attached;try{attached=(await send('status',{measurementId:record.id,jobId:record.results.calculationJobId}))?.calculation;}catch(error){if(error.code!=='measurement_calculation_not_found')throw error;}
        if(attachedMatch(attached))return attached;
      }
      return null;
    };
    onProgress('Checking for an existing volume calculation…');
    let job=await recover();
    if(!job){
      onProgress('Starting your volume calculation…');
      try{job=(await send('create',{measurementId:record.id,request:body}))?.calculation;}
      catch(error){if(error.code!=='measurement_calculation_already_active')throw error;job=await recover();if(!job)throw error;}
    }
    const jobId=job?.id;
    if(typeof jobId!=='string'||!jobId)throw new Error('The calculation could not be identified. Check existing calculations before retrying.');
    for(;;){
      current();
      if(job?.id!==jobId||job.measurementId!==record.id||(job.revision!==record.revision&&!attachedMatch(job))||(temporary&&job.geometryHash!==geometryHash))throw new Error('The calculation does not match this polygon revision. No result was attached.');
      if(job.status==='complete'){
        onJob(null);
        if(!currentBasePolicy(job))throw new Error('This calculation used an older ground reference. No new volume was saved. Choose Calculate volume again to use the updated survey surface; your outline and previously saved result are unchanged.');
        const result=job.result;
        if(result?.method!==body.method||!['cutM3','fillM3','netM3','coverage'].every(key=>Number.isFinite(result[key]))||result.cutM3<0||result.fillM3<0||result.coverage<0||result.coverage>1)throw new Error('The surface result is unusable. No result was attached.');
        if(source.kind==='ept'){
          validatePointSamplingGrid(result.source?.samplingGrid);
          if(result.calculationOrigin!=='server-original-point-surface'||!['sha256','manifestSha256'].every(k=>/^[a-f0-9]{64}$/i.test(result.source?.[k]||''))||result.source?.verticalUnit!=='m'||result.source?.verticalUnitBasis!=='ept-vertical-crs'||result.source?.classFilter!==body.classFilter||result.source?.samplingGrid.cellSizeM!==body.cellSizeM)throw new Error('The point surface is missing matching source and grid provenance. No result was attached.');
        }
        if(result.source?.assetId!==source.assetId||result.source?.kind!==source.kind||!record.modelVersionId||result.source?.modelVersionId!==record.modelVersionId||result.reference?.type!==body.reference.type||(result.reference?.offsetM??0)!==body.reference.offsetM||(body.reference.type==='custom'&&result.reference?.elevationM!==body.reference.elevationM))throw new Error('The result does not match the selected source, model version, or reference base. No result was attached.');
        return {...result,calculationJobId:jobId};
      }
      if(job.status==='failed'){onJob(null);throw surfaceCalculationError(Object.assign(new Error(`The volume calculation could not finish (${String(job.errorCode||'unavailable').replaceAll('_',' ')}).`),{code:job.errorCode}));}
      if(job.status==='cancelled'){onJob(null);throw new Error('Volume calculation cancelled. No new volume was saved.');}
      if(!['queued','running'].includes(job.status))throw new Error('The calculation status could not be understood. Check existing calculations before retrying.');
      exposeCancel(job);
      onProgress(job.status==='queued'?'Waiting to calculate your volume. You can close this window; the calculation will continue.':'Calculating your volume from the original elevation data. You can close this window; the calculation will continue.');
      await wait(pollMs,signal);current();
      job=(await send('status',{measurementId:record.id,jobId}))?.calculation;
    }
  };
}
