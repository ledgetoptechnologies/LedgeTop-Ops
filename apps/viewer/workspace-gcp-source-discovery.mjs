const ID=/^[A-Za-z0-9_-]{1,128}$/,HASH=/^[a-f0-9]{64}$/;
const validId=value=>typeof value==='string'&&ID.test(value);
const need=(value,message)=>{if(!value)throw new Error(message);};
const formats=new Set(['emlid-all-columns-v1','generic-csv-v1']);
function candidateValid(value){return value&&validId(value.sourceFileId)&&HASH.test(value.sourceSha256)&&formats.has(value.format)&&
  typeof value.fileName==='string'&&value.fileName.length>0&&value.fileName.length<=1024&&!/[\x00-\x1f\x7f]/.test(value.fileName)&&
  Number.isInteger(value.pointCount)&&value.pointCount>=1&&value.pointCount<=5000;}
export function existingDiscoveredSet(candidate,sets=[]){return sets.find(set=>set.sourceFileId===candidate.sourceFileId&&set.sourceSha256===candidate.sourceSha256)||null;}

export function createGcpSourceDiscovery({api,getContext,canWrite,randomUUID}){
  let context=null,epoch=0;const pages=new Map(),receipts=new Map(),previews=new WeakMap();
  const previewBinding=(datasetId,candidate,value)=>JSON.stringify([datasetId,candidate.sourceFileId,
    candidate.sourceSha256,candidate.fileName,candidate.format,candidate.pointCount,
    value.sourceSha256,value.pointCount,value.confirmationToken,value.provenance]);
  function clear(){pages.clear();context=null;epoch++;for(const receipt of receipts.values())receipt.fenced=true;}
  function snapshot(){const current=getContext();need(current,'Open Viewer from Operations to continue.');
    if(context!==current){clear();context=current;}const generation=epoch;
    return()=>getContext()===current&&context===current&&epoch===generation;}
  async function call(path,options,guard){need(guard(),'Viewer session changed. Refresh saved control-point sets before continuing.');
    const result=await api(path,{...options,recoveryGuard:guard});
    need(guard(),'Viewer session changed. Refresh saved control-point sets before continuing.');return result;}
  async function load(datasetId,{more=false,force=false}={}){
    need(validId(datasetId),'Invalid dataset.');const guard=snapshot();let page=pages.get(datasetId);
    if(page?.busy)return page.busy;if(page?.data&&!more&&!force)return page.data;
    if(!page){if(pages.size>=32)pages.delete([...pages].find(([,value])=>!value.busy)?.[0]);
      need(pages.size<32,'Too many active CSV lookups. Close another task first.');page={data:null,busy:null};pages.set(datasetId,page);}
    const afterId=more?page.data?.nextAfterId:null;need(!more||validId(afterId||''),'No additional CSV page is available.');
    const run=async()=>{const query=afterId?`?afterId=${encodeURIComponent(afterId)}`:'';
      const data=await call(`/api/v1/datasets/${encodeURIComponent(datasetId)}/gcp-source-candidates${query}`,{},guard);
      need(data&&Array.isArray(data.candidates)&&data.candidates.length<=2&&data.candidates.every(candidateValid)&&
        [data.ignored,data.unavailable].every(value=>Number.isInteger(value)&&value>=0&&value<=2)&&
        (data.nextAfterId===null||validId(data.nextAfterId)),'CSV discovery response could not be confirmed.');
      page.data=data;return data;};
    page.busy=run();try{return await page.busy;}finally{page.busy=null;}
  }
  async function preview(datasetId,candidate){
    need(canWrite()&&validId(datasetId)&&candidateValid(candidate),'CSV import is not available.');const guard=snapshot();
    const value=await call(`/api/v1/datasets/${encodeURIComponent(datasetId)}/gcp-sets/import-preview`,
      {method:'POST',body:{format:candidate.format,sourceFileId:candidate.sourceFileId}},guard);
    need(value?.sourceSha256===candidate.sourceSha256&&value.pointCount===candidate.pointCount&&HASH.test(value.confirmationToken||'')&&
      value.provenance?.adapter===candidate.format&&['m','ftUS'].includes(value.provenance?.linearUnit)&&
      ['coordinateSystem','verticalDatum'].every(key=>typeof value.provenance[key]==='string'&&value.provenance[key].trim()&&value.provenance[key].length<=300),
      'The CSV changed or its preview could not be confirmed. Refresh detected files.');
    previews.set(value,{guard,binding:previewBinding(datasetId,candidate,value)});
    return value;
  }
  async function confirm(datasetId,candidate,preview){
    need(canWrite()&&validId(datasetId)&&candidateValid(candidate)&&preview?.sourceSha256===candidate.sourceSha256&&
      preview.pointCount===candidate.pointCount&&HASH.test(preview.confirmationToken||''),'CSV confirmation is no longer valid.');
    const approved=previews.get(preview);
    need(approved?.guard()&&approved.binding===previewBinding(datasetId,candidate,preview),
      'CSV preview expired or changed. Review the source again in your current Viewer session.');
    const guard=approved.guard,displayName=(candidate.fileName.replace(/\.[^.]+$/,'').trim()||'Detected control points').slice(0,160);
    const key=JSON.stringify([datasetId,candidate.sourceFileId,candidate.sourceSha256,candidate.format,preview.confirmationToken]);
    let receipt=receipts.get(key);
    if(!receipt){need(receipts.size<32,'Too many unresolved imports. Review saved control-point sets before continuing.');
      receipt={key:randomUUID(),body:Object.freeze({displayName,format:candidate.format,sourceFileId:candidate.sourceFileId,
        confirmationToken:preview.confirmationToken}),busy:false,fenced:false};receipts.set(key,receipt);}
    need(!receipt.fenced,'An earlier import needs review after your session changed. Check saved control-point sets.');
    need(!receipt.busy,'This CSV import is already being submitted.');receipt.busy=true;
    try{const result=await call(`/api/v1/datasets/${encodeURIComponent(datasetId)}/gcp-sets/import`,
      {method:'POST',body:receipt.body,headers:{'Idempotency-Key':receipt.key}},guard);
      need(result?.set&&validId(result.set.id)&&result.set.datasetId===datasetId&&
        result.set.sourceFileId===candidate.sourceFileId&&result.set.sourceSha256===candidate.sourceSha256,
        'Import could not be confirmed. Retry the same request or review saved control-point sets.');
      receipts.delete(key);return result.set;
    }catch(error){if(!guard())receipt.fenced=true;throw error;}finally{receipt.busy=false;}
  }
  return{load,preview,confirm,clear};
}

