'use strict';
const HASH=/^[a-f0-9]{64}$/;
const NAMES=['cjpeg.stderr','flattened.ppm','image.jpg'];
const fail=code=>{throw Object.assign(new Error(code),{code});};
const need=(value,code)=>{if(!value)fail(code);};
const dimensions=(width,height)=>Number.isInteger(width)&&Number.isInteger(height)&&width>0&&height>0&&width<=65500&&height<=65500;

// Only the marker header through the first SOS and terminal EOI are inspected.
// Entropy, later scans/frames, pixel decoding and color fidelity are not verified.
async function parseBaselineJpegHeader(readRange,totalBytes,{width,height}={}){
  need(typeof readRange==='function'&&Number.isSafeInteger(totalBytes)&&totalBytes>=4&&dimensions(width,height),'jpeg_header_input');
  let budget=0,offset=2,frame=null,markers=0;
  async function read(at,size){
    need(Number.isSafeInteger(at)&&Number.isSafeInteger(size)&&at>=0&&size>0&&at<=totalBytes-size,'jpeg_header_offset');
    budget+=size;need(budget<=1024*1024,'jpeg_header_budget');
    const data=await readRange(at,size);
    need(Buffer.isBuffer(data)&&data.length===size,'jpeg_header_short_read');return data;
  }
  need((await read(0,2)).equals(Buffer.from([255,216])),'jpeg_soi');
  need((await read(totalBytes-2,2)).equals(Buffer.from([255,217])),'jpeg_eoi');
  while(offset<totalBytes-2){
    need(++markers<=4096,'jpeg_header_marker_bound');
    need((await read(offset++,1))[0]===255,'jpeg_marker');
    let marker=(await read(offset++,1))[0];
    while(marker===255){need(++markers<=4096,'jpeg_header_marker_bound');marker=(await read(offset++,1))[0];}
    need([0xc0,0xc4,0xdb,0xdd,0xda,0xe0].includes(marker),'jpeg_marker_unsupported');
    const length=(await read(offset,2)).readUInt16BE();offset+=2;
    need(length>=2&&offset<=totalBytes-2-(length-2),'jpeg_segment_length');
    const payload=length>2?await read(offset,length-2):Buffer.alloc(0);offset+=length-2;
    if(marker===0xe0){
      need(payload.length>=14&&payload.subarray(0,5).equals(Buffer.from('JFIF\0','ascii'))&&
        payload[5]===1&&payload.length===14+3*payload[12]*payload[13],'jpeg_app0_not_jfif');
    }else if(marker===0xc0){
      need(!frame,'jpeg_duplicate_frame');
      need(payload.length===15&&payload[0]===8&&payload[5]===3,'jpeg_frame_format');
      const h=payload.readUInt16BE(1),w=payload.readUInt16BE(3);
      need(w===width&&h===height,'jpeg_frame_dimensions');
      const ids=[payload[6],payload[9],payload[12]];
      need(new Set(ids).size===3&&[6,9,12].every(i=>
        (payload[i+1]>>4)>=1&&(payload[i+1]>>4)<=4&&(payload[i+1]&15)>=1&&
        (payload[i+1]&15)<=4&&payload[i+2]<=3),'jpeg_component_ids');
      frame={ids};
    }else if(marker===0xda){
      need(frame&&payload.length===10&&payload[0]===3&&
        new Set([payload[1],payload[3],payload[5]]).size===3&&
        [payload[1],payload[3],payload[5]].every(id=>frame.ids.includes(id))&&
        [payload[2],payload[4],payload[6]].every(table=>(table>>4)<=3&&(table&15)<=3)&&
        payload[7]===0&&payload[8]===63&&payload[9]===0,'jpeg_scan_format');
      need(offset<totalBytes-2,'jpeg_missing_entropy');
      return {width,height,bands:3,baseline:true,headerOnly:true,bytesRead:budget,
        fullPixelDecodeVerified:false,colorFidelityVerified:false};
    }else if(marker===0xdd)need(payload.length===2,'jpeg_restart_interval');
  }
  fail('jpeg_scan_missing');
}

