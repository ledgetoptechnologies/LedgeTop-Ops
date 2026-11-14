'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {parseBaselineJpegHeader:parse,validateJpegReceipt:validate}=require('../server/orthophotoJpegValidation');
function segment(marker,payload){const length=Buffer.alloc(4);length[0]=255;length[1]=marker;length.writeUInt16BE(payload.length+2,2);return Buffer.concat([length,payload]);}
const frame=()=>segment(0xc0,Buffer.from([8,0,2,0,3,3,1,0x11,0,2,0x11,0,3,0x11,0]));
const scan=()=>segment(0xda,Buffer.from([3,1,0,2,0,3,0,0,63,0]));
const image=(parts=[frame(),scan()])=>Buffer.concat([Buffer.from([255,216]),...parts,Buffer.from([1,255,217])]);
function reader(buffer){let bytes=0;return {read:async(at,size)=>{bytes+=size;assert.ok(bytes<=1024*1024);return buffer.subarray(at,at+size);},count:()=>bytes};}
test('baseline exact dimensions with JFIF header produces header-only evidence',async()=>{
  const jfif=Buffer.from([74,70,73,70,0,1,1,0,0,1,0,1,0,0]);
  const b=image([segment(0xe0,jfif),frame(),scan()]),r=reader(b);
  const evidence=await parse(r.read,b.length,{width:3,height:2});
  assert.equal(evidence.bands,3);assert.equal(evidence.headerOnly,true);
  assert.equal(evidence.fullPixelDecodeVerified,false);assert.equal(evidence.bytesRead,r.count());
});
test('progressive other frames duplicate frames private metadata and malformed segments reject',async()=>{
  for(const parts of [[segment(0xc2,Buffer.alloc(15)),scan()],[frame(),frame(),scan()],
    ...[0xe1,0xe2,0xef,0xfe].map(code=>[segment(code,Buffer.from('private')),frame(),scan()]),
    [segment(0xe0,Buffer.from('Exif\0')),frame(),scan()],
    [Buffer.from([255,219,255,255])],[frame()]]){
    const b=image(parts);await assert.rejects(parse(reader(b).read,b.length,{width:3,height:2}));
  }
  const b=image();await assert.rejects(parse(reader(b).read,b.length,{width:4,height:2}),{code:'jpeg_frame_dimensions'});
  b[b.length-1]=0;await assert.rejects(parse(reader(b).read,b.length,{width:3,height:2}),{code:'jpeg_eoi'});
});
test('short reads and oversized cumulative header reject before exceeding read budget',async()=>{
  const b=image();await assert.rejects(parse(async()=>Buffer.alloc(0),b.length,{width:3,height:2}),{code:'jpeg_header_short_read'});
  const payload=Buffer.alloc(60014);Buffer.from('JFIF\0','ascii').copy(payload);payload[5]=1;payload[12]=200;payload[13]=100;
  const large=image([...Array.from({length:18},()=>segment(0xe0,payload)),frame(),scan()]),r=reader(large);
  await assert.rejects(parse(r.read,large.length,{width:3,height:2}),{code:'jpeg_header_budget'});
  assert.ok(r.count()<=1024*1024);
});
function fixture(){
  const plan={schemaVersion:1,kind:'orthophoto-jpeg-v1',operationId:'11111111-1111-4111-8111-111111111111',
    sourceAssetId:'asset',sourceVersionId:'version',sourceSha256:'a'.repeat(64),sourceByteSize:123,
    encoderSha256:'b'.repeat(64),width:3,height:2,backgroundRgb:[255,255,255],
    jpeg:{quality:90,progressive:false,optimize:false,writeMetadata:false}};
  const outputs={'flattened.ppm':{sha256:'c'.repeat(64),byteSize:29,header:Buffer.from('P6\n3 2\n255\n')},
    'image.jpg':{sha256:'d'.repeat(64),byteSize:100},'cjpeg.stderr':{sha256:'e'.repeat(64),byteSize:0}};
  const receipt={schemaVersion:1,status:'JPEG_CREATED_PENDING_INDEPENDENT_REVIEW',accepted:false,
    executionAdmissionEstablished:false,sourceUnchanged:true,...Object.fromEntries(['operationId','sourceAssetId',
      'sourceVersionId','sourceSha256','sourceByteSize','encoderSha256','width','height'].map(key=>[key,plan[key]])),
    bands:3,backgroundRgb:[255,255,255],quality:90,progressive:false,optimize:false,writeMetadata:false,
    encoderChild:{started:true,reaped:true,exitCode:0,pid:123,cancelledSignals:[],termRequested:false,
      killRequested:false,stderrBytesObserved:0,stderrBytesRetained:0},
    outputs:Object.fromEntries(Object.entries(outputs).map(([name,value])=>[name,{sha256:value.sha256,byteSize:value.byteSize}]))};
  return {plan,receipt,outputs};
}
test('receipt binds independent output hashes and exact P6 size without physical proof',()=>{
  const f=fixture(),result=validate(f);assert.equal(result.validated,true);
  assert.equal(result.binding.sha256,f.outputs['image.jpg'].sha256);
  assert.equal(result.evidence.physicalClosureEstablished,false);assert.equal(result.evidence.pixelDecodeVerified,false);
  assert.equal('accepted' in result,false);
  // Python ns stamps can exceed Number precision; this validator never compares them.
  f.receipt.sourceIdentity=[1,2,123,1e18,1e18];assert.equal(validate(f).validated,true);
});
test('receipt identity policy child and independently hashed bytes cannot diverge',()=>{
  for(const change of [f=>f.receipt.accepted=true,f=>f.receipt.sourceUnchanged=false,
    f=>f.receipt.sourceAssetId='other',f=>f.receipt.encoderSha256='f'.repeat(64),
    f=>f.receipt.width=4,f=>f.receipt.optimize=true,f=>f.receipt.backgroundRgb=[0,0,0],
    f=>f.receipt.encoderChild.reaped=false,f=>f.receipt.encoderChild.cancelledSignals=[15],
    f=>f.receipt.encoderChild.firstFailure={type:'timeout'},f=>f.receipt.encoderChild.cleanupUnproven=true,
    f=>f.outputs['image.jpg'].sha256='f'.repeat(64),f=>f.outputs.extra={},
    f=>f.outputs['flattened.ppm'].header=Buffer.from('bad'),f=>f.outputs['flattened.ppm'].byteSize++,
    f=>{f.outputs['cjpeg.stderr'].byteSize=1024*1024+1;f.receipt.outputs['cjpeg.stderr'].byteSize=1024*1024+1;},
    f=>{f.outputs['image.jpg'].byteSize=32*1024*1024+19;f.receipt.outputs['image.jpg'].byteSize=32*1024*1024+19;}]){
    const f=fixture();change(f);assert.throws(()=>validate(f));
  }
});
