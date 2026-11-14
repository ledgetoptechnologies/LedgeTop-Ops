#!/usr/bin/env node
// Diagnostic only. Owner must seal source/output mounts and bound this one-shot
// process and descendants. No reconstruction, encoding, ready flag or adoption.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';

export const ENGINE_COMMIT='0e18f938a157f882057fcbd3b040e5f0ed71ae10';
export const ENGINE_FILES=Object.freeze({
  'lib/lod-texture-association.mjs':'76fe2dc8468e6c78f62247ee668be0280bbf7fac39e47f00c6a40eefc358f802',
  'lib/pinned-basis-decoder.mjs':'7f48d901f70e7a5576c9a79540aaec560f7efb7e1737acb2fd04862e80af2e7a',
  'lib/raw-atlas-rows.mjs':'ee23b6b39ee0996f3136a54036830b327ed2681f5c061d117b0e6875aa18f090',
  'lib/texture-relation-policy.mjs':'bc06490f7968780050be659372be5546a952bb16cea5890c12018612a5481af6',
  'stream_atlas_rows.py':'88a8b11e014e6277ebba937ff0bbf27fb42aae4424276bd3b1bab0bf66b6c6b1',
});
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const relative=value=>typeof value==='string'&&value.length<=4096&&!/[\\:\x00-\x20\x7f]/.test(value)&&
  !path.posix.isAbsolute(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');
const base=value=>typeof value==='string'&&/^[A-Za-z0-9_.-]+$/.test(value)&&!['.','..'].includes(value);
const stamp=s=>['dev','ino','mode','size','mtimeNs','ctimeNs'].map(key=>String(s[key])).join(':');
const need=(value,code)=>{if(!value)throw Object.assign(new Error(code),{code:'texture_diagnostic_'+code});};

// Small synthetic tests can use this lower-component seam. Production below
// supplies only SHA-checked frozen E exports and the real pinned decoder/rows.
export async function diagnoseImagePair({image,atlas,decoder,rows,compare,checkpoint=()=>{}}){
  let metric=null;
  for await(const decoded of decoder.levels(image)){
    checkpoint();need(decoded?.level===0&&decoded.width===image.width&&decoded.height===image.height&&
      decoded.rgba instanceof Uint8Array&&decoded.rgba.byteLength===image.width*image.height*4,'level_zero');
    need(atlas.width===image.width&&atlas.height===image.height&&digest(atlas.sha256),'atlas_dimensions');
    metric=await compare({rows:rows(atlas),rgba:decoded.rgba,width:image.width,height:image.height,checkpoint});
    // Returning the iterator closes/deletes its native texture. Lower mips are
    // deliberately unexamined; this is not the whole consumer proof.
    break;
  }
  need(metric&&typeof metric.candidatePass==='boolean'&&metric.calibrationRequired===true,'metric');
  return metric;
}

export async function diagnoseRecoveryTextureRelation(request,{signal=null}={}){
  need(request&&Object.keys(request).sort().join(',')==='basisJavascript,basisWasm,engineScripts,output','request');
  const check=()=>signal?.throwIfAborted();
  check();
  for(const root of [request.engineScripts,request.output]){
    need(typeof root==='string'&&path.isAbsolute(root)&&path.resolve(root)===root&&
      await fs.promises.realpath(root)===root&&(await fs.promises.lstat(root)).isDirectory(),'root');
  }
  const tracked=new Map();let metadataBytes=0;
  async function read(filename,maximum,expected=null){
    check();need(typeof filename==='string'&&path.isAbsolute(filename)&&path.resolve(filename)===filename,'file_path');
    need(await fs.promises.realpath(filename)===filename,'link');
    const fd=await fs.promises.open(filename,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)|(fs.constants.O_NONBLOCK||0));
    try{
      const before=await fd.stat({bigint:true});
      need(before.isFile()&&before.size>0n&&before.size<=BigInt(maximum),'file_budget');
      metadataBytes+=Number(before.size);need(metadataBytes<=32*1024**2,'metadata_budget');
      const bytes=Buffer.alloc(Number(before.size));let at=0;
      while(at<bytes.length){check();const got=await fd.read(bytes,at,Math.min(1024**2,bytes.length-at),at);
        need(got.bytesRead>0,'short_read');at+=got.bytesRead;}
      need(stamp(before)===stamp(await fd.stat({bigint:true})),'changed');
      const hash=sha(bytes);need(!expected||hash===expected,'digest');tracked.set(filename,stamp(before));return bytes;
    }finally{await fd.close();}
  }
  const outputPath=name=>{need(relative(name),'relative');return path.join(request.output,...name.split('/'));};
  async function jsonLines(name,expected,maximumRows){
    need(digest(expected),'digest');const bytes=await read(outputPath(name),16*1024**2,expected);
    const lines=bytes.toString('utf8').split('\n');need(lines.pop()===''&&lines.length>0&&lines.length<=maximumRows,'framing');
    return lines.map(line=>{need(Buffer.byteLength(line)>0&&Buffer.byteLength(line)<=1024**2,'record_budget');
      const value=JSON.parse(line);need(value&&typeof value==='object'&&!Array.isArray(value),'record');return value;});
  }
  for(const [name,expected] of Object.entries(ENGINE_FILES))await read(path.join(request.engineScripts,...name.split('/')),256*1024,expected);
  const module=name=>import(pathToFileURL(path.join(request.engineScripts,'lib',name)).href);
  const {renderContents,inspectEmbeddedTile,matchDeclaredFaces}=await module('lod-texture-association.mjs');
  const {createPinnedBasisDecoder,BASIS_PINS}=await module('pinned-basis-decoder.mjs');
  const {compareAtlasLevelZero,streamRawAtlasRows}=await module('raw-atlas-rows.mjs');
  const {TEXTURE_RELATION_POLICY}=await module('texture-relation-policy.mjs');
  const javascript=await read(request.basisJavascript,128*1024,BASIS_PINS.javascript);
  const wasm=await read(request.basisWasm,1024**2,BASIS_PINS.wasm);
  const decoder=await createPinnedBasisDecoder({javascript,wasm,signal,checkpoint:check});
  const tilesetBytes=await read(outputPath('tileset.json'),16*1024**2);
  const contents=renderContents(JSON.parse(tilesetBytes));need(contents.length<=8192,'render_budget');
  need(new Set(contents.map(value=>value.uri.toLowerCase())).size===contents.length,'alias');
  const lod0=contents.filter(value=>value.fullDetail).sort((a,b)=>a.uri<b.uri?-1:a.uri>b.uri?1:0);
  need(lod0.length>0&&lod0.length<=4096,'lod0_budget');
  let comparedPairs=0,failure=null,lastPair=null;
  for(const content of lod0){
    check();const tileBytes=await read(outputPath(content.uri),16*1024**2),b3dmSha256=sha(tileBytes);
    const tile=inspectEmbeddedTile(tileBytes,{checkpoint:check}),directory=path.posix.dirname(content.uri),stem=path.posix.basename(content.uri,'.b3dm');
    const manifestRelativePath=`${directory}/${stem}.texture-mapping-manifest.json`;
    const descriptor=JSON.parse(await read(outputPath(manifestRelativePath),1024**2));
    need(descriptor.schemaVersion===1&&descriptor.policy==='bounded-texture-mapping-candidate-v1'&&
      descriptor.b3dmIdentity===`${stem}.b3dm`&&descriptor.b3dmSha256===b3dmSha256&&
      descriptor.mappingIdentity===`${stem}.texture-mapping.jsonl`&&relative(descriptor.proofRelativePath)&&
      digest(descriptor.mappingSha256)&&digest(descriptor.proofManifestSha256),'descriptor');
    const mapping=await jsonLines(`${directory}/${descriptor.mappingIdentity}`,descriptor.mappingSha256,5_000_000);
    await matchDeclaredFaces(tile,(async function*(){yield* mapping;})(),{checkpoint:check});
    const proofPath=`${directory}/${descriptor.proofRelativePath}`,atlases=new Map();
    for(const record of await jsonLines(proofPath,descriptor.proofManifestSha256,4096)){
      need(record.schemaVersion===1&&base(record.identity)&&record.identity.endsWith('.png')&&!atlases.has(record.identity)&&
        digest(record.sha256)&&Number.isSafeInteger(record.byteSize)&&record.byteSize>0&&record.byteSize<=2*1024**3&&
        [record.width,record.height].every(value=>Number.isSafeInteger(value)&&value>0&&value<=16384),'atlas_record');
      const relativePath=`${path.posix.dirname(proofPath)}/${record.identity}`,filename=outputPath(relativePath);
      need(await fs.promises.realpath(filename)===filename,'atlas_link');const stat=await fs.promises.lstat(filename,{bigint:true});
      need(stat.isFile()&&stat.size===BigInt(record.byteSize),'atlas_size');tracked.set(filename,stamp(stat));
      atlases.set(record.identity,{...record,relativePath,filename});
    }
    need(atlases.size===tile.images.size&&[...tile.images.keys()].every(name=>atlases.has(name)),'image_closure');
    for(const [name,image] of tile.images){
      check();need(comparedPairs<100000,'pair_budget');const atlas=atlases.get(name);
      const metric=await diagnoseImagePair({image,atlas,decoder,compare:compareAtlasLevelZero,checkpoint:check,
        rows:value=>streamRawAtlasRows({filename:value.filename,sha256:value.sha256,width:value.width,height:value.height,
          signal,checkpoint:check,python:'/usr/bin/python3'})});
      comparedPairs++;lastPair={tile:content.uri,b3dmSha256,manifestRelativePath,imageIdentity:name,
        encodedSha256:image.sha256,rawAtlas:atlas.relativePath,rawSha256:atlas.sha256,metric};
      if(!metric.candidatePass){failure=lastPair;break;}
    }
    if(failure)break;
  }
  for(const [filename,before] of tracked){check();need(await fs.promises.realpath(filename)===filename&&
    stamp(await fs.promises.lstat(filename,{bigint:true}))===before,'changed');}
  const result={schemaVersion:1,scope:'frozen-E-lod0-raw-vs-KTX-level0-diagnostic-only',engineCommit:ENGINE_COMMIT,
    tilesetSha256:sha(tilesetBytes),comparedPairs,failingPair:failure,lastComparedPair:failure?null:lastPair,
    policy:{...TEXTURE_RELATION_POLICY},remainingMipsExamined:false,sourceUvVerified:false,
    wholeConsumerProofVerified:false,candidatePass:false,calibrationRequired:true,ready:false};
  need(Buffer.byteLength(JSON.stringify(result))<=512*1024,'receipt_budget');return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const abort=new AbortController(),stop=()=>abort.abort(new Error('stopped'));
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try{
    need(process.argv.length===4&&process.argv[2]==='--request'&&path.isAbsolute(process.argv[3]),'arguments');
    const fd=await fs.promises.open(process.argv[3],fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)|(fs.constants.O_NONBLOCK||0));let request;
    try{const before=await fd.stat({bigint:true});need(before.isFile()&&before.size>0n&&before.size<=65536n,'request_budget');
      const bytes=Buffer.alloc(Number(before.size));let at=0;
      while(at<bytes.length){abort.signal.throwIfAborted();const got=await fd.read(bytes,at,bytes.length-at,at);
        need(got.bytesRead>0,'request_short_read');at+=got.bytesRead;}
      need(stamp(before)===stamp(await fd.stat({bigint:true})),'request_changed');request=JSON.parse(bytes.toString('utf8'));}
    finally{await fd.close();}
    process.stdout.write(JSON.stringify(await diagnoseRecoveryTextureRelation(request,{signal:abort.signal}))+'\n');
  }catch(error){
    const code=/^(?:texture_diagnostic|lod_texture)_[a-z0-9_]{1,80}$/.test(error?.code||'')?error.code:'texture_diagnostic_failed';
    process.stdout.write(JSON.stringify({schemaVersion:1,error:code,candidatePass:false,ready:false,diagnosticOnly:true})+'\n');process.exitCode=1;
  }finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
}