export async function mountGcpSourceDiscovery({host,datasetId,controller,canImport,sets=[],confirmImport,onImported,onError,pageOptions,isCurrent=()=>true}){
  if(!host)return;const doc=host.ownerDocument;
  const current=()=>host.isConnected&&isCurrent(),allowed=()=>typeof canImport==='function'?canImport():canImport===true;
  const text=(tag,value)=>{const element=doc.createElement(tag);element.textContent=value;host.append(element);return element;};
  host.replaceChildren();text('p','Looking for control-point CSVs uploaded with these photos…');
  try{
    const data=await controller.load(datasetId,pageOptions);if(!current())return;host.replaceChildren();
    text('h4','Control-point CSVs in this dataset');
    if(!data.candidates.length)text('p','No valid control-point CSV was found on this page.');
    for(const candidate of data.candidates){
      text('p',`${candidate.fileName} · ${candidate.pointCount} control points`);
      const existing=existingDiscoveredSet(candidate,sets);
      if(existing){text('small','Already imported into a saved control-point set.');continue;}
      if(!allowed())continue;
      const button=text('button','Review and use these points');button.type='button';button.className='secondary-button';
      button.onclick=async()=>{button.disabled=true;try{
        need(current()&&allowed(),'This task changed. Reopen its control-point panel.');
        const preview=await controller.preview(datasetId,candidate);if(!current())return;
        if(!await confirmImport(candidate,preview))return;
        need(current()&&allowed(),'This task changed. Reopen its control-point panel.');
        const set=await controller.confirm(datasetId,candidate,preview);if(current())await onImported(set);
      }catch(error){onError(error);}finally{button.disabled=false;}};
    }
    if(data.unavailable)text('p','Some CSV files could not be verified. Their raw files were left unchanged.');
    if(data.nextAfterId){const more=text('button','Check next CSV page');more.type='button';more.className='secondary-button';
      more.onclick=()=>mountGcpSourceDiscovery({host,datasetId,controller,canImport,sets,confirmImport,onImported,onError,isCurrent,pageOptions:{more:true}});}
    const refresh=text('button','Refresh CSVs');refresh.type='button';refresh.className='secondary-button';
    refresh.onclick=()=>mountGcpSourceDiscovery({host,datasetId,controller,canImport,sets,confirmImport,onImported,onError,isCurrent,pageOptions:{force:true}});
  }catch(error){if(current()){host.replaceChildren();text('p','CSV discovery is unavailable. You can still import an original file below.');onError(error);}}
}
