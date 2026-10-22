// Staff-only upload orchestration. Authorization and dataset admission remain server-owned.
export const TASK_PHOTO_ACCEPT = '.jpg,.jpeg,.png,.tif,.tiff';
export const TASK_PHOTO_LIMITS = Object.freeze({maxFiles:20000,maxFileBytes:64*1024**2,maxTotalBytes:128*1024**3,maxManifestBytes:2*1024**2});
const photo = /\.(?:jpe?g|png|tiff?)$/i;
const check = signal => { if(signal?.aborted)throw signal.reason||new DOMException('Upload cancelled','AbortError'); };
const compare = (a,b) => a<b?-1:a>b?1:0;
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');

export function inspectTaskPhotos(files,{limits=TASK_PHOTO_LIMITS}={}) {
  const selected=[],ignored=[];let totalBytes=0;
  for(const file of files||[]) {
    const sourcePath=String(file.webkitRelativePath||file.name||'');
    if(!photo.test(sourcePath)){ignored.push(sourcePath);continue;}
    if(!sourcePath||sourcePath.startsWith('/')||/[\\\x00-\x1f:]/.test(sourcePath)||sourcePath.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('A selected photo has an unsafe relative path.');
    if(!Number.isSafeInteger(file.size)||file.size<=0||file.size>limits.maxFileBytes)throw new Error(`Each photo must be nonempty and at most ${Math.floor(limits.maxFileBytes/1024**2)} MB.`);
    totalBytes+=file.size;
    if(!Number.isSafeInteger(totalBytes)||totalBytes>limits.maxTotalBytes)throw new Error('Selected photos exceed the browser transfer size limit.');
    selected.push({file,sourcePath});
    if(selected.length>limits.maxFiles)throw new Error(`Select at most ${limits.maxFiles} photos.`);
  }
  if(!selected.length)throw new Error('Select supported photos or a folder containing photos.');
  selected.sort((a,b)=>compare(a.sourcePath,b.sourcePath));
  const paths=new Set(),counts=new Map();
  for(const item of selected){if(paths.has(item.sourcePath))throw new Error('The same photo path was selected more than once.');paths.add(item.sourcePath);const base=item.sourcePath.split('/').at(-1).toLowerCase();counts.set(base,(counts.get(base)||0)+1);}
  // NodeODM accepts flat filenames. Reserve every original basename before assigning
  // collision names, so generated names cannot shadow another original photo.
  const names=new Set(counts.keys());
  selected.forEach((item,index)=>{
    let relativePath=item.sourcePath;const slash=relativePath.lastIndexOf('/'),base=relativePath.slice(slash+1);
    if(counts.get(base.toLowerCase())>1){const dot=base.lastIndexOf('.'),stem=base.slice(0,dot),ext=base.slice(dot);let suffix=0,name;do{name=`${stem}--photo-${index+1}${suffix?`-${suffix}`:''}${ext}`;suffix++;}while(names.has(name.toLowerCase()));names.add(name.toLowerCase());relativePath=relativePath.slice(0,slash+1)+name;}
    item.relativePath=relativePath;item.id=`photo-${index+1}`;
  });
  return {items:selected,totalBytes,ignored,renamed:selected.filter(item=>item.relativePath!==item.sourcePath).map(({sourcePath,relativePath})=>({sourcePath,relativePath}))};
}

export async function prepareTaskPhotos(files,{signal,onProgress=()=>{},limits=TASK_PHOTO_LIMITS}={}) {
  check(signal);const selection=inspectTaskPhotos(files,{limits}),items=[];
  const specFor=(item,sha256)=>({id:item.id,relativePath:item.relativePath,byteSize:item.file.size,sha256,contentType:item.file.type||'application/octet-stream',processingRole:'image'});
  // Reject an oversized manifest using metadata before reading any photo pixels.
  // SHA-256 has a fixed encoded length. The server requires these digests up front
  // to identify resumable uploads and verify assembled originals, not for EXIF or
  // reconstruction analysis. Keep one file buffer at a time for large selections.
  if(new TextEncoder().encode(JSON.stringify(selection.items.map(item=>specFor(item,'0'.repeat(64))))).byteLength>limits.maxManifestBytes)throw new Error('Photo manifest is too large. Select fewer photos or shorter folder names.');
  let completedBytes=0;
  const report=()=>onProgress({phase:'preparing',completed:items.length,total:selection.items.length,completedBytes,totalBytes:selection.totalBytes});
  report();
  for(const item of selection.items){check(signal);const bytes=await item.file.arrayBuffer();check(signal);if(bytes.byteLength!==item.file.size)throw new Error('A selected photo changed while being read.');const sha256=await digest(bytes);check(signal);items.push({...item,spec:specFor(item,sha256)});completedBytes+=item.file.size;report();}
  const manifest=items.map(item=>item.spec);
  if(new TextEncoder().encode(JSON.stringify(manifest)).byteLength>limits.maxManifestBytes)throw new Error('Photo manifest is too large. Select fewer photos or shorter folder names.');
  return {...selection,items,manifest};
}

export async function uploadTaskPhotos({datasetId,prepared,api,token,fetcher=fetch,signal,onProgress=()=>{},now=()=>performance.now()}) {
  check(signal);if(!datasetId||!prepared?.items?.length||!token())throw new Error('A signed-in upload dataset and prepared photos are required.');
  const created=await api(`/api/v1/datasets/${encodeURIComponent(datasetId)}/uploads`,{method:'POST',body:{files:prepared.manifest},signal});check(signal);
  const {upload,uploadToken}=created||{};
  if(!upload?.id||upload.datasetId!==datasetId||upload.status!=='open'||!Number.isSafeInteger(upload.chunkSize)||upload.chunkSize<1||upload.chunkSize>32*1024**2||!Array.isArray(upload.files)||upload.files.length!==prepared.items.length||typeof uploadToken!=='string'||!uploadToken)throw new Error('The server returned an invalid upload session.');
  const remoteFiles=new Map(upload.files.map(file=>[file.id,file]));
  if(remoteFiles.size!==prepared.items.length)throw new Error('The server returned duplicate upload files.');
  // Validate the complete server manifest before transmitting any bytes.
  for(const {spec} of prepared.items){const remote=remoteFiles.get(spec.id),count=Math.ceil(spec.byteSize/upload.chunkSize)||1;if(!remote||remote.relativePath!==spec.relativePath||remote.sha256!==spec.sha256||remote.byteSize!==spec.byteSize||remote.chunkCount!==count||!Array.isArray(remote.missingChunks)||new Set(remote.missingChunks).size!==remote.missingChunks.length||remote.missingChunks.some(index=>!Number.isSafeInteger(index)||index<0||index>=count))throw new Error('The server upload manifest does not match the selected photos.');}
  let completedBytes=0,completed=0,transferredBytes=0;
  // Previously accepted chunks count toward completion, never transfer speed.
  for(const {spec} of prepared.items){const remote=remoteFiles.get(spec.id),missing=new Set(remote.missingChunks);if(!missing.size)completed++;for(let index=0;index<remote.chunkCount;index++)if(!missing.has(index))completedBytes+=Math.min(upload.chunkSize,spec.byteSize-index*upload.chunkSize);}
  const resumedBytes=completedBytes,startedAt=now();
  const report=phase=>{const elapsedSeconds=Math.max(0,(now()-startedAt)/1000);onProgress({phase,completed,total:prepared.items.length,completedBytes,totalBytes:prepared.totalBytes,transferredBytes,resumedBytes,elapsedSeconds,bytesPerSecond:elapsedSeconds>0?transferredBytes/elapsedSeconds:0});};
  report('uploading');
  for(const {file,spec} of prepared.items){const remote=remoteFiles.get(spec.id),missing=new Set(remote.missingChunks);for(let index=0;index<remote.chunkCount;index++){
    check(signal);const start=index*upload.chunkSize,end=Math.min(start+upload.chunkSize,file.size);
    if(missing.has(index)){const bytes=await file.slice(start,end).arrayBuffer();check(signal);if(bytes.byteLength!==end-start)throw new Error('A selected photo changed while uploading.');const sha256=await digest(bytes);check(signal);const credential=token();if(!credential)throw new Error('Sign in again before resuming the upload.');const response=await fetcher(`/api/v1/admin/uploads/${encodeURIComponent(upload.id)}/files/${encodeURIComponent(spec.id)}/chunks/${index}`,{method:'PUT',signal,headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/octet-stream','X-Upload-Token':uploadToken,'X-Chunk-SHA256':sha256},body:bytes});check(signal);if(!response.ok)throw new Error(`Photo chunk upload failed (${response.status}). Reselect the same photos to resume.`);}
    if(missing.has(index)){completedBytes+=end-start;transferredBytes+=end-start;report('uploading');}
  }if(missing.size){completed++;report('uploading');}}
  check(signal);if(!token())throw new Error('Sign in again before finalizing the upload.');
  report('finalizing');
  const finalized=await api(`/api/v1/admin/uploads/${encodeURIComponent(upload.id)}/finalize`,{method:'POST',body:{uploadToken},signal});check(signal);
  report('queued');
  // HTTP 202 means assembly was queued, not that the dataset is ready to submit.
  return {...finalized,uploadId:upload.id,datasetId,renamed:prepared.renamed};
}
