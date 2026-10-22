'use strict';

const crypto=require('node:crypto');
const path=require('node:path');
const {buildMeshRecoveryManifest}=require('./retainedManifest');
const {verifyRecoveryCompanionPlan}=require('./lodRecoveryCompanions');

const POLICY_REVISION=2;
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inside=(value,root)=>value.startsWith(`${root}/`);
const same=(left,right)=>left?.byteSize===right?.byteSize&&left?.sha256===right?.sha256;

function recoveryRegistrationIdentity(database,sourceId,targetId){
  const versions=[sourceId,targetId].map(id=>{
    const assets=database.prepare('SELECT * FROM model_assets WHERE version_id=? ORDER BY id').all(id).map(asset=>({...asset,
      files:database.prepare('SELECT * FROM model_asset_files WHERE asset_id=? ORDER BY relative_path').all(asset.id),
      chunks:database.prepare('SELECT * FROM model_asset_chunks WHERE asset_id=? ORDER BY relative_path,chunk_index').all(asset.id)}));
    return{id,assets,photos:database.prepare('SELECT * FROM model_camera_photos WHERE version_id=? ORDER BY filename').all(id)};
  });
  return digest(versions);
}

// Recovery deliberately relocates independent products into separate namespaces.
// Only the persisted, server-created copy plan can authorize that relocation.
// Matching arbitrary basenames/hashes would silently break relative references.
async function recoveryPreservation(database,payload,source,target,sourceProof,targetProof,sourceRoot,{signal=null}={}){
  const registrationSha256=recoveryRegistrationIdentity(database,source.id,target.id);
  const sourceFiles=new Map(sourceProof.files.map(file=>[file.relativePath,file]));
  const targetFiles=new Map(targetProof.files.map(file=>[file.relativePath,file]));
  const mapped=new Map(),destinations=new Map(),groups=[];
  const reject=(proofFailureReason,details={})=>({preserved:false,details:{proofFailureReason,...details}});
  const add=(from,to,expected,group)=>{
    if(!sourceFiles.has(from)||!same(sourceFiles.get(from),expected)||!same(targetFiles.get(to),expected))return false;
    const previous=mapped.get(from),owner=destinations.get(to);
    if(previous&&(previous.to!==to||previous.group!==group)||owner&&owner!==from)return false;
    mapped.set(from,{to,group,byteSize:expected.byteSize,sha256:expected.sha256});destinations.set(to,from);return true;
  };
  if(payload.targetRelativePath!==target.relativePath)return reject('recovery_destination_unbound');
  const plans=[['companions',payload.companions],['reused_tiles',payload.reusedTiles]];
  for(const [name,plan] of plans){
    if(!plan||plan.sourceVersionId!==source.id)continue;
    // Rebuild from registered roots, manifests, chunk hashes and photo metadata;
    // the exact snapshot must still match the authorized recovery plan.
    try{verifyRecoveryCompanionPlan(database,source.id,plan,{meshTilesOnly:name==='reused_tiles'});}
    catch{return reject('recovery_companion_manifest_changed');}
    for(const asset of plan.assets){
      const registered=database.prepare('SELECT * FROM model_assets WHERE version_id=? AND kind=?').get(target.id,asset.kind);
      if(!registered||registered.root_key!=='models'||registered.relative_path!==`${target.relativePath}/${asset.relativePath}`
        ||registered.byte_size!==asset.byteSize||registered.sha256!==asset.sha256
        ||(asset.manifestFiles.length&&registered.manifest_sha256!==asset.manifestSha256))return reject('recovery_product_registration_changed',{artifactKind:asset.kind});
      const registeredMembers=database.prepare('SELECT relative_path AS relativePath,byte_size AS byteSize,sha256 FROM model_asset_files WHERE asset_id=? ORDER BY relative_path').all(registered.id);
      const expectedMembers=asset.manifestFiles.map(({relativePath,byteSize,sha256})=>({relativePath,byteSize,sha256}));
      if(JSON.stringify(registeredMembers)!==JSON.stringify(expectedMembers))return reject('recovery_product_registration_changed',{artifactKind:asset.kind});
      for(const member of asset.manifestFiles.length?asset.manifestFiles:[{relativePath:'',chunks:asset.chunks}]){
        const chunks=database.prepare('SELECT chunk_index AS chunkIndex,byte_offset AS byteOffset,byte_size AS byteSize,sha256 FROM model_asset_chunks WHERE asset_id=? AND relative_path=? ORDER BY chunk_index').all(registered.id,member.relativePath);
        if(JSON.stringify(chunks)!==JSON.stringify(member.chunks||[]))return reject('recovery_product_registration_changed',{artifactKind:asset.kind});
      }
    }
    for(const photo of plan.cameraPhotos){
      const registered=database.prepare('SELECT * FROM model_camera_photos WHERE version_id=? AND filename=?').get(target.id,photo.filename);
      if(!registered||registered.root_key!=='models'||registered.relative_path!==`${target.relativePath}/${photo.relativePath}`
        ||registered.byte_size!==photo.byteSize||registered.sha256!==photo.sha256)return reject('recovery_photo_registration_changed');
    }
    for(const file of plan.files){
      // A companion may live in a dataset rather than this output. It is not
      // part of the deletion candidate and cannot authorize a local lookalike.
      if(file.rootKey!=='models'||!inside(file.sourceRelativePath,source.relativePath))continue;
      const from=file.sourceRelativePath.slice(source.relativePath.length+1);
      if(!add(from,file.relativePath,file,`${name}:${file.role}`))return reject('recovery_mapped_file_changed',{artifactKind:file.role});
    }
    groups.push({kind:name,manifestSha256:plan.manifestSha256});
  }

  // The raw OBJ / MTL / texture closure is copied without relocation. Discover
  // its actual references securely instead of treating all same-path files as
  // independent products. This also handles the companion source of a repair.
  if(sourceProof.files.some(file=>/\.obj$/i.test(file.relativePath))){
    let mesh;
    try{mesh=await buildMeshRecoveryManifest(sourceRoot,{signal});}
    catch(error){if(signal?.aborted)throw error;return reject('mesh_dependency_closure_unproven');}
    for(const file of mesh.files){
      if(!add(file.relativePath,file.relativePath,file,'mesh'))return reject('mesh_dependency_not_preserved',{artifactKind:file.role});
    }
    for(const role of ['mesh_obj','mesh_glb']){
      const file=mesh.files.find(file=>file.role===role),kind=role==='mesh_obj'?'obj':'glb';
      const registered=database.prepare('SELECT * FROM model_assets WHERE version_id=? AND kind=?').get(target.id,kind);
      if(!file||!registered||registered.root_key!=='models'||registered.relative_path!==`${target.relativePath}/${file.relativePath}`
        ||registered.byte_size!==file.byteSize||registered.sha256!==file.sha256)return reject('recovery_mesh_registration_changed',{artifactKind:kind});
    }
    groups.push({kind:'mesh',manifestSha256:mesh.manifestSha256});
  }

  const unmapped=sourceProof.files.filter(file=>!mapped.has(file.relativePath));
  if(unmapped.length){
    const extensions={};for(const file of unmapped){const extension=path.posix.extname(file.relativePath).toLowerCase()||'(none)';extensions[extension]=(extensions[extension]||0)+1;}
    return reject('unmapped_source_files',{unmappedFileCount:unmapped.length,unmappedByteSize:unmapped.reduce((sum,file)=>sum+file.byteSize,0),unmappedExtensions:extensions});
  }
  if(!mapped.size)return reject('empty_source');
  const mappings=[...mapped].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([from,value])=>({from,...value}));
  return{preserved:true,method:'registered_recovery_groups',registrationSha256,preservationSha256:digest({revision:POLICY_REVISION,groups,mappings}),details:{preservedFileCount:mapped.size,preservationGroupCount:groups.length}};
}

module.exports={POLICY_REVISION,recoveryPreservation,recoveryRegistrationIdentity};
