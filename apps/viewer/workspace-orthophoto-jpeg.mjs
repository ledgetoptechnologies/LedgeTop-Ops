const ID=/^[A-Za-z0-9_-]{1,128}$/;
const STATUSES=new Set(['queued','leased','cleanup_required','succeeded','failed']);
const LABELS={queued:'Full-resolution JPG is queued.',leased:'Preparing full-resolution JPG…',
  cleanup_required:'JPG preparation needs an administrator to check worker cleanup.',
  succeeded:'JPG preparation finished. Refresh products to check download availability.',
  failed:'JPG preparation failed. The original TIFF is still available.'};

export function jpegPreparationView(output,canWrite){
  const value=output?.jpegPreparation;
  if(!canWrite||!value||!ID.test(value.modelId)||!ID.test(value.versionId)||
    value.modelId!==output.modelId||value.versionId!==output.id||
    value.requestUrl!==`/api/v1/models/${encodeURIComponent(value.modelId)}/orthophoto-jpeg-jobs`||
    output.downloadProducts?.some(product=>product.kind==='orthoJpg'))return null;
  const status=value.job?.status;
  if(value.job&&(!ID.test(value.job.id)||!STATUSES.has(status)))return null;
  return {modelId:value.modelId,versionId:value.versionId,requestUrl:value.requestUrl,
    canRequest:!value.job,message:value.job?LABELS[status]:
      'Prepare a full-resolution JPG for easy sharing. The original TIFF is kept.'};
}

// A lost response must reuse its exact request/key. No timers, auto-retry or
// generation on render. Bounded in-memory receipts are scoped to authorization.
export function createJpegPreparationRequests({api,getContext,randomUUID}){
  const pending=new Map();let context=null,epoch=0;
  function clear(){pending.clear();context=null;epoch++;}
  async function request(output,canWrite){
    const view=jpegPreparationView(output,canWrite),current=getContext();
    if(!view?.canRequest||!current)throw new Error('JPG preparation is not available for this output.');
    if(context!==current){clear();context=current;}
    const generation=epoch;
    const key=JSON.stringify([view.modelId,view.versionId]);
    let receipt=pending.get(key);
    if(!receipt){
      if(pending.size>=100)throw new Error('Too many unresolved JPG requests. Reopen the workspace to reconcile them.');
      receipt={key:randomUUID(),body:Object.freeze({versionId:view.versionId}),busy:false};pending.set(key,receipt);
    }
    if(receipt.busy)throw new Error('This JPG request is already being submitted.');
    receipt.busy=true;
    try{
      const recoveryGuard=()=>getContext()===current&&context===current&&epoch===generation;
      const result=await api(view.requestUrl,{method:'POST',body:receipt.body,headers:{'Idempotency-Key':receipt.key},recoveryGuard});
      if(getContext()!==current||context!==current||epoch!==generation)throw new Error('Your Viewer session changed. Refresh products before continuing.');
      const job=result?.job;
      if(!job||!ID.test(job.id)||job.modelId!==view.modelId||job.versionId!==view.versionId||
        job.format!=='JPG'||job.fullResolution!==true||!STATUSES.has(job.status))
        throw new Error('JPG request could not be confirmed. Retry the same request or refresh products.');
      pending.delete(key);return {id:job.id,status:job.status};
    }finally{receipt.busy=false;}
  }
  return {request,clear};
}

export function mountJpegPreparation({host,output,canWrite,requests,refresh,onError}){
  if(!host)return;
  const view=jpegPreparationView(output,canWrite);host.replaceChildren();
  if(!view)return;
  const doc=host.ownerDocument,message=doc.createElement('p');message.className='form-note';message.textContent=view.message;host.append(message);
  const button=doc.createElement('button');button.className='secondary-button';button.type='button';
  button.textContent=view.canRequest?'Prepare full-resolution JPG':'Refresh products';host.append(button);
  button.onclick=async()=>{
    button.disabled=true;
    try{
      if(!view.canRequest){await refresh();return;}
      const job=await requests.request(output,canWrite);
      output.jpegPreparation={...output.jpegPreparation,job};
      mountJpegPreparation({host,output,canWrite,requests,refresh,onError});
    }catch(error){onError(error);button.disabled=false;}
  };
}
