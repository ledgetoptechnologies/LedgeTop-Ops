'use strict';
// Offline inspection only. Inputs, registry, clock, observed rows and binding
// are caller-supplied/untrusted; no current authority, custody or quota exists.
// No route invokes this module. Live issuance always rejects.
const crypto=require('node:crypto'),path=require('node:path'),p=require('./referenceProtocol'),{prepareReferenceSubmission}=require('./referenceSubmissionDraft');
const fields='version kind issuer keyId audience operation issuedAt expiresAt environment trustDomain coordinatorDeploymentId coordinatorAuthorityId coordinatorEpoch viewerDeploymentId viewerLedgerId viewerLedgerEpoch intentId idempotencyId jobId attemptId generation reservationRequestId inputManifestSha256 objectCount totalSourceBytes byteBudget policyId claimBindingSha256'.split(' ');
const slug=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(x),hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),integer=x=>Number.isSafeInteger(x)&&x>=0&&!Object.is(x,-0),uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x),opaque=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{43}$/.test(x)&&Buffer.from(x,'base64url').length===32&&Buffer.from(x,'base64url').toString('base64url')===x;
const fail=()=>{throw Object.assign(new Error('v2 issuer inspection unavailable'),{code:'v2_inspection_unavailable'})};
const domain=Buffer.from('ltds-v2-reservation-intent-experiment-v1\0','ascii'),digestDomain=Buffer.from('ltds-v2-reservation-intent-digest-experiment-v1\0','ascii');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function inspectFixture({scope,processing,bindingId,intentBytes,signature,registryEntry,expectedIntent,now,submission,capabilities,optionsCatalog,sourceFiles,excludedIds}={}){
 if(scope!=='isolated-v2-issuer-inspection')fail();
 try{
  if(!processing?.database||!slug(bindingId)||!Buffer.isBuffer(intentBytes)||!intentBytes.length||intentBytes.length>16384||!Buffer.isBuffer(signature)||signature.length!==64||!integer(now)||!registryEntry||!expectedIntent)fail();
  const raw=Buffer.from(intentBytes);if([...raw].some(x=>x>127))fail();const intent=JSON.parse(raw.toString('ascii'));
  if(!intent||Object.getPrototypeOf(intent)!==Object.prototype||Object.keys(intent).length!==fields.length||fields.some(k=>!Object.hasOwn(intent,k))||!p.canonicalBytes(intent).equals(raw)||!p.canonicalBytes(expectedIntent).equals(raw))fail();
  if(intent.version!==1||intent.kind!=='reservation-intent'||intent.operation!=='reserve-source'||!['staging','production'].includes(intent.environment)||intent.audience!==intent.viewerDeploymentId||!['issuer','keyId','audience','operation','trustDomain','coordinatorDeploymentId','coordinatorAuthorityId','coordinatorEpoch','viewerDeploymentId','viewerLedgerId','viewerLedgerEpoch','policyId'].every(k=>slug(intent[k]))||!['jobId','attemptId'].every(k=>uuid(intent[k]))||!['intentId','idempotencyId','reservationRequestId'].every(k=>opaque(intent[k]))||!['inputManifestSha256','claimBindingSha256'].every(k=>hash(intent[k]))||!['issuedAt','expiresAt','generation','objectCount','totalSourceBytes','byteBudget'].every(k=>integer(intent[k]))||intent.generation<1||intent.objectCount<1||intent.byteBudget<intent.totalSourceBytes||intent.issuedAt>now||now>=intent.expiresAt||intent.expiresAt-intent.issuedAt>300)fail();
  if(registryEntry.issuer!==intent.issuer||registryEntry.keyId!==intent.keyId||registryEntry.purpose!=='grant'||registryEntry.audience!==intent.audience||registryEntry.operation!==intent.operation||registryEntry.revoked!==false||!integer(registryEntry.notBefore)||!integer(registryEntry.notAfter)||registryEntry.notBefore>intent.issuedAt||registryEntry.notAfter<intent.expiresAt||!Buffer.isBuffer(registryEntry.publicKeyDer)||!crypto.verify(null,Buffer.concat([domain,raw]),{key:registryEntry.publicKeyDer,format:'der',type:'spki'},signature))fail();
  p.validateSubmission(submission,{capabilities});const manifest=submission.manifest;if(manifest.sha256!==intent.inputManifestSha256||manifest.objectCount!==intent.objectCount||manifest.totalBytes!==intent.totalSourceBytes)fail();
  const db=processing.database,binding=db.prepare("SELECT * FROM viewer_source_bindings WHERE id=? AND state='prepared'").get(bindingId);if(!binding)fail();
  const dataset=db.prepare('SELECT id,project_id,storage_mode,root_key,relative_path,status,manifest_sha256,file_count,byte_size FROM datasets WHERE id=?').get(binding.dataset_id);
  if(!dataset||dataset.project_id!==binding.project_id||dataset.storage_mode!=='managed'||dataset.root_key!==binding.root_key||dataset.relative_path!==binding.relative_path||dataset.status!=='finalized'||dataset.manifest_sha256!==binding.dataset_manifest_sha256)fail();
  const rows=db.prepare('SELECT id,relative_path,byte_size,sha256 FROM dataset_files WHERE dataset_id=? ORDER BY rowid LIMIT 20002').all(dataset.id),bound=db.prepare('SELECT file_id,relative_path,byte_size,sha256 FROM viewer_source_binding_objects WHERE binding_id=? ORDER BY file_id').all(bindingId);
  if(rows.length<1||rows.length>20001||rows.length!==dataset.file_count||rows.length!==binding.object_count||bound.length!==rows.length)fail();
  let total=0;const files=new Map(),paths=new Set();for(const row of rows){if(!slug(row.id)||typeof row.relative_path!=='string'||!row.relative_path||row.relative_path.includes('\\')||row.relative_path.split('/').some(x=>!x||x==='.'||x==='..')||!integer(row.byte_size)||!hash(row.sha256)||files.has(row.id)||paths.has(row.relative_path))fail();total+=row.byte_size;if(!integer(total))fail();files.set(row.id,row);paths.add(row.relative_path)}
  if(total!==dataset.byte_size||sha(JSON.stringify(rows.map(r=>({relativePath:r.relative_path,byteSize:r.byte_size,sha256:r.sha256}))))!==dataset.manifest_sha256)fail();
  for(const row of bound){const f=files.get(row.file_id);if(!f||row.relative_path!==f.relative_path||row.byte_size!==f.byte_size||row.sha256!==f.sha256)fail()}
  if(!sourceFiles||Object.getPrototypeOf(sourceFiles)!==Object.prototype||!Array.isArray(excludedIds)||new Set(excludedIds).size!==excludedIds.length)fail();
  const objects=manifest.objects,ids=new Set(objects.map(o=>o.id));if(ids.size!==objects.length||Object.keys(sourceFiles).length!==ids.size||Object.keys(sourceFiles).some(id=>!ids.has(id)))fail();
  const excluded=[...files.keys()].filter(id=>!ids.has(id)).sort();if(JSON.stringify([...excludedIds].sort())!==JSON.stringify(excluded))fail();
  for(const object of objects){const f=files.get(object.id);if(!f||sourceFiles[object.id]!==f.relative_path||path.posix.basename(f.relative_path)!==object.name||f.byte_size!==object.byteSize||f.sha256!==object.sha256)fail()}
  // Rebuild the currently supported image-only projection from indexed roles;
  // generated GCP auxiliaries require a separately designed binding.
  const rebuilt=prepareReferenceSubmission({enabled:true,dataset:processing.getDataset(dataset.id,true),submissionId:submission.submissionId,capabilities,optionsCatalog,odmOptions:submission.pipeline.odm.options});
  if(!p.canonicalBytes(rebuilt.submission).equals(p.canonicalBytes(submission))||!p.canonicalBytes({...rebuilt.sourceFiles}).equals(p.canonicalBytes(sourceFiles))||rebuilt.permanentCsvIds.some(id=>!excluded.includes(id)))fail();
  return Object.freeze({scope:'supplied_fixture_snapshots_not_authority',datasetManifestSha256:dataset.manifest_sha256,processingManifestSha256:manifest.sha256,intentDigest:sha(Buffer.concat([digestDomain,raw])),selectedCount:ids.size,excludedCount:excluded.length,viewerCoordinatorAttemptBinding:'unverified',claimBinding:'unverified'});
 }catch(error){if(error?.code==='v2_inspection_unavailable')throw error;fail()}
}
function issue(){fail()}
module.exports={inspectFixture,issue};
