'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),test=require('node:test'),{spawnSync}=require('node:child_process');
const{lodDerivativeSpecs,verifiedLodProvenance}=require('../server/lodDerivativePolicy');
const{CONTROLLED_CONVERTER,CONTROLLED_CONVERTER_COMMAND_SHA256,SERIAL_RETRY_CONVERTER,SERIAL_RETRY_CONVERTER_COMMAND_SHA256,obj2TilesArguments}=require('../lod-converter-policy.cjs');
test('native tiles are audited at their storage root',()=>{assert.deepEqual(lodDerivativeSpecs([{kind:'tiles',rootKey:'datasets',relativePath:'import/3d_tiles/model/tileset.json'},{kind:'glb',rootKey:'datasets',relativePath:'import/model.glb'},{kind:'obj',rootKey:'datasets',relativePath:'import/model.obj'}],{meshDerivativesEnabled:true}),[{type:'lod_audit',request:{tilesRootKey:'datasets',tilesRelativePath:'import/3d_tiles/model',optional:true}}]);});
test('native tile audits remain active while automatic generation is disabled',()=>{assert.deepEqual(lodDerivativeSpecs([{kind:'tiles',rootKey:'datasets',relativePath:'import/3d_tiles/model/tileset.json'},{kind:'glb',rootKey:'datasets',relativePath:'import/model.glb'},{kind:'obj',rootKey:'datasets',relativePath:'import/model.obj'}],{meshDerivativesEnabled:false}),[{type:'lod_audit',request:{tilesRootKey:'datasets',tilesRelativePath:'import/3d_tiles/model',optional:true}}]);});
test('missing tiles queue Obj2Tiles only with OBJ plus an auditable GLB fallback',()=>{assert.deepEqual(lodDerivativeSpecs([{kind:'obj',relativePath:'model.obj'},{kind:'glb',relativePath:'model.glb'}],{meshDerivativesEnabled:true}),[{type:'mesh_tiles',request:{optional:true}}]);assert.deepEqual(lodDerivativeSpecs([{kind:'obj',relativePath:'model.obj'}],{meshDerivativesEnabled:true}),[]);assert.deepEqual(lodDerivativeSpecs([{kind:'glb',relativePath:'model.glb'}],{meshDerivativesEnabled:true}),[]);assert.deepEqual(lodDerivativeSpecs([{kind:'obj',relativePath:'model.obj'},{kind:'glb',relativePath:'model.glb'}],{meshDerivativesEnabled:false}),[]);});
test('new processing and import work can require a verified streaming mesh before readiness',()=>{const textured=[{kind:'obj',relativePath:'model.obj'},{kind:'glb',relativePath:'model.glb'}],withLegacyTiles=[{kind:'tiles',rootKey:'datasets',relativePath:'import/tileset.json'},...textured],required=[{type:'mesh_tiles',request:{optional:false}}];assert.deepEqual(lodDerivativeSpecs(textured,{meshDerivativesEnabled:true,required:true}),required);assert.deepEqual(lodDerivativeSpecs(withLegacyTiles,{meshDerivativesEnabled:true,required:true}),required);assert.deepEqual(lodDerivativeSpecs(textured,{meshDerivativesEnabled:false,required:true}),required);assert.deepEqual(lodDerivativeSpecs(withLegacyTiles,{meshDerivativesEnabled:false,required:true}),required);});
test('NodeODM ingest holds readiness until its streaming mesh verifies',()=>{const source=fs.readFileSync(path.join(__dirname,'..','server','processingWorker.js'),'utf8');assert.match(source,/lodDerivativeSpecs\(\[[\s\S]*meshDerivativesEnabled:\s*config\.meshDerivativesEnabled,[\s\S]*required:\s*true/);});
test('TrueNAS derivative work is server-side and leaves capacity for production services',()=>{const compose=fs.readFileSync(path.join(__dirname,'..','docker-compose.yml'),'utf8');assert.match(compose,/viewer-worker:[\s\S]*cpus:\s*"16\.0"/);assert.match(compose,/viewer-worker:[\s\S]*mem_limit:\s*24g/);assert.doesNotMatch(compose,/VIEWER_WORKER_CPUS|VIEWER_WORKER_MEMORY/);assert.match(compose,/source:\s*\/mnt\/Plugins\/App_Data\/Model-Viewer\/Storage[\s\S]*target:\s*\/app\/storage/);});
test('generated KTX2 trees use a versioned atomic switch and report retained storage',()=>{const source=fs.readFileSync(path.join(__dirname,'..','server','derivativeWorker.js'),'utf8');assert.match(source,/tiles-ktx2-etc1s-\$\{job\.id\}/);assert.match(source,/registerVerifiedLodAsset[\s\S]*retainedBytes/);assert.match(source,/previousTiles/);});
test('native tiles without a GLB audit source do not queue work and remain in private storage only',()=>{assert.deepEqual(lodDerivativeSpecs([{kind:'tiles',rootKey:'datasets',relativePath:'import/3d_tiles/model/tileset.json'},{kind:'obj',rootKey:'datasets',relativePath:'import/model.obj'}],{meshDerivativesEnabled:true}),[]);});
test('server derivative eligibility accepts verified controlled v4 summaries while retaining v3',()=>{
  const assets=[{kind:'tiles',relativePath:'tiles/tileset.json',manifestSha256:'c'.repeat(64)},{kind:'glb',relativePath:'model.glb',sha256:'a'.repeat(64)},{kind:'obj',relativePath:'model.obj',sha256:'b'.repeat(64)}];
  const base={sourceAsset:'model.glb',sourceSha256:'a'.repeat(64),tilesManifestSha256:'c'.repeat(64),geometry:'controlled-bidirectional-surface-equivalence',textures:'controlled-atlas-material-equivalence',leafGeometricError:0,converter:{name:'OpenDroneMap/Obj2Tiles',version:'1.6.2',commandSha256:'7d82c354b3d65985e602454c0bcc204fe8e75d8efc1826b76a5681d85c34f681',inputAsset:'model.obj',inputSha256:'b'.repeat(64),binarySha256:'40adc90db9f019d1d976badc1733a5acc69d43cd1db34bf0ebc823f554188274'},audit:{artifactCount:2}};
  const v3={...base,schemaVersion:3,audit:{...base.audit,algorithm:'ltds-obj2tiles-surface-equivalence-v3'}};
  const v4={...base,schemaVersion:4,audit:{...base.audit,algorithm:'ltds-obj2tiles-surface-equivalence-v4',policyRevision:'ltds-controlled-surface-policy-v4'}};
  assert.equal(verifiedLodProvenance({lodProvenance:v3},assets),v3);
  assert.equal(verifiedLodProvenance({lodProvenance:v4},assets),v4);
  for(const commandSha256 of[CONTROLLED_CONVERTER_COMMAND_SHA256,SERIAL_RETRY_CONVERTER_COMMAND_SHA256]){
    const current={...v4,converter:{...v4.converter,commandSha256}};
    assert.equal(verifiedLodProvenance({lodProvenance:current},assets),current,'the server authority accepts every current controlled execution contract');
  }
  assert.equal(verifiedLodProvenance({lodProvenance:{...v4,audit:{...v4.audit,policyRevision:'other'}}},assets),null);
});
test('runtime builds the pinned Obj2Tiles fork and invokes its bounded texture-atlas contracts',()=>{
  const root=path.resolve(__dirname,'..'),docker=fs.readFileSync(path.join(root,'Dockerfile'),'utf8'),worker=fs.readFileSync(path.join(root,'server','derivativeWorker.js'),'utf8'),compose=fs.readFileSync(path.join(root,'docker-compose.yml'),'utf8'),config=fs.readFileSync(path.join(root,'server','config.js'),'utf8');
  assert.match(docker,/OBJ2TILES_VERSION=1\.6\.2/);
  assert.match(docker,/79093e12f6eab2cfcd522aebe670892c5d8874e160956b84f3e55c77b94ac0b5/);
  assert.match(docker,/6d5d99ea1d1e36208e44d0456d35cb0d8c68092dfd4a6ad01288bf85bb67322b/);
  assert.match(docker,/build-info\.json/);
  assert.doesNotMatch(docker,/PublishTrimmed=true/);
  assert.match(docker,/ENV OBJ2TILES_BIN=\/opt\/obj2tiles\/Obj2Tiles/);
  assert.match(compose,/MESH_DERIVATIVES_ENABLED:\s*\$\{MESH_DERIVATIVES_ENABLED:-true\}/);
  assert.match(config,/meshDerivativesEnabled:\s*bool\(process\.env\.MESH_DERIVATIVES_ENABLED, true\)/);
  assert.doesNotMatch(config,/meshDerivativesEnabled:[^\n]*LOCAL_DERIVATIVES_ENABLED/);
  assert.deepEqual(obj2TilesArguments('/source.obj','/output'),CONTROLLED_CONVERTER.arguments.map((value)=>value==='<source.obj>'?'/source.obj':value==='<output>'?'/output':value));
  assert.deepEqual(obj2TilesArguments('/source.obj','/output',{serialRetry:true}),SERIAL_RETRY_CONVERTER.arguments.map((value)=>value==='<source.obj>'?'/source.obj':value==='<output>'?'/output':value));
  assert.equal(CONTROLLED_CONVERTER.arguments[CONTROLLED_CONVERTER.arguments.indexOf('--max-parallelism')+1],'2');
  assert.equal(SERIAL_RETRY_CONVERTER.arguments[SERIAL_RETRY_CONVERTER.arguments.indexOf('--max-parallelism')+1],'1');
  assert.doesNotMatch(worker,/--keeptextures/);
  assert.match(worker,/auditSource,[\s\S]*'--controlled-obj2tiles',[\s\S]*source,[\s\S]*config\.obj2TilesBin/);
  assert.equal((worker.match(/'--controlled-obj2tiles'/g)||[]).length,1);
  assert.match(worker,/run\(process\.execPath, \[audit, tiles, source, '--external-source'\]/);
  assert.doesNotMatch(worker,/config\.obj2TilesBin,\s*\['-i'/);
});
test('server fallback enables mesh derivatives while explicit false remains authoritative',()=>{const root=path.resolve(__dirname,'..'),probe=(value)=>{const env={...process.env};if(value===undefined)delete env.MESH_DERIVATIVES_ENABLED;else env.MESH_DERIVATIVES_ENABLED=value;const result=spawnSync(process.execPath,['-e',"process.stdout.write(String(require('./server/config').config.meshDerivativesEnabled))"],{cwd:root,env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout;};assert.equal(probe(undefined),'true');assert.equal(probe('false'),'false');});
