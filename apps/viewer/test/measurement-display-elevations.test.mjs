import test from 'node:test';
import assert from 'node:assert/strict';
import {fromArrayBuffer} from 'geotiff';
import {resolveMeasurementDisplayElevations,retainedDisplayBoundary} from '../measurement-display-elevations.mjs';
import {nativeTiffFixture} from './helpers/native-tiff-fixture.mjs';
import {createRequire} from 'node:module';
import {countyReferenceRequest} from '../scripts/validate-county-stockpile-reference.mjs';
const {toViewerConfig}=createRequire(import.meta.url)('../server/apiV1.js');
const record=()=>({collection:'map',kind:'polygon',coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'},vertices:[[.25,.25,0],[1.75,.25,0],[1.75,1.75,0],[.25,1.75,0]],source:{kind:'ortho'},results:{status:'geometry-only',elevationBasis:'not-sampled'}});
function fixture(overrides={}){
  const counts={preflight:0,open:0,close:0,reads:[]};
  const image={getGeoKeys:()=>({ProjectedCSTypeGeoKey:32616,VerticalUnitsGeoKey:9001}),getSamplesPerPixel:()=>1,getOrigin:()=>[0,2],getResolution:()=>[1,-1],getWidth:()=>2,getHeight:()=>2,fileDirectory:{BitsPerSample:[32],RowsPerStrip:1},getGDALNoData:()=>null,readRasters:async options=>{counts.reads.push(options);return new Float32Array([1,2,3,4]);},...overrides};
  const options={modelVersionId:'v1',expectedCrs:'EPSG:32616',source:{type:'dsm',url:'/source/dsm.tif'},preflight:async()=>{counts.preflight++;},openTiff:async(_url,options)=>{counts.open++;assert.equal(options.allowFullFile,false);return{getImage:async()=>image,close:async()=>{counts.close++;}};}};
  return{counts,image,options,run:(r=record(),extra={})=>resolveMeasurementDisplayElevations(r,{...options,...extra})};
}
test('display-only sampling preserves map geometry/results and uses one bounded native window',async()=>{
  const f=fixture(),r=record(),before=structuredClone(r),pool={bindParameters:()=>{}},result=await f.run(r,{pool});
  assert.deepEqual(result.vertices.map(p=>p[2]),[3,4,2,1]);assert.deepEqual(r,before);assert.equal(f.counts.close,1);assert.equal(f.counts.reads.length,1);assert.deepEqual(f.counts.reads[0].window,[0,0,2,2]);assert.match(result.basis,/DSM native-cell elevations.*display only/);
  assert.equal(f.counts.reads[0].pool,pool,'native decoding receives the shared worker pool');
});
test('real TIFF with explicit GDAL foot band units provides correct display XYZ without changing saved zero Z',async()=>{
  const bytes=nativeTiffFixture({verticalUnit:null,gdalMetadata:'<GDALMetadata><Item name="UNITTYPE" sample="0" role="unittype">ft</Item></GDALMetadata>'});
  const tiff=await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)),image=await tiff.getImage(),f=fixture();f.options.openTiff=async()=>({getImage:async()=>image,close:async()=>{}});
  const r=record(),result=await f.run(r);assert.deepEqual(result.vertices.map(p=>p[2]),[3,4,2,1].map(v=>v*.3048));assert.ok(r.vertices.every(p=>p[2]===0));assert.equal(r.results.status,'geometry-only');assert.match(result.basis,/gdal-band-unit/);
});
test('same-version, same-XY saved boundary with explicit units can be reused without source reads',async()=>{
  const r=record();r.results={method:'surface-cut-fill',modelVersionId:'v1',sourceVerticalUnitBasis:'gdal-band-unit',boundaryVertices:r.vertices.map((p,i)=>[p[0],p[1],100+i])};
  const f=fixture(),result=await f.run(r);assert.deepEqual(result.vertices.map(p=>p[2]),[100,101,102,103]);assert.equal(f.counts.preflight,0);result.vertices[0][2]=900;assert.equal(r.results.boundaryVertices[0][2],100);
  assert.equal(retainedDisplayBoundary(r,'other'),null);r.results.boundaryVertices[0][0]++;assert.equal(retainedDisplayBoundary(r,'v1'),null);r.results.boundaryVertices[0][0]--;delete r.results.sourceVerticalUnitBasis;assert.equal(retainedDisplayBoundary(r,'v1'),null);
});

test('requester-declared saved boundaries retain honest provenance and legacy declarations remain readable',()=>{
  for(const basis of ['requester-declared','administrator-declared','user-declared']){
    const r=record();r.results={method:'surface-cut-fill',source:{modelVersionId:'v1',verticalUnitBasis:basis},boundaryVertices:r.vertices.map(p=>[p[0],p[1],100])};
    const before=structuredClone(r),retained=retainedDisplayBoundary(r,'v1');
    assert.deepEqual(retained.vertices,r.results.boundaryVertices);assert.ok(retained.basis.includes(basis));assert.deepEqual(r,before,'reading does not rewrite historical attribution');
    assert.equal(retainedDisplayBoundary(r,'other'),null);
  }
});

