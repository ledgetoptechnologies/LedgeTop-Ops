'use strict';
const crypto=require('node:crypto');
const {OrthophotoJpegJobs,POLICY_REVISION}=require('./orthophotoJpegJobs');
const {productDescriptor}=require('./productDownloads');
const HASH=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const RESULT_KEYS=['byteSize','closureEvidenceSha256','converterSha256','encoderSha256','height',
  'policyRevision','sha256','sourceAssetId','sourceByteSize','sourceSha256','sourceVersionId',
  'width','workerValidationEvidenceSha256'].sort().join(',');

// Private derived-product lookup, not an asset publisher or an authorization
// decision. Callers MUST authorize the original ortho and current model version.
// The cache root and lease token never belong in a public product descriptor.
function createOrthophotoJpegProducts({database,enabled=()=>false}={}){
  function select({modelId,versionId,asset}={}){
    if((typeof enabled==='function'?enabled():enabled)!==true)return null;
    if(!database?.prepare||asset?.kind!=='ortho'||!productDescriptor(asset,{staff:true})||
      !HASH.test(asset.sha256||'')||!Number.isSafeInteger(asset.byteSize)||asset.byteSize<=0)return null;
    const jobs=new OrthophotoJpegJobs(database);
    const source=jobs.source(versionId,asset.id);
    if(!source||source.modelId!==modelId||source.sha256!==asset.sha256||source.byteSize!==asset.byteSize)return null;
    const row=database.prepare(`SELECT * FROM viewer_orthophoto_jpeg_jobs WHERE model_id=?
      AND model_version_id=? AND source_asset_id=? AND source_snapshot_json=? AND status='succeeded'
      ORDER BY updated_unix_ms DESC,id DESC LIMIT 1`).get(modelId,versionId,asset.id,JSON.stringify(source));
    if(!row||!UUID.test(row.id)||!UUID.test(row.lease_token||'')||!jobs.sourceMatches(row))return null;
    let result;try{result=JSON.parse(row.result_json);}catch{return null;}
    if(!result||Object.keys(result).sort().join(',')!==RESULT_KEYS||
      !['sha256','closureEvidenceSha256','workerValidationEvidenceSha256','converterSha256','encoderSha256']
        .every(key=>typeof result[key]==='string'&&HASH.test(result[key]))||
      result.sourceAssetId!==source.assetId||result.sourceVersionId!==source.versionId||
      result.sourceSha256!==source.sha256||result.sourceByteSize!==source.byteSize||
      result.converterSha256!==row.converter_sha256||result.encoderSha256!==row.encoder_sha256||
      result.policyRevision!==POLICY_REVISION||result.policyRevision!==row.policy_revision||
      !Number.isInteger(row.width)||!Number.isInteger(row.height)||row.width<1||row.height<1||
      row.width>65500||row.height>65500||result.width!==row.width||result.height!==row.height||
      !Number.isSafeInteger(result.byteSize)||result.byteSize<=0||
      result.byteSize>row.width*row.height*3+32*1024*1024)return null;
    return {jobId:row.id,modelId,versionId,sourceAssetId:asset.id,sourceSha256:source.sha256,
      rootKey:'cache',relativePath:`orthophoto-jpeg/ortho-jpeg-${row.lease_token}/image.jpg`,
      sha256:result.sha256,byteSize:result.byteSize,
      fingerprint:crypto.createHash('sha256').update(JSON.stringify([
        row.id,row.lease_token,row.source_snapshot_json,row.result_json])).digest('hex'),
      product:{kind:'orthoJpg',label:'Orthophoto (full-resolution JPG)',format:'JPG',
        byteSize:result.byteSize,fileName:'orthophoto.jpg'}};
  }
  return {select};
}
module.exports={createOrthophotoJpegProducts};
