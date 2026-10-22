'use strict';
const crypto=require('node:crypto');
const {resolveOdmSourceUnitProvenance,CONTRACT}=require('./odmSourceUnitProvenance');
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);
const explicitBasis='server-inspected-explicit-metadata';
const conversionBasis='server-verified-ept-conversion';
const explicitFactors=Object.freeze({'m':1,'ft':0.3048,'us-ft':1200/3937,'cm':.01,'mm':.001,'km':1000});
function sourceBinding(request){
  const source=request?.source,crs=request?.coordinateReference?.crs;
  if(!request?.modelId||!request.modelVersionId||!source?.id||!['dsm','dtm','ept','obj','pointCloud'].includes(source.kind)||!hash(source.sha256)||!Number.isSafeInteger(source.byteSize)||source.byteSize<1||!/^EPSG:\d{4,6}$/i.test(crs||'')||(source.kind==='ept'&&!hash(source.manifestSha256)))return null;
  return {modelId:request.modelId,modelVersionId:request.modelVersionId,assetId:source.id,kind:source.kind,sha256:source.sha256,manifestSha256:source.manifestSha256||'',byteSize:source.byteSize,crs};
}
function matchedSourceUnitEvidence(request,evidence=request?.sourceUnitEvidence){
  const binding=sourceBinding(request);
  if(!binding||!evidence||evidence.schemaVersion!==1||evidence.verticalDatum!=='unknown')return null;
  if(evidence.basis===conversionBasis){
    if(binding.kind!=='ept'||!Object.hasOwn(explicitFactors,evidence.verticalUnit)||evidence.verticalFactor!==explicitFactors[evidence.verticalUnit]||
      typeof evidence.conversionProof?.jobId!=='string'||!evidence.conversionProof.jobId||
      !hash(evidence.conversionProof.receiptSha256)||!hash(evidence.conversionProof.inputProofSha256))return null;
  }else if(evidence.basis===explicitBasis){
    if(!['dsm','dtm','ept','pointCloud'].includes(binding.kind)||!Object.hasOwn(explicitFactors,evidence.verticalUnit)||evidence.verticalFactor!==explicitFactors[evidence.verticalUnit])return null;
  }else if(evidence.verticalUnit!=='m'||!['administrator-reviewed-source','verified-odm-source'].includes(evidence.basis)||
    binding.kind==='pointCloud'&&evidence.basis!=='verified-odm-source')return null;
  if(binding.kind==='pointCloud'&&evidence.basis==='verified-odm-source'){
    const proof=evidence.producerProof;
    if(!proof||proof.contract!==CONTRACT||proof.engine!=='ODM'||proof.engineVersion!=='3.5.6'||
      !['archiveSha256','inputManifestSha256','logSha256','coordsSha256','photosSha256'].every(key=>hash(proof[key]))||
      !Number.isFinite(proof.gpsZOffsetMetres))return null;
  }
  if(Object.entries(binding).some(([key,value])=>evidence[key]!==value))return null;
  return evidence;
}
function sourceUnitDisplayEvidence(evidence){
  if(!evidence)return null;
  const keys=['schemaVersion','modelId','modelVersionId','assetId','kind','sha256','manifestSha256','byteSize','crs','verticalUnit','verticalFactor','verticalDatum','basis'];
  return Object.fromEntries(keys.filter(key=>Object.hasOwn(evidence,key)).map(key=>[key,evidence[key]]));
}
class MeasurementSourceUnitEvidence {
  constructor(database){this.database=database;}
  summary(modelId,modelVersionId,source){
    const row=this.database.prepare('SELECT evidence_json FROM measurement_source_unit_evidence WHERE model_id=? AND model_version_id=? AND asset_id=? AND source_sha256=? AND manifest_sha256=? AND byte_size=?').get(modelId,modelVersionId,source.id,source.sha256,source.manifestSha256||'',source.byteSize);
    if(!row)return null;
    try{
      const evidence=JSON.parse(row.evidence_json),request={modelId,modelVersionId,source,coordinateReference:{crs:evidence.crs}};
      if(!matchedSourceUnitEvidence(request,evidence))return null;
      // Capability hints never expose the reviewing employee or authorize a
      // browser assertion. Calculations independently load the full evidence.
      return {...sourceBinding(request),verticalUnit:evidence.verticalUnit,...([explicitBasis,conversionBasis].includes(evidence.basis)?{verticalFactor:evidence.verticalFactor}:{}),verticalDatum:evidence.verticalDatum,basis:evidence.basis};
    }catch{return null;}
  }
  get(request){
    const binding=sourceBinding(request);if(!binding)return null;
    const row=this.database.prepare('SELECT evidence_json FROM measurement_source_unit_evidence WHERE model_id=? AND model_version_id=? AND asset_id=? AND source_sha256=? AND manifest_sha256=? AND byte_size=?').get(binding.modelId,binding.modelVersionId,binding.assetId,binding.sha256,binding.manifestSha256,binding.byteSize);
    if(!row)return null;
    try{return matchedSourceUnitEvidence(request,JSON.parse(row.evidence_json));}catch{return null;}
  }
  // Internal ingestion only. Inspection must come from the shared server byte
  // inspector, never imported assertions or an API body. Exact registration and
  // inspection bindings are independently checked before persisting evidence.
  recordExplicitMetadata(request,inspection){
    const binding=sourceBinding(request);
    if(!binding||!['dsm','dtm','ept','pointCloud'].includes(binding.kind)||!inspection||
      inspection.crs!==binding.crs||inspection.sha256!==binding.sha256||inspection.byteSize!==binding.byteSize||
      (inspection.manifestSha256||'')!==binding.manifestSha256||
      !Object.hasOwn(explicitFactors,inspection.originalUnit)||inspection.verticalFactor!==explicitFactors[inspection.originalUnit])return null;
    const registered=this.database.prepare(`SELECT 1 FROM model_assets a JOIN model_versions v ON v.id=a.version_id
      WHERE a.id=? AND a.version_id=? AND v.model_id=? AND a.kind=? AND a.sha256=? AND a.byte_size=?
      AND COALESCE(a.manifest_sha256,'')=?`).get(binding.assetId,binding.modelVersionId,binding.modelId,binding.kind,binding.sha256,binding.byteSize,binding.manifestSha256);
    if(!registered)return null;
    const createdAt=new Date().toISOString();
    const evidence={schemaVersion:1,id:crypto.randomUUID(),...binding,verticalUnit:inspection.originalUnit,
      verticalFactor:inspection.verticalFactor,verticalDatum:'unknown',basis:explicitBasis,recordedAt:createdAt};
    // Existing staff/producer decisions and exact retries keep their first record.
    this.database.prepare(`INSERT INTO measurement_source_unit_evidence(id,model_id,model_version_id,asset_id,source_sha256,manifest_sha256,byte_size,evidence_json,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(model_id,model_version_id,asset_id,source_sha256,manifest_sha256) DO NOTHING`).run(evidence.id,binding.modelId,binding.modelVersionId,binding.assetId,binding.sha256,binding.manifestSha256,binding.byteSize,JSON.stringify(evidence),'system:explicit-source-metadata',createdAt);
    return this.get(request);
  }
  // Called inside lease-fenced EPT registration, after the output asset/files
  // exist in this transaction. Independently reload durable receipt and native
  // proof; never accept a browser-supplied or caller-resolved unit declaration.
  recordVerifiedEptConversion(request,processing,jobId,owner,{leaseToken}={}){
    const binding=sourceBinding(request);
    if(!this.database.isTransaction||processing?.database!==this.database||binding?.kind!=='ept')return null;
    const row=this.database.prepare('SELECT * FROM model_assets WHERE id=? AND version_id=? AND kind=\'ept\'').get(binding.assetId,binding.modelVersionId);
    if(!row||row.sha256!==binding.sha256||row.byte_size!==binding.byteSize||row.manifest_sha256!==binding.manifestSha256)return null;
    const files=this.database.prepare('SELECT relative_path AS relativePath,byte_size AS byteSize,sha256 FROM model_asset_files WHERE asset_id=? ORDER BY relative_path').all(row.id);
    const outputAsset={versionId:row.version_id,attemptId:row.source_attempt_id,rootKey:row.root_key,relativePath:row.relative_path,sha256:row.sha256,byteSize:row.byte_size,manifestSha256:row.manifest_sha256,manifestFiles:files};
    const {EptConversionReceiptRepository}=require('./eptConversionReceiptRepository');
    const {unitProofSha256}=require('./eptConversionReceipt');
    const receipt=new EptConversionReceiptRepository(processing).validate(jobId,owner,outputAsset,{leaseToken});
    if(!receipt||receipt.modelId!==binding.modelId||receipt.inputUnitProof.crs!==binding.crs)return null;
    const previous=this.get(request);
    if(previous){
      const previousFactor=[explicitBasis,conversionBasis].includes(previous.basis)?previous.verticalFactor:1;
      if(previousFactor!==receipt.inputUnitProof.verticalFactor)throw Object.assign(new Error('Stored EPT unit decision conflicts with verified conversion units'),{code:'measurement_source_vertical_units_conflict'});
      return previous;
    }
    const createdAt=new Date().toISOString();
    const evidence={schemaVersion:1,id:crypto.randomUUID(),...binding,verticalUnit:receipt.inputUnitProof.verticalUnit,
      verticalFactor:receipt.inputUnitProof.verticalFactor,verticalDatum:'unknown',basis:conversionBasis,
      conversionProof:{jobId,receiptSha256:unitProofSha256(receipt),inputProofSha256:receipt.inputUnitProof.sha256},recordedAt:createdAt};
    this.database.prepare(`INSERT INTO measurement_source_unit_evidence(id,model_id,model_version_id,asset_id,source_sha256,manifest_sha256,byte_size,evidence_json,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(model_id,model_version_id,asset_id,source_sha256,manifest_sha256) DO NOTHING`).run(evidence.id,binding.modelId,binding.modelVersionId,binding.assetId,binding.sha256,binding.manifestSha256,binding.byteSize,JSON.stringify(evidence),'system:verified-ept-conversion',createdAt);
    return this.get(request);
  }
  // Internal ingestion only: producerInput must originate from durable server
  // receipts and verified bytes, never an API body or an imported assertion.
  // The resolver is deliberately invoked here rather than accepting a caller's
  // "resolved" object. Native LAZ evidence does not authorize derived EPT/OBJ.
  recordVerifiedOdm(request,producerInput){
    const binding=sourceBinding(request);
    if(!binding||!['dsm','dtm','pointCloud'].includes(binding.kind)||binding.manifestSha256)return null;
    const proof=resolveOdmSourceUnitProvenance(producerInput);
    if(proof.status!=='resolved'||proof.sourceKind!==binding.kind||proof.sourceSha256!==binding.sha256||
      proof.sourceByteSize!==binding.byteSize||`EPSG:${proof.horizontalEpsg}`!==binding.crs||
      proof.verticalUnit!=='metre'||proof.verticalDatum!=='unknown')return null;
    if(binding.kind==='pointCloud'&&request.source.relativePath!==producerInput.source.relativePath&&
      !request.source.relativePath?.endsWith(`/${producerInput.source.relativePath}`))return null;
    // Persist only after the exact native asset is registered to this version.
    const registered=this.database.prepare(`SELECT 1 FROM model_assets a JOIN model_versions v ON v.id=a.version_id
      WHERE a.id=? AND a.version_id=? AND v.model_id=? AND a.kind=? AND a.sha256=? AND a.byte_size=?
      AND COALESCE(a.manifest_sha256,'')=''
      AND (?<>'pointCloud' OR a.relative_path=?)`).get(binding.assetId,binding.modelVersionId,binding.modelId,binding.kind,binding.sha256,binding.byteSize,binding.kind,request.source.relativePath||'');
    if(!registered)return null;
    const producerProof=Object.fromEntries(['contract','engine','engineVersion','archiveSha256','inputManifestSha256',
      'logSha256','coordsSha256','photosSha256','gpsZOffsetMetres'].map(key=>[key,proof[key]]));
    const createdAt=new Date().toISOString(),actor='system:verified-odm-source';
    const evidence={schemaVersion:1,id:crypto.randomUUID(),...binding,verticalUnit:'m',verticalDatum:'unknown',
      basis:'verified-odm-source',producerProof,recordedAt:createdAt};
    this.database.prepare(`INSERT INTO measurement_source_unit_evidence(id,model_id,model_version_id,asset_id,source_sha256,manifest_sha256,byte_size,evidence_json,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(model_id,model_version_id,asset_id,source_sha256,manifest_sha256) DO NOTHING`).run(evidence.id,binding.modelId,binding.modelVersionId,binding.assetId,binding.sha256,binding.manifestSha256,binding.byteSize,JSON.stringify(evidence),actor,createdAt);
    return this.get(request);
  }
  // Call only after authoritative staff authentication and source preflight.
  // A measurement body or imported folder name must never call this directly.
  recordStaffReview(request,actorId){
    const binding=sourceBinding(request);
    if(!binding||!['dsm','dtm','ept','obj'].includes(binding.kind)||typeof actorId!=='string'||!actorId.trim()||request.sourceVerticalUnit!=='m')throw new Error('invalid source unit review');
    const evidence={schemaVersion:1,id:crypto.randomUUID(),...binding,verticalUnit:'m',verticalDatum:'unknown',basis:'administrator-reviewed-source',reviewedBy:actorId,reviewedAt:new Date().toISOString()};
    this.database.prepare(`INSERT INTO measurement_source_unit_evidence(id,model_id,model_version_id,asset_id,source_sha256,manifest_sha256,byte_size,evidence_json,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(model_id,model_version_id,asset_id,source_sha256,manifest_sha256) DO NOTHING`).run(evidence.id,binding.modelId,binding.modelVersionId,binding.assetId,binding.sha256,binding.manifestSha256,binding.byteSize,JSON.stringify(evidence),actorId,evidence.reviewedAt);
    return this.get(request);
  }
}
module.exports={MeasurementSourceUnitEvidence,matchedSourceUnitEvidence,sourceBinding,sourceUnitDisplayEvidence};