function validateJpegReceipt({plan,receipt:r,outputs}={}){
  need(plan&&dimensions(plan.width,plan.height)&&plan.schemaVersion===1&&plan.kind==='orthophoto-jpeg-v1'&&
    typeof plan.operationId==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(plan.operationId)&&
    ['sourceAssetId','sourceVersionId'].every(key=>typeof plan[key]==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(plan[key]))&&
    typeof plan.sourceSha256==='string'&&HASH.test(plan.sourceSha256)&&typeof plan.encoderSha256==='string'&&HASH.test(plan.encoderSha256)&&
    Number.isSafeInteger(plan.sourceByteSize)&&plan.sourceByteSize>0,'jpeg_receipt_plan');
  need(r&&r.schemaVersion===1&&r.status==='JPEG_CREATED_PENDING_INDEPENDENT_REVIEW'&&r.accepted===false&&
    r.executionAdmissionEstablished===false&&r.sourceUnchanged===true&&!Object.hasOwn(r,'error')&&!Object.hasOwn(r,'errorType'),'jpeg_receipt_status');
  for(const key of ['operationId','sourceAssetId','sourceVersionId','sourceSha256','sourceByteSize','encoderSha256','width','height'])
    need(r[key]===plan[key],'jpeg_receipt_binding');
  need(r.bands===3&&r.quality===90&&r.progressive===false&&r.optimize===false&&r.writeMetadata===false&&
    plan.jpeg?.quality===90&&plan.jpeg.progressive===false&&plan.jpeg.optimize===false&&plan.jpeg.writeMetadata===false&&
    JSON.stringify(plan.backgroundRgb)==='[255,255,255]'&&JSON.stringify(r.backgroundRgb)==='[255,255,255]','jpeg_receipt_policy');
  const c=r.encoderChild;
  need(c&&c.started===true&&c.reaped===true&&c.exitCode===0&&Number.isSafeInteger(c.pid)&&c.pid>0&&
    Array.isArray(c.cancelledSignals)&&c.cancelledSignals.length===0&&c.termRequested===false&&c.killRequested===false&&
    !Object.hasOwn(c,'firstFailure')&&!c.cleanupUnproven&&!c.cleanupUnknown,'jpeg_receipt_child');
  need(outputs&&r.outputs&&JSON.stringify(Object.keys(outputs).sort())===JSON.stringify(NAMES)&&
    JSON.stringify(Object.keys(r.outputs).sort())===JSON.stringify(NAMES),'jpeg_receipt_output_names');
  for(const name of NAMES){
    const a=outputs[name],b=r.outputs[name];
    need(a&&b&&typeof a.sha256==='string'&&HASH.test(a.sha256)&&Number.isSafeInteger(a.byteSize)&&a.byteSize>=0&&
      a.sha256===b.sha256&&a.byteSize===b.byteSize,'jpeg_receipt_output_binding');
  }
  const ppm=outputs['flattened.ppm'],jpg=outputs['image.jpg'],stderr=outputs['cjpeg.stderr'];
  const header=Buffer.from(`P6\n${plan.width} ${plan.height}\n255\n`,'ascii'),pixels=plan.width*plan.height*3;
  need(Buffer.isBuffer(ppm.header)&&ppm.header.equals(header)&&ppm.byteSize===header.length+pixels,'jpeg_receipt_ppm');
  need(jpg.byteSize>0&&jpg.byteSize<=pixels+32*1024*1024&&stderr.byteSize<=1024*1024&&
    c.stderrBytesObserved===stderr.byteSize&&c.stderrBytesRetained===stderr.byteSize,'jpeg_receipt_output_limits');
  return {validated:true,binding:{sourceAssetId:plan.sourceAssetId,sourceVersionId:plan.sourceVersionId,
    sourceSha256:plan.sourceSha256,sourceByteSize:plan.sourceByteSize,encoderSha256:plan.encoderSha256,
    width:plan.width,height:plan.height,sha256:jpg.sha256,byteSize:jpg.byteSize},
  evidence:{receiptBound:true,physicalClosureEstablished:false,pixelDecodeVerified:false,colorFidelityVerified:false}};
}
module.exports={parseBaselineJpegHeader,validateJpegReceipt};