test('reviewed source boundary is reused without opening or sampling the untagged TIFF',async()=>{
  const r=record();r.results={method:'surface-cut-fill',source:{modelVersionId:'v1',verticalUnitBasis:'reviewed-source-provenance',boundaryElevationBasis:'native-raster'},boundaryVertices:r.vertices.map((p,i)=>[p[0],p[1],170+i])};
  const before=structuredClone(r),f=fixture({getGeoKeys:()=>({ProjectedCSTypeGeoKey:32616})}),value=await f.run(r);
  assert.deepEqual(value.vertices,r.results.boundaryVertices);assert.match(value.basis,/reviewed-source-provenance/);assert.deepEqual(f.counts,{preflight:0,open:0,close:0,reads:[]});assert.deepEqual(r,before);
  assert.equal(retainedDisplayBoundary(r,'other'),null);r.results.boundaryVertices[0][0]++;assert.equal(retainedDisplayBoundary(r,'v1'),null);
});

test('point boundaries require exact saved geometry, normalized units and source provenance',async()=>{
 const r=record();r.results={method:'point-surface-cut-fill',calculationOrigin:'server-original-point-surface',boundaryVertices:r.vertices.map(p=>[p[0],p[1],12]),source:{kind:'ept',assetId:'ept',sha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),modelVersionId:'v1',crs:'EPSG:32616',verticalUnit:'m',verticalUnitBasis:'ept-vertical-crs',boundaryElevationBasis:'point-grid'}};
 const f=fixture();assert.deepEqual((await f.run(r)).vertices,r.results.boundaryVertices);assert.equal(f.counts.open,0);
 for(const [key,value]of [['kind','dsm'],['assetId',''],['sha256','bad'],['manifestSha256','bad'],['modelVersionId','v2'],['crs','EPSG:32617'],['verticalUnit','ft'],['verticalUnitBasis','guessed'],['boundaryElevationBasis',undefined]]){
  const changed=structuredClone(r);changed.results.source[key]=value;assert.equal(retainedDisplayBoundary(changed,'v1'),null,key);
 }
 for(const mutate of [x=>delete x.results.boundaryVertices,x=>x.results.boundaryVertices[0][0]++,x=>x.results.boundaryVertices[0][2]=NaN,x=>x.results.calculationOrigin='browser',x=>x.results.method='reconstructed-estimate']){
  const changed=structuredClone(r);mutate(changed);assert.equal(retainedDisplayBoundary(changed,'v1'),null);
 }
 assert.equal(retainedDisplayBoundary(r,'v2'),null);
 const legacy=structuredClone(r);delete legacy.results.boundaryVertices;delete legacy.results.source.boundaryElevationBasis;
 await assert.rejects(f.run(legacy,{source:null}),/no existing DSM/,'legacy results are not repaired from previews');
});
test('missing elevations or unverified units fail closed instead of fabricating zero or reusing stale preview',async()=>{
  for(const [overrides,pattern]of [
    [{getGeoKeys:()=>({ProjectedCSTypeGeoKey:32616})},/does not encode elevation units/],
    [{getGeoKeys:()=>({ProjectedCSTypeGeoKey:32616,ProjLinearUnitsGeoKey:9002,VerticalUnitsGeoKey:9001})},/horizontal units/],
    [{getGeoKeys:()=>({ProjectedCSTypeGeoKey:32617,VerticalUnitsGeoKey:9001})},/projection/],
    [{getSamplesPerPixel:()=>3},/single-band/],
    [{getResolution:()=>[1,1]},/grid/],
    [{getGDALNoData:()=>3},/no source elevation/],
    [{readRasters:async()=>new Float32Array([1,2,NaN,4])},/no source elevation/],
    [{readRasters:async()=>new Float32Array(1)},/window is incomplete/],
  ]){const f=fixture(overrides);await assert.rejects(f.run(),pattern);assert.equal(f.counts.close,1);}
  const f=fixture();await assert.rejects(f.run(record(),{source:null}),/no existing DSM/);assert.equal(f.counts.open,0);
});
test('out-of-bounds and oversized blocks fail while sparse large extents read only deduplicated vertex cells',async()=>{
  const outside=record();outside.vertices[0][0]=-1;const f=fixture();await assert.rejects(f.run(outside),/outside/);assert.equal(f.counts.reads.length,0);
  const wide=record();wide.vertices=[[.25,.25,0],[1999.75,.25,0],[1999.75,1999.75,0],[.25,1999.75,0],[.25,.25,0]];
  const windows=[],large=fixture({getWidth:()=>2000,getHeight:()=>2000,getOrigin:()=>[0,2000],readRasters:async({window})=>{windows.push(window);return new Float32Array([123]);}});
  const sampled=await large.run(wide);assert.equal(windows.length,4);assert.ok(windows.every(([x,y,r,b])=>r-x===1&&b-y===1));assert.ok(sampled.vertices.every(p=>p[2]===123));assert.ok(wide.vertices.every(p=>p[2]===0));
  const block=fixture({fileDirectory:{BitsPerSample:[64],RowsPerStrip:2},getWidth:()=>20_000_000});await assert.rejects(block.run(),/decode blocks/);assert.equal(block.counts.reads.length,0);
});

