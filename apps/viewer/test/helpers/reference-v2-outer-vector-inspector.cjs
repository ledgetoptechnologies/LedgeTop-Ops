'use strict';
// Exact public vector inspection only. Not a general v2 parser, an issuer,
// byte-custody proof, acceptance/outbox, or a production route.
const crypto=require('node:crypto'),unzipper=require('unzipper'),p=require('../../server/referenceProtocol');
const hashes={treedar_only:'5d161bb1f56cc72d20123f5c63ae6c741e5e50683bb5b6c9ec7f89126c2f5b4d',combined:'2259fc94ba972bdbd98aa965f9c3663421ee0746447f124fc506d6acffa4e2d6'};
const sourceHash='0b11c0b8958fbfcb170b42fe6e61a07d95b17a7140d905137f760e74d6ec8b34';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=()=>{throw Error('pinned_fixture_invalid')};
const required=['dtm.tif','chm.tif','chm_raw.tif','crowns.tif','trees.csv','tree_features.csv','summary.json','manifest.json','report.html','tree_map.geojson','areas.png','tree_map.png'];
async function inspectPinnedFixture(mode,raw,source){
  if(!Object.hasOwn(hashes,mode)||!Buffer.isBuffer(raw)||raw.length>4*1024*1024||sha(raw)!==hashes[mode]||!Buffer.isBuffer(source)||sha(source)!==sourceHash)fail();
  // A digest-gated public fixture is deliberately narrower than schema parsing.
  const fixture=JSON.parse(raw.toString('utf8')),vocabulary=JSON.parse(source.toString('utf8')).nativeVocabulary;
  if(fixture.mode!==mode||fixture.status!=='SYNTHETIC_EXPECTED_CONTEXT_NOT_AUTHORITY')fail();
  const matches=fixture.documents.filter(d=>d.type==='ResultManifest'&&d.value.stage.engine==='treedar');
  if(matches.length!==1)fail();const result=matches[0].value;
  const objects=result.objects.filter(x=>x.role==='treedar_bundle');if(objects.length!==1)fail();const obj=objects[0];
  if(obj.format!=='zip'||obj.physicalKind!=='file')fail();
  const artifact=fixture.artifacts.find(x=>x.id===obj.id),closure=fixture.closureDescriptors.find(x=>x.artifactId===obj.id)?.descriptor;
  if(!artifact||!closure||typeof artifact.bytesBase64!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(artifact.bytesBase64))fail();
  const zip=Buffer.from(artifact.bytesBase64,'base64');if(zip.toString('base64')!==artifact.bytesBase64||zip.length!==obj.byteSize||artifact.byteSize!==obj.byteSize||sha(zip)!==obj.sha256||artifact.sha256!==obj.sha256)fail();
  if(closure.format!=='ltds-treedar-bundle-v1'||closure.manifestSha256!==obj.artifactManifestSha256)fail();
  const {manifestSha256,...manifestPayload}=closure;if(p.sha256(p.canonicalBytes(manifestPayload))!==manifestSha256)fail();
  const sourceLidar=closure.binding.sourceLidar,input=fixture.expectedContext.originalSubmission.inputManifest.objects.find(x=>x.id===sourceLidar.objectId);
  if(!input||input.kind!=='lidar'||input.byteSize!==sourceLidar.byteSize||input.sha256!==sourceLidar.sha256||!obj.sourceObjectIds.includes(input.id))fail();
  for(const key of ['jobId','generation','environment','inputManifestSha256','pipelineDigest'])if(closure.binding[key]!==result.binding[key])fail();
  const entries=await unzipper.Open.buffer(zip);if(entries.files.length!==closure.files.length+1||entries.files.length>65)fail();
  const names=new Set(),byName=new Map();for(const entry of entries.files){if(entry.type!=='File'||names.has(entry.path.toLowerCase()))fail();names.add(entry.path.toLowerCase());byName.set(entry.path,entry)}
  const manifest=byName.get('treedar-bundle.json');if(!manifest||!(await manifest.buffer()).equals(p.canonicalBytes(closure)))fail();
  let total=0;const nativeNames=new Set();for(const item of closure.files){
    const mapping=vocabulary[item.nativePath],file=byName.get(`artifacts/${item.nativePath}`);if(!mapping||mapping[0]!==item.role||mapping[1]!==item.format||!file||nativeNames.has(item.nativePath.toLowerCase()))fail();
    nativeNames.add(item.nativePath.toLowerCase());const bytes=await file.buffer();if(bytes.length!==item.byteSize||sha(bytes)!==item.sha256)fail();total+=bytes.length;
  }
  if(total!==closure.rawBytes||required.some(name=>!nativeNames.has(name)))fail();
  // Explicitly no acceptance, dispatch, download, publication or credential.
  return {mode,role:obj.role,artifactId:obj.id,files:closure.files.length,action:'hold',scope:'exact-public-fixture-only'};
}
module.exports={inspectPinnedFixture};
