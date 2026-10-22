import {safeMeasurementCalculationErrorCode} from './measurement-calculation-broker.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(code,status=403)=>Object.assign(new Error(code.replaceAll('_',' ')),{code,status});
const scopeKey=value=>JSON.stringify([value?.modelId,value?.modelVersionId,value?.audience,value?.subject,value?.temporary]);

export function measurementAssetBearer(assetRoot,origin=location.origin){
  let url;try{url=new URL(assetRoot,origin);}catch{return null;}
  if(url.origin!==origin)return null;
  const match=/^\/session-assets\/([^/]+)\/[^/]+\//.exec(url.pathname);
  if(!match)return null;let value;try{value=decodeURIComponent(match[1]);}catch{return null;}
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)&&value.length<=4096?value:null;
}

export async function measurementGeometryHash(record){
  const bytes=new TextEncoder().encode(JSON.stringify([record.collection,record.vertices,[record.coordinateReference?.crs,record.coordinateReference?.verticalUnit]]));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
}

// Personal surface measurements use only the current Viewer capability. Never
// obtain an Operations token or offer a general-purpose processing proxy.
export function createMeasurementSurfaceClient({token,context,fetcher=fetch}){
  // Memory only: a refresh creates a new page scope and cannot restore old public jobs.
  let pageHandle=null;
  const page=()=>pageHandle??=(btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=',''));
  return async function request(operation,payload={},record){
    const credential=token(),scope=context();
    if(!credential||!scope?.modelId||!scope?.modelVersionId)throw fail('measurement_surface_session_required');
    if(!['capabilities','create','status','list','cancel'].includes(operation)||!payload||Array.isArray(payload)||JSON.stringify(payload).length>16384)throw fail('measurement_request_invalid',400);
    const keys=operation==='capabilities'?[]:operation==='create'?['measurementId','request']:operation==='list'?['measurementId']:['measurementId','jobId'];
    if(Object.keys(payload).some(key=>!keys.includes(key))||(operation!=='capabilities'&&!uuid.test(payload.measurementId||''))||(['status','cancel'].includes(operation)&&!uuid.test(payload.jobId||'')))throw fail('measurement_request_invalid',400);
    if(operation==='create'&&!['surface-cut-fill','point-surface-cut-fill','surface-transect'].includes(payload.request?.method))throw fail('measurement_method_unavailable',403);
    const temporary=scope.temporary===true,base='/api/v1/measurements'+(temporary?'/temporary':'');
    const path=operation==='capabilities'?`${base}/capabilities`:`${base}${temporary?'':'/'+encodeURIComponent(payload.measurementId)}/calculations${['status','cancel'].includes(operation)?'/'+encodeURIComponent(payload.jobId):''}${temporary&&operation==='list'?'?measurementId='+encodeURIComponent(payload.measurementId):''}`;
    let body=payload.request;
    if(temporary&&operation==='create'){
      if(!record||record.id!==payload.measurementId||record.kind!=='polygon')throw fail('measurement_request_invalid',400);
      body={measurement:Object.fromEntries(['id','name','collection','kind','vertices','coordinateReference','source'].filter(k=>record[k]!==undefined).map(k=>[k,record[k]])),request:payload.request};
      if(JSON.stringify(body).length>256*1024)throw fail('measurement_request_invalid',400);
    }
    const response=await fetcher(path,{method:operation==='create'?'POST':operation==='cancel'?'DELETE':'GET',credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(35000),headers:{Authorization:`Bearer ${credential}`,Accept:'application/json',...(temporary?{'X-Measurement-Model-Version':scope.modelVersionId}:{}),...(temporary&&operation!=='capabilities'?{'X-Measurement-Page':page()}:{}),...(operation==='create'?{'Content-Type':'application/json'}:{})},...(operation==='create'?{body:JSON.stringify(body)}:{})});
    if(scopeKey(context())!==scopeKey(scope)||!token())throw fail('measurement_scope_changed');
    const result=response.status===204?{}:await response.json().catch(()=>null);
    if(scopeKey(context())!==scopeKey(scope)||!token())throw fail('measurement_scope_changed');
    if(!response.ok)throw fail(response.status===401||response.status===403?'measurement_surface_access_unavailable':safeMeasurementCalculationErrorCode(result?.code),response.status);
    if(response.status!==204&&(!result||typeof result!=='object'||Array.isArray(result)))throw fail('measurement_request_failed',502);
    if(temporary&&operation==='capabilities'&&result.modelVersionId!==scope.modelVersionId)throw fail('measurement_scope_changed');
    if(temporary&&operation==='list'&&Array.isArray(result.calculations))return{...result,calculations:result.calculations.filter(j=>j.measurementId===payload.measurementId)};
    return result;
  };
}
