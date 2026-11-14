'use strict';
const {orthophotoJpegConverterSha256}=require('./orthophotoJpegConverter');
const {OrthophotoJpegJobs,sourceFingerprint,rollbackConfirmed}=require('./orthophotoJpegJobs');
const {readOrthophotoJpegSize}=require('./orthophotoJpegMetadata');
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);

function jobView(row){
  return {id:row.id,modelId:row.model_id,versionId:row.model_version_id,status:row.status,
    width:row.width,height:row.height,format:'JPG',fullResolution:true,
    errorCode:row.error_code||null,createdAt:new Date(row.created_unix_ms).toISOString(),
    updatedAt:new Date(row.updated_unix_ms).toISOString()};
}

function mountOrthophotoJpegRoutes(router,{processing,repository,storage,authorize,mutate,error,config,
  readDimensions=readOrthophotoJpegSize}){
  const jobs=new OrthophotoJpegJobs(processing.database);
  function available(req,res,next){
    if(!config.orthophotoJpegRequestsEnabled||!/^[a-f0-9]{64}$/.test(config.orthophotoJpegEncoderSha256||''))
      return error(res,503,'orthophoto_jpeg_unavailable');
    if(!id(req.params.modelId)||!req.body||Array.isArray(req.body)||
      Object.keys(req.body).join(',')!=='versionId'||!id(req.body.versionId))
      return error(res,400,'invalid_orthophoto_jpeg_request');
    next();
  }
  function sourceFailure(res,caught){
    if(res.headersSent||res.destroyed)return;
    const code=caught?.code;
    if(code==='full_resolution_jpeg_dimension_limit')return error(res,422,code);
    if(['jpeg_job_source_changed','jpeg_job_source_unavailable'].includes(code))return error(res,409,code);
    if(code==='orthophoto_metadata_nofollow_unavailable')return error(res,503,'orthophoto_jpeg_unavailable');
    if(['ENOENT','ENOTDIR','EACCES','ELOOP'].includes(code)||String(code||'').startsWith('orthophoto_metadata_'))
      return error(res,409,'orthophoto_jpeg_source_unavailable');
    return error(res,503,'orthophoto_jpeg_temporarily_unavailable');
  }
  router.post('/api/v1/models/:modelId/orthophoto-jpeg-jobs',authorize('viewer.processing.write'),available,mutate,
    async(req,res)=>{
      try{
        const selected=processing.database.prepare("SELECT id FROM model_assets WHERE version_id=? AND kind='ortho'").get(req.body.versionId);
        const source=selected&&jobs.source(req.body.versionId,selected.id);
        if(!source||source.modelId!==req.params.modelId)return error(res,409,'jpeg_job_source_unavailable');
        const fingerprint=sourceFingerprint(source);
        // Metadata only; full-file integrity and all pixels belong to the worker.
        const dimensions=await readDimensions(storage,source);
        if(!Number.isInteger(dimensions?.width)||!Number.isInteger(dimensions?.height)||
          dimensions.width<1||dimensions.height<1||dimensions.width>65500||dimensions.height>65500)
          return error(res,422,'full_resolution_jpeg_dimension_limit');
        // Recheck current staff authority after asynchronous storage access.
        return authorize('viewer.processing.write')(req,res,()=>{
          let candidate=null;
          try{
            const receipt=req.adminIdempotency;
            if(!receipt)return error(res,503,'orthophoto_jpeg_temporarily_unavailable');
            const converterHash=orthophotoJpegConverterSha256();
            const created=jobs.request({versionId:source.versionId,sourceAssetId:source.assetId,
              converterSha256:converterHash,encoderSha256:config.orthophotoJpegEncoderSha256,
              width:dimensions.width,height:dimensions.height,expectedSourceFingerprint:fingerprint,onPersisted:result=>{
                candidate={id:result.job.id,replayed:result.replayed};
                repository.audit({actorType:'admin',actorId:req.actorId,action:'orthophoto_jpeg.requested',entityType:'model_version',
                  entityId:source.versionId,details:{jobId:result.job.id,sourceAssetId:source.assetId,replayed:result.replayed}});
                const changed=processing.database.prepare(`UPDATE admin_idempotency SET response_status=202,response_json=?
                  WHERE session_id=? AND idempotency_key=? AND request_hash=? AND response_status IS NULL`)
                  .run(JSON.stringify({job:jobView(result.job)}),receipt.sessionId,receipt.key,receipt.requestHash).changes;
                if(changed!==1)throw Object.assign(new Error('idempotency receipt changed'),{code:'jpeg_request_receipt_changed'});
              }});
            // Job, audit and response receipt committed together before sending.
            req.adminIdempotencyCompleted=true;
            res.setHeader('Cache-Control','private, no-store');
            return res.status(202).json({job:jobView(created.job)});
          }catch(caught){
            // Release only our pending receipt after a verified rollback. An
            // uncertain committed job/receipt remains available for replay.
            if(candidate&&!req.adminIdempotencyCompleted&&rollbackConfirmed(caught)){
              try{
                const receipt=req.adminIdempotency;
                if(candidate.replayed||!jobs.get(candidate.id))processing.database.prepare(`DELETE FROM admin_idempotency
                  WHERE session_id=? AND idempotency_key=? AND request_hash=? AND response_status IS NULL`)
                  .run(receipt.sessionId,receipt.key,receipt.requestHash);
              }catch{/* Unknown persistence state remains reserved. */}
            }
            return sourceFailure(res,caught);
          }
        });
      }catch(caught){return sourceFailure(res,caught);}
    });
  router.get('/api/v1/models/:modelId/orthophoto-jpeg-jobs/:jobId',authorize('viewer.processing.read'),(req,res)=>{
    if(!id(req.params.modelId)||!id(req.params.jobId))return error(res,404,'orthophoto_jpeg_job_not_found');
    const row=jobs.get(req.params.jobId);
    const model=processing.database.prepare('SELECT id FROM models WHERE id=? AND unregistered_at IS NULL').get(req.params.modelId);
    if(!row||row.model_id!==req.params.modelId||!model)return error(res,404,'orthophoto_jpeg_job_not_found');
    res.setHeader('Cache-Control','private, no-store');return res.json({job:jobView(row)});
  });
}
module.exports={mountOrthophotoJpegRoutes,jobView};
