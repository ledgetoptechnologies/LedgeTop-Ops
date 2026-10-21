'use strict';
const crypto=require('node:crypto');
const { retainedChunkVerifier } = require('./retainedChunkVerifier');
const fs=require('node:fs');
const path=require('node:path');
const {discoverCameraPhotoLinks}=require('./cameraPhotos');
const {compareUtf8}=require('./processingSecurity');
const {readOdmTaskMetadata}=require('./odmTaskMetadata');
const {CUTLINE_PATTERN,validateCutlineFile}=require('./orthophotoCutline');

const MAX_FILES=100000,MAX_OBJ_BYTES=128*1024*1024,MAX_MTL_BYTES=32*1024*1024,MAX_METADATA_BYTES=8*1024*1024;
const fail=(code,message=code)=>{throw Object.assign(new Error(message),{code});};
const comparePaths=compareUtf8;
const PRIMARY={glb:/(^|\/)(textured_model|model|odm_textured_model_geo)\.glb$/i,obj:/(^|\/)(odm_textured_model_geo|textured_model|model)\.obj$/i,ept:/(^|\/)ept\.json$/i,ortho:/(^|\/)(odm_)?orthophoto[^/]*\.tiff?$/i,dsm:/(^|\/)dsm[^/]*\.tiff?$/i,dtm:/(^|\/)dtm[^/]*\.tiff?$/i,report:/(^|\/)odm_report\/(?:report|odm_report)\.pdf$/i,shots:/(^|\/)shots\.geojson$/i,pointCloud:/(^|\/)(odm_)?georeferenced_model\.(laz|las|ply)$/i};
const TEXTURE_DIRECTIVES=new Set(['map_ka','map_kd','map_ks','map_ns','map_d','map_bump','bump','disp','decal','refl','norm','map_pr','map_pm','map_ps','map_ke']);
const MTL_FIXED_OPTIONS=new Map([['-blendu',1],['-blendv',1],['-boost',1],['-bm',1],['-cc',1],['-clamp',1],['-colorspace',1],['-imfchan',1],['-mm',2],['-texres',1],['-type',1]]),MTL_VECTOR_OPTIONS=new Set(['-o','-s','-t']),MTL_ZERO_OPTIONS=new Set(['-halo']);
function retainProducerLog(inventory,add){
  // Private evidence only: filename or presence alone does not prove units.
  for(const relative of ['log.json','assets/log.json']){
    const file=inventory.byPath.get(relative);
    if(!file)continue;
    if(file.byteSize>MAX_METADATA_BYTES)fail('invalid_retained_source','producer log exceeds the limit');
    add(file,'processing_metadata');
  }
}
function inventoryTree(root,{maxFiles=MAX_FILES}={}){
  const resolvedRoot=fs.realpathSync.native(root),rootIdentity=fs.lstatSync(resolvedRoot,{bigint:true}),files=[];
  if(!rootIdentity.isDirectory()||rootIdentity.isSymbolicLink())fail('invalid_retained_source','retained source root is not a safe directory');
  const walk=(directoryFd,relative='')=>{
    const directoryIdentity=fs.fstatSync(directoryFd,{bigint:true}),directoryPath=`/proc/self/fd/${directoryFd}`;
    for(const entry of fs.readdirSync(directoryPath,{withFileTypes:true}).sort((a,b)=>comparePaths(a.name,b.name))){
      const rel=relative?`${relative}/${entry.name}`:entry.name,childPath=`${directoryPath}/${entry.name}`,stat=fs.lstatSync(childPath,{bigint:true});
      if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile()))fail('invalid_retained_source','retained source contains a symbolic link or special entry');
      if(stat.isDirectory()){
        let childFd;try{childFd=fs.openSync(childPath,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);const opened=fs.fstatSync(childFd,{bigint:true});if(!sameIdentity(stat,opened))fail('source_changed','retained source directory changed during inventory');walk(childFd,rel);}catch(error){if(error?.code==='source_changed'||error?.code==='invalid_retained_source'||error?.code==='too_many_files')throw error;fail('source_changed','retained source directory changed during inventory');}finally{if(childFd!==undefined)fs.closeSync(childFd);}
      }else{
        if(stat.size>BigInt(Number.MAX_SAFE_INTEGER))fail('invalid_retained_source','retained source file exceeds the safe size limit');
        files.push({relativePath:rel,absolutePath:path.join(resolvedRoot,...rel.split('/')),byteSize:Number(stat.size),identity:stat});
      }
      if(files.length>maxFiles)fail('too_many_files','retained source contains too many files');
    }
    if(!sameIdentity(directoryIdentity,fs.fstatSync(directoryFd,{bigint:true})))fail('source_changed','retained source directory changed during inventory');
  };
  let rootFd;try{rootFd=fs.openSync(resolvedRoot,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);if(!sameIdentity(rootIdentity,fs.fstatSync(rootFd,{bigint:true})))fail('source_changed','retained source root changed before inventory');walk(rootFd);}catch(error){if(error?.code==='source_changed'||error?.code==='invalid_retained_source'||error?.code==='too_many_files')throw error;fail('source_changed','retained source root changed during inventory');}finally{if(rootFd!==undefined)fs.closeSync(rootFd);}
  if(!sameIdentity(rootIdentity,fs.lstatSync(resolvedRoot,{bigint:true})))fail('source_changed','retained source root changed during inventory');
  files.sort((a,b)=>comparePaths(a.relativePath,b.relativePath));const byPath=new Map(files.map(file=>[file.relativePath,file])),byLower=new Map();for(const file of files){const key=file.relativePath.toLowerCase(),rows=byLower.get(key)||[];rows.push(file);byLower.set(key,rows);}return{root:resolvedRoot,rootIdentity,files,byPath,byLower};
}
function uniquePrimary(inventory,kind,required=false){const matches=inventory.files.filter(file=>!disposablePath(file)&&!legacyStreamingPath(file)&&PRIMARY[kind].test(file.relativePath));if(matches.length>1)fail('retained_product_ambiguous',`multiple ${kind} products are ambiguous`);if(required&&!matches.length)fail('retained_dependency_missing',`required ${kind} product is missing`);return matches[0]||null;}
function referencePath(baseDirectory,reference){const raw=String(reference||'').trim();if(!raw||raw.includes('\0')||raw.includes('\\')||raw.startsWith('/')||/^[A-Za-z]:/.test(raw)||/^[a-z][a-z0-9+.-]*:/i.test(raw))fail('retained_dependency_unsafe','dependency path is unsafe');const stack=baseDirectory==='.'?[]:baseDirectory.split('/');for(const segment of raw.split('/')){if(!segment||segment==='.')continue;if(segment==='..'){if(!stack.length)fail('retained_dependency_unsafe','dependency escapes the extracted root');stack.pop();}else stack.push(segment);}if(!stack.length)fail('retained_dependency_unsafe','dependency path is empty');return stack.join('/');}
function probeReference(inventory,baseDirectory,reference){let relativePath;try{relativePath=referencePath(baseDirectory,reference);}catch(error){return{status:'unsafe',error};}const exact=inventory.byPath.get(relativePath);if(exact)return{status:'exact',file:exact};const folded=inventory.byLower.get(relativePath.toLowerCase())||[];if(folded.length===1)return{status:'case',file:folded[0]};if(folded.length>1)return{status:'ambiguous'};return{status:'missing',relativePath};}
function requireReference(inventory,baseDirectory,reference){const found=probeReference(inventory,baseDirectory,reference);if(found.status==='exact')return found.file;if(found.status==='case')fail('retained_dependency_case_mismatch',`dependency case does not match ${found.file.relativePath}`);if(found.status==='unsafe')throw found.error;if(found.status==='ambiguous')fail('retained_dependency_ambiguous','dependency path is ambiguous');fail('retained_dependency_missing',`dependency is missing: ${found.relativePath||reference}`);}
function tokenize(value){const tokens=[];let current='',quote=null;for(const character of String(value)){if(quote){if(character===quote){quote=null;continue;}current+=character;continue;}if(character==='"'||character==="'"){quote=character;continue;}if(/\s/.test(character)){if(current){tokens.push(current);current='';}continue;}current+=character;}if(quote)fail('retained_dependency_unsafe','dependency contains an unterminated quote');if(current)tokens.push(current);return tokens;}
function mtlTextureReference(tokens,source){let index=0;const numeric=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;while(index<tokens.length&&tokens[index].startsWith('-')){const option=tokens[index].toLowerCase();if(MTL_ZERO_OPTIONS.has(option)){index+=1;continue;}if(MTL_VECTOR_OPTIONS.has(option)){index+=1;let count=0;while(index<tokens.length&&count<3&&numeric.test(tokens[index])){index+=1;count+=1;}if(!count)fail('retained_dependency_unsafe',`MTL option ${option} is missing its value in ${source}`);continue;}const arity=MTL_FIXED_OPTIONS.get(option);if(arity===undefined)fail('retained_dependency_unsafe',`unsupported MTL texture option ${option} in ${source}`);if(index+arity>=tokens.length)fail('retained_dependency_unsafe',`MTL option ${option} is incomplete in ${source}`);index+=arity+1;}if(index>=tokens.length)fail('retained_dependency_missing',`MTL texture dependency is missing in ${source}`);return tokens.slice(index).join(' ');}
function stripComment(line){let quote=null;for(let index=0;index<line.length;index+=1){const character=line[index];if(quote){if(character===quote)quote=null;continue;}if(character==='"'||character==="'")quote=character;else if(character==='#')return line.slice(0,index);}return line;}
function readText(file,maxBytes){if(file.byteSize>maxBytes)fail('invalid_retained_source',`${file.relativePath} exceeds the parser limit`);const before=fs.lstatSync(file.absolutePath,{bigint:true});if(!before.isFile()||!sameIdentity(file.identity,before)||before.size!==BigInt(file.byteSize))fail('source_changed','retained dependency changed before parsing');let fd;try{fd=fs.openSync(file.absolutePath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);const opened=fs.fstatSync(fd,{bigint:true});if(!sameIdentity(before,opened))fail('source_changed','retained dependency changed before parsing');const buffer=Buffer.alloc(file.byteSize);let position=0;while(position<buffer.length){const count=fs.readSync(fd,buffer,position,buffer.length-position,position);if(count<=0)fail('source_changed','retained dependency was truncated during parsing');position+=count;}if(!sameIdentity(opened,fs.fstatSync(fd,{bigint:true})))fail('source_changed','retained dependency changed during parsing');file.parsedSha256=crypto.createHash('sha256').update(buffer).digest('hex');return buffer.toString('utf8');}finally{if(fd!==undefined)fs.closeSync(fd);}}
function objMaterialDependencies(inventory,obj){const base=path.posix.dirname(obj.relativePath),dependencies=[];for(const rawLine of readText(obj,MAX_OBJ_BYTES).split(/\r?\n/)){const line=stripComment(rawLine).trim(),match=line.match(/^mtllib\s+(.+)$/i);if(!match)continue;const args=match[1].trim(),unquoted=args.match(/^(["'])(.*)\1$/)?.[2];if(unquoted!==undefined){dependencies.push(requireReference(inventory,base,unquoted));continue;}const whole=probeReference(inventory,base,args);if(whole.status==='exact'){dependencies.push(whole.file);continue;}if(whole.status==='case')fail('retained_dependency_case_mismatch',`dependency case does not match ${whole.file.relativePath}`);if(whole.status==='unsafe')throw whole.error;const tokens=tokenize(args);if(!tokens.length)fail('retained_dependency_missing','OBJ mtllib is empty');for(const token of tokens)dependencies.push(requireReference(inventory,base,token));}return[...new Map(dependencies.map(file=>[file.relativePath,file])).values()];}
function mtlTextureDependencies(inventory,mtl){const base=path.posix.dirname(mtl.relativePath),dependencies=[];for(const rawLine of readText(mtl,MAX_MTL_BYTES).split(/\r?\n/)){const line=stripComment(rawLine).trim(),match=line.match(/^(\S+)\s+(.+)$/);if(!match||!TEXTURE_DIRECTIVES.has(match[1].toLowerCase()))continue;const reference=mtlTextureReference(tokenize(match[2].trim()),mtl.relativePath);dependencies.push(requireReference(inventory,base,reference));}return[...new Map(dependencies.map(file=>[file.relativePath,file])).values()];}
function sourcePhoto(file){const lower=file.relativePath.toLowerCase(),segments=lower.split('/'),extension=/\.(?:jpe?g|png|tiff?|dng|raw|heic)$/i.test(lower),allowed=segments.length===1||segments[0]==='images';return extension&&allowed&&!segments.some(segment=>/(?:^|[-_.])(thumb|thumbnail|preview|cache|temp)(?:[-_.]|$)/i.test(segment));}
function disposablePath(file){const segments=String(file.relativePath||'').toLowerCase().split('/'),directories=new Set(['cache','caches','data','log','logs','preview','previews','temp','temporary','tmp','thumbnail','thumbnails']);if(segments.slice(0,-1).some(segment=>directories.has(segment)))return true;const basename=segments.at(-1)||'';return/(?:^|[-_.])(cache|preview|temp|temporary|thumb|thumbnail)(?:[-_.]|$)/.test(basename);}
function legacyStreamingPath(file){return String(file.relativePath||'').toLowerCase().split('/').slice(0,-1).some(segment=>['3d_tiles','3d-tiles','3dtiles'].includes(segment)||segment.startsWith('tiles-ktx2-'));}
function validBounds(value){return Array.isArray(value)&&value.length===6&&value.every(Number.isFinite)&&value[0]<=value[3]&&value[1]<=value[4]&&value[2]<=value[5];}
function validEptDocument(document){if(!document||typeof document!=='object'||Array.isArray(document)||typeof document.version!=='string'||!/^\d+\.\d+(?:\.\d+)?$/.test(document.version)||!validBounds(document.bounds)||(document.boundsConforming!==undefined&&!validBounds(document.boundsConforming))||!['binary','laszip','zstandard'].includes(document.dataType)||document.hierarchyType!=='json'||!Number.isSafeInteger(document.points)||document.points<0||!Number.isSafeInteger(document.span)||document.span<1||!Array.isArray(document.schema)||document.schema.length<3||document.schema.length>256)return false;const names=new Set();for(const dimension of document.schema){if(!dimension||typeof dimension!=='object'||typeof dimension.name!=='string'||!dimension.name||dimension.name.length>64||names.has(dimension.name)||!['signed','unsigned','float'].includes(dimension.type)||![1,2,4,8].includes(dimension.size))return false;names.add(dimension.name);}return names.has('X')&&names.has('Y')&&names.has('Z');}
function eptClosure(inventory,ept){let document;try{document=JSON.parse(readText(ept,MAX_METADATA_BYTES));}catch(error){if(error?.code==='source_changed')throw error;return null;}if(!validEptDocument(document))return null;const parent=path.posix.dirname(ept.relativePath),prefix=(name)=>parent==='.'?`${name}/`:`${parent}/${name}/`,data=inventory.files.filter(file=>file.relativePath.startsWith(prefix('ept-data'))&&!disposablePath(file)),hierarchy=inventory.files.filter(file=>file.relativePath.startsWith(prefix('ept-hierarchy'))&&!disposablePath(file)),sources=inventory.files.filter(file=>file.relativePath.startsWith(prefix('ept-sources'))&&!disposablePath(file));if(document.points===0)return[ept];if(!data.length||!hierarchy.length)return null;return[ept,...data,...hierarchy,...sources].sort((left,right)=>comparePaths(left.relativePath,right.relativePath));}
function sameIdentity(left,right){return left.dev===right.dev&&left.ino===right.ino&&left.mode===right.mode&&left.size===right.size&&left.ctimeNs===right.ctimeNs&&left.mtimeNs===right.mtimeNs;}
async function hashSelectedFile(file,{signal=null}={}){const before=fs.lstatSync(file.absolutePath,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.size>BigInt(Number.MAX_SAFE_INTEGER))fail('invalid_retained_source','retained file is not a safe regular file');if(!sameIdentity(file.identity,before)||before.size!==BigInt(file.byteSize))fail('source_changed','retained file changed before hashing');let fd;try{fd=fs.openSync(file.absolutePath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);}catch{fail('invalid_retained_source','retained file cannot be opened safely');}try{const opened=fs.fstatSync(fd,{bigint:true});if(!sameIdentity(before,opened))fail('source_changed','retained source changed before hashing');const chunkProof=retainedChunkVerifier(file.chunks,file.byteSize),hash=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024),size=Number(opened.size);let position=0;while(position<size){if(signal?.aborted)fail('lease_lost','retained manifest hashing cancelled');const count=await new Promise((resolve,reject)=>fs.read(fd,buffer,0,Math.min(buffer.length,size-position),position,(error,bytes)=>error?reject(error):resolve(bytes)));if(count<=0)fail('source_changed','retained source changed while hashing');hash.update(buffer.subarray(0,count));chunkProof.update(buffer.subarray(0,count));position+=count;}if(!sameIdentity(opened,fs.fstatSync(fd,{bigint:true})))fail('source_changed','retained source changed while hashing');chunkProof.finish();const digest=hash.digest('hex');if(file.parsedSha256&&file.parsedSha256!==digest)fail('source_changed','retained dependency changed after parsing');return digest;}finally{fs.closeSync(fd);}}
async function buildRetainedManifest(root,{signal=null,policy={orthophoto:true,dsm:true,dtm:true,report:true}}={}){const inventory=inventoryTree(root),selected=new Map(),add=(file,role)=>{if(!file)return;const existing=selected.get(file.relativePath);if(existing&&existing.role!==role){if(existing.role==='source_photo')selected.set(file.relativePath,{file,role});else if(role!=='source_photo')fail('retained_role_conflict',`${file.relativePath} has conflicting retained roles`);return;}selected.set(file.relativePath,{file,role});};retainProducerLog(inventory,add);for(const file of inventory.files)if(sourcePhoto(file))add(file,'source_photo');const cameraFiles=inventory.files.filter(file=>!disposablePath(file)&&/(^|\/)(shots\.geojson|cameras\.json|images\.json)$/i.test(file.relativePath));if(cameraFiles.filter(file=>/(^|\/)shots\.geojson$/i.test(file.relativePath)).length>1)fail('retained_product_ambiguous','multiple camera-position sources are ambiguous');for(const file of cameraFiles)add(file,'camera_positions');const glb=uniquePrimary(inventory,'glb'),obj=uniquePrimary(inventory,'obj');add(glb,'mesh_glb');if(obj){add(obj,'mesh_obj');for(const mtl of objMaterialDependencies(inventory,obj)){add(mtl,'mesh_mtl');for(const texture of mtlTextureDependencies(inventory,mtl))add(texture,'mesh_texture');}}for(const file of inventory.files)if(!disposablePath(file)&&/(^|\/)odm_georeferencing\/(?:proj\.txt|odm_georeferencing_model_geo\.txt|coords\.txt|[^/]+\.(?:summary|info)\.json)$/i.test(file.relativePath)){if(file.byteSize>MAX_METADATA_BYTES)fail('invalid_retained_source','georeference metadata exceeds the limit');add(file,'georeference');}for(const file of inventory.files)if(!disposablePath(file)&&/(^|\/)odm_report\/stats\.json$/i.test(file.relativePath)){if(file.byteSize>MAX_METADATA_BYTES)fail('invalid_retained_source','processing metadata exceeds the limit');add(file,'processing_metadata');}const ept=uniquePrimary(inventory,'ept'),retainedEpt=ept?eptClosure(inventory,ept):null;if(retainedEpt){for(const file of retainedEpt)add(file,'ept');}else{const pointCandidates=inventory.files.filter(file=>!disposablePath(file)&&PRIMARY.pointCloud.test(file.relativePath)),usable=pointCandidates.filter(file=>/\.(?:la[sz])$/i.test(file.relativePath));if(usable.length>1)fail('retained_product_ambiguous','multiple point-cloud sources are ambiguous');if(usable.length)add(usable[0],'point_cloud_source');else if(pointCandidates.some(file=>/\.ply$/i.test(file.relativePath)))fail('unsupported_pointcloud_source','PLY cannot generate retained EPT');}if(policy.orthophoto){add(uniquePrimary(inventory,'ortho'),'orthophoto');for(const file of inventory.files)if(!disposablePath(file)&&CUTLINE_PATTERN.test(file.relativePath)&&validateCutlineFile(file))add(file,'orthophoto_cutline');}if(policy.dsm)add(uniquePrimary(inventory,'dsm'),'dsm');if(policy.dtm)add(uniquePrimary(inventory,'dtm'),'dtm');if(policy.report)add(uniquePrimary(inventory,'report'),'report');const files=[];for(const {file,role} of [...selected.values()].sort((a,b)=>comparePaths(a.file.relativePath,b.file.relativePath))){const sha256=await hashSelectedFile(file,{signal});files.push({relativePath:file.relativePath,sourceRelativePath:file.relativePath,role,byteSize:file.byteSize,sha256});}const manifestSha256=crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex'),shots=files.find(file=>file.role==='camera_positions'&&/(^|\/)shots\.geojson$/i.test(file.sourceRelativePath)),photos=files.filter(file=>sourcePhoto(inventory.byPath.get(file.sourceRelativePath))),cameraPhotos=shots?discoverCameraPhotoLinks(inventory.root,{assets:[{kind:'shots',relativePath:shots.sourceRelativePath,byteSize:shots.byteSize,sha256:shots.sha256}],files:photos.map(file=>({relativePath:file.sourceRelativePath,byteSize:file.byteSize,sha256:file.sha256}))}):[];return{files,manifestSha256,cameraPhotos,metadata:readOdmTaskMetadata(inventory.root),sourceRootPath:inventory.root,sourceRootIdentity:inventory.rootIdentity};}
async function buildMeshRecoveryManifest(root,{signal=null}={}){
  const inventory=inventoryTree(root);
  // Recovery owns this reserved product namespace. Copied tile payloads may
  // themselves be named model.glb and must not shadow the original audit GLB.
  inventory.files=inventory.files.filter(file=>!file.relativePath.startsWith('recovery-companions/'));
  const obj=uniquePrimary(inventory,'obj',true),glb=uniquePrimary(inventory,'glb',true),selected=new Map();
  const add=(file,role)=>selected.set(file.relativePath,{file,role});
  add(glb,'mesh_glb');add(obj,'mesh_obj');
  for(const mtl of objMaterialDependencies(inventory,obj)){
    add(mtl,'mesh_mtl');
    for(const texture of mtlTextureDependencies(inventory,mtl))add(texture,'mesh_texture');
  }
  const files=[];
  for(const {file,role} of [...selected.values()].sort((a,b)=>comparePaths(a.file.relativePath,b.file.relativePath))){
    const sha256=await hashSelectedFile(file,{signal});
    files.push({relativePath:file.relativePath,sourceRelativePath:file.relativePath,role,byteSize:file.byteSize,sha256});
  }
  const manifestSha256=crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return{files,manifestSha256,sourceRootPath:inventory.root,sourceRootIdentity:inventory.rootIdentity};
}
// Verify only the caller's registered closure. Unlike inventoryTree this must
// not discover or authorize additional files next to a registered product.
async function verifyRetainedClosure(root, files, { signal = null } = {}) {
  if (!Array.isArray(files) || files.length > MAX_FILES) fail('too_many_files');
  const rootPath = fs.realpathSync.native(root), rootIdentity = fs.lstatSync(rootPath, { bigint: true });
  let rootFd;
  try {
    rootFd = fs.openSync(rootPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC);
    if (!sameIdentity(rootIdentity, fs.fstatSync(rootFd, { bigint: true }))) fail('source_changed');
    for (const file of files) {
      const raw = file.sourceRelativePath;
      if (typeof raw !== 'string' || !raw || raw.includes('\\') || raw.includes('\0') || raw.includes(':')
        || raw.split('/').some(segment => !segment || segment === '.' || segment === '..')) fail('retained_dependency_unsafe');
      const segments = raw.split('/'), name = segments.pop(), held = [];
      let directoryFd = rootFd;
      try {
        for (const segment of segments) {
          const child = `/proc/self/fd/${directoryFd}/${segment}`, before = fs.lstatSync(child, { bigint: true });
          if (!before.isDirectory() || before.isSymbolicLink()) fail('invalid_retained_source');
          const fd = fs.openSync(child, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC);
          held.push({ fd, identity: before });
          if (!sameIdentity(before, fs.fstatSync(fd, { bigint: true }))) fail('source_changed');
          directoryFd = fd;
        }
        const absolutePath = `/proc/self/fd/${directoryFd}/${name}`, identity = fs.lstatSync(absolutePath, { bigint: true });
        const actual = await hashSelectedFile({ absolutePath, identity, byteSize: file.byteSize, chunks: file.chunks }, { signal });
        if (actual !== file.sha256) fail('source_changed', 'registered retained file changed');
        for (const heldDirectory of held) if (!sameIdentity(heldDirectory.identity, fs.fstatSync(heldDirectory.fd, { bigint: true }))) fail('source_changed');
      } finally {
        for (const heldDirectory of held.reverse()) fs.closeSync(heldDirectory.fd);
      }
    }
    if (!sameIdentity(rootIdentity, fs.fstatSync(rootFd, { bigint: true }))) fail('source_changed');
  } finally { if (rootFd !== undefined) fs.closeSync(rootFd); }
}
// Whole-output supersession is stricter than import retention: no disposable
// path filter is allowed because an unknown original must block retirement.
async function buildStorageSupersessionManifest(root,{signal=null}={}) {
  const inventory=inventoryTree(root),files=[];
  for(const file of inventory.files) files.push({relativePath:file.relativePath,sourceRelativePath:file.relativePath,byteSize:file.byteSize,sha256:await hashSelectedFile(file,{signal})});
  return{files,manifestSha256:crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex'),inventoryIdentitySha256:storageSupersessionInventoryIdentity(inventory)};
}
function storageSupersessionInventoryIdentity(inventory){
  const identity=stat=>['dev','ino','mode','size','ctimeNs','mtimeNs'].map(key=>String(stat[key]));
  return crypto.createHash('sha256').update(JSON.stringify({root:identity(inventory.rootIdentity),files:inventory.files.map(file=>[file.relativePath,...identity(file.identity)])})).digest('hex');
}
module.exports={MAX_FILES,buildRetainedManifest,buildMeshRecoveryManifest,inventoryTree,verifyRetainedClosure,buildStorageSupersessionManifest,storageSupersessionInventoryIdentity};