test('authorized config exposes reviewed display evidence only for the exact visible asset identity',()=>{
  const req=countyReferenceRequest(),asset={...req.source,rootKey:'data',relativePath:'dsm.tif'},model={id:req.modelId,metadata:{},status:'ready',activeVersion:{id:req.modelVersionId,status:'ready',metadata:{},assets:[asset]}};
  const config=toViewerConfig(model,{assetToken:'fixture'}),evidence=config.displayElevationEvidence.dsm;
  assert.equal(evidence.basis,'reviewed-source-provenance');assert.equal(evidence.url,config.assets.dsm);assert.equal(evidence.sha256,asset.sha256);
  for(const key of ['id','kind','sha256','byteSize']){const altered=structuredClone(model);altered.activeVersion.assets[0][key]=key==='byteSize'?1:'wrong';assert.deepEqual(toViewerConfig(altered).displayElevationEvidence,{});}
  const wrongVersion=structuredClone(model);wrongVersion.activeVersion.id='other';assert.deepEqual(toViewerConfig(wrongVersion).displayElevationEvidence,{});
  const wrongModel=structuredClone(model);wrongModel.id='other';assert.deepEqual(toViewerConfig(wrongModel).displayElevationEvidence,{});
  assert.deepEqual(toViewerConfig(model,{assetFilter:()=>false}).displayElevationEvidence,{});
});

test('reviewed display units require matching source context and never override explicit conflicting metadata',async()=>{
  const req=countyReferenceRequest(),asset={...req.source,rootKey:'data',relativePath:'dsm.tif'},model={id:req.modelId,metadata:{},activeVersion:{id:req.modelVersionId,metadata:{},assets:[asset]}};
  const evidence=toViewerConfig(model).displayElevationEvidence.dsm;
  const f=fixture({getGeoKeys:()=>({ProjectedCSTypeGeoKey:32616}),getWidth:()=>evidence.width,getHeight:()=>evidence.height});
  const options={modelId:req.modelId,modelVersionId:req.modelVersionId,source:{type:'dsm',url:evidence.url,reviewedEvidence:evidence}};
  const result=await f.run(record(),options);assert.match(result.basis,/reviewed-source-provenance/);assert.deepEqual(result.vertices.map(p=>p[2]),[3,4,2,1]);
  for(const key of ['modelId','modelVersionId','url','kind','crs','width','height']){
    const altered={...options,source:{...options.source,reviewedEvidence:{...evidence,[key]:'other'}}};await assert.rejects(f.run(record(),altered),/does not encode elevation units/);
  }
  const conflict=fixture({getGeoKeys:()=>({ProjectedCSTypeGeoKey:32616,VerticalUnitsGeoKey:9002}),getWidth:()=>evidence.width,getHeight:()=>evidence.height});await assert.rejects(conflict.run(record(),options),/conflict/);
});

test('large-extent per-vertex sampling stops immediately when authority cancellation aborts',async()=>{
  const controller=new AbortController(),r=record();r.vertices=[[.25,.25,0],[1999.75,.25,0],[1999.75,1999.75,0]];let reads=0;
  const f=fixture({getWidth:()=>2000,getHeight:()=>2000,getOrigin:()=>[0,2000],readRasters:async()=>{reads++;controller.abort();return new Float32Array([123]);}});
  await assert.rejects(f.run(r,{signal:controller.signal}),{name:'AbortError'});assert.equal(reads,1);assert.equal(f.counts.close,1);
});
test('cancellation before or during native sampling never returns display geometry and closes source',async()=>{
  const pre=new AbortController();pre.abort();const f=fixture();await assert.rejects(f.run(record(),{signal:pre.signal}),{name:'AbortError'});assert.equal(f.counts.preflight,0);
  const controller=new AbortController(),late=fixture({readRasters:async()=>{controller.abort();return new Float32Array([1,2,3,4]);}});await assert.rejects(late.run(record(),{signal:controller.signal}),{name:'AbortError'});assert.equal(late.counts.close,1);
});
