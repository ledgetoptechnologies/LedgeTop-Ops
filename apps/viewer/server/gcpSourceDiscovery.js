'use strict';
const path=require('node:path');
const {MAX_GCP_SOURCE_BYTES,sourceText}=require('./gcpSourceOriginals');
const {readIndexedOriginal}=require('./gcpDatasetRetention');
const {detectGcpInterchange}=require('./gcpImport');
const isSource=file=>file?.processing_role==='gcp_source'||/\.csv$/i.test(file?.relative_path||'');
const fail=code=>{throw Object.assign(new Error(code),{code});};

function readDatasetGcpSource({database,storage,datasetId,sourceFileId,fileName=null}){
  const dataset=database.prepare("SELECT * FROM datasets WHERE id=? AND status='finalized'").get(datasetId);
  const file=database.prepare('SELECT * FROM dataset_files WHERE id=? AND dataset_id=?').get(sourceFileId,datasetId);
  if(!dataset||!file||!isSource(file)||file.byte_size>MAX_GCP_SOURCE_BYTES||
    fileName!==null&&fileName!==path.posix.basename(file.relative_path))fail('invalid_source_file');
  const bytes=readIndexedOriginal(storage,dataset.root_key,dataset.relative_path,file);
  return{content:sourceText(bytes),fileName:path.posix.basename(file.relative_path),sourceFileId:file.id,bytes};
}

function discoverDatasetGcpSources({database,storage,datasetId,afterId='',limit=2}){
  if(!Number.isInteger(limit)||limit<1||limit>5||typeof afterId!=='string'||
    afterId!==''&&!/^[A-Za-z0-9_-]{1,128}$/.test(afterId))fail('invalid_gcp_discovery_page');
  const files=database.prepare(`SELECT * FROM dataset_files WHERE dataset_id=? AND id>?
    AND (lower(relative_path) LIKE '%.csv' OR processing_role='gcp_source') ORDER BY id LIMIT ?`)
    .all(datasetId,afterId,limit+1);
  const page=files.slice(0,limit),candidates=[];let ignored=0,unavailable=0;
  for(const file of page){
    if(file.byte_size>MAX_GCP_SOURCE_BYTES){ignored++;continue;}
    let source;try{source=readDatasetGcpSource({database,storage,datasetId,sourceFileId:file.id});}
    catch(error){if(error.code==='gcp_original_encoding_unsupported')ignored++;else unavailable++;continue;}
    const detected=detectGcpInterchange(source.content);
    if(!detected){ignored++;continue;}
    candidates.push({sourceFileId:file.id,fileName:source.fileName,byteSize:Number(file.byte_size),...detected});
  }
  return{candidates,ignored,unavailable,nextAfterId:files.length>limit?page.at(-1).id:null};
}
module.exports={readDatasetGcpSource,discoverDatasetGcpSources};
