import fs from 'node:fs';
import crypto from 'node:crypto';
import {fromFile} from 'geotiff';
import {nativeRasterDefinition,NATIVE_RASTER_BLOCK_LIMIT} from './measurementRasterCalculation.mjs';
import {validateMeasurementTiffHeader} from './measurementTiffHeader.mjs';
import {validateRasterEncodedBlocks} from '../raster-source-metadata.mjs';
import {readRasterBandMetadata} from '../raster-vertical-units.mjs';
import {validatePolygon} from '../measurement-volume.mjs';

export const NATIVE_TRANSECT_LIMIT=20_000;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const point=p=>Array.isArray(p)&&p.length===2&&p.every(v=>Number.isFinite(v)&&Math.abs(v)<=1e9);
const at=(line,t)=>line.start.map((v,i)=>v+(line.end[i]-v)*t);
const cross=(a,b,p)=>(b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
function validateLine(line){if(!point(line?.start)||!point(line?.end)||Math.hypot(...line.end.map((v,i)=>v-line.start[i]))<=0)fail('measurement_transect_invalid');}
function halfPlanes(line,distances){
  let lo=0,hi=1;
  for(const distance of distances){const a=distance(line.start),b=distance(line.end);if(a<0&&b<0)return null;if(a<0)lo=Math.max(lo,a/(a-b));else if(b<0)hi=Math.min(hi,a/(a-b));if(lo>=hi)return null;}
  return [lo,hi];
}
function unique(values){return [...new Set(values)].sort((a,b)=>a-b);}

// A small output window alone does not bound decoder memory: thin TIFF blocks
// can make one window decompress many individually large blocks concurrently.
// Keep every read inside exactly one validated native strip/tile.
export function transectRasterWindow(col,row,{width,height,blockWidth,blockHeight},side=32){
  if(![width,height,blockWidth,blockHeight,side].every(v=>Number.isSafeInteger(v)&&v>0)||![col,row].every(v=>Number.isSafeInteger(v)&&v>=0)||col>=width||row>=height)fail('measurement_raster_transform_unsupported');
  const blockLeft=Math.floor(col/blockWidth)*blockWidth,blockTop=Math.floor(row/blockHeight)*blockHeight;
  const left=blockLeft+Math.floor((col-blockLeft)/side)*side,top=blockTop+Math.floor((row-blockTop)/side)*side;
  return [left,top,Math.min(width,blockLeft+blockWidth,left+side),Math.min(height,blockTop+blockHeight,top+side)];
}

// Half-open PixelIsArea ownership: a line exactly on a grid boundary samples
// the east/south cell, never both. Corner-only contacts have zero station length.
export function traceRasterCells(line,definition,{maxCells=NATIVE_TRANSECT_LIMIT}={}){
  validateLine(line);const {ox,oy,dx,dy,width,height}=definition;
  if(![ox,oy,dx,dy].every(Number.isFinite)||dx<=0||dy>=0||!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0)fail('measurement_raster_transform_unsupported');
  const limit=Math.min(NATIVE_TRANSECT_LIMIT,maxCells);
  if(!Number.isSafeInteger(limit)||limit<1)fail('measurement_transect_limit');
  const grid={start:[(line.start[0]-ox)/dx,(line.start[1]-oy)/dy],end:[(line.end[0]-ox)/dx,(line.end[1]-oy)/dy]};
  const extent=halfPlanes(grid,[p=>p[0],p=>width-p[0],p=>p[1],p=>height-p[1]]),events=[0,1];
  if(extent){
    events.push(...extent);
    for(let axis=0;axis<2;axis++){
      const delta=grid.end[axis]-grid.start[axis];if(delta===0)continue;
      const first=at(grid,extent[0])[axis],last=at(grid,extent[1])[axis],low=Math.floor(Math.min(first,last))+1,high=Math.ceil(Math.max(first,last))-1;
      if(high-low+1>limit)fail('measurement_transect_limit');
      for(let boundary=low;boundary<=high;boundary++){const t=(boundary-grid.start[axis])/delta;if(t>extent[0]&&t<extent[1])events.push(t);}
    }
  }
  const breaks=unique(events),cells=[];let visited=0;
  for(let i=0;i<breaks.length-1;i++){
    const startT=breaks[i],endT=breaks[i+1],p=at(grid,(startT+endT)/2),col=Math.floor(p[0]),row=Math.floor(p[1]),inside=col>=0&&row>=0&&col<width&&row<height;
    if(inside&&++visited>limit)fail('measurement_transect_limit');
    cells.push({startT,endT,...(inside?{col,row}:{col:null,row:null})});
  }
  return cells;
}

export function frozenReferenceIntervals(line,patches){
  validateLine(line);
  if(!Array.isArray(patches)||patches.length<1||patches.length>254)fail('measurement_transect_reference_invalid');
  return patches.flatMap((triangle,index)=>{
    if(!Array.isArray(triangle)||triangle.length!==3||triangle.some(p=>!Array.isArray(p)||p.length!==3||!p.every(Number.isFinite)))fail('measurement_transect_reference_invalid');
    const [a,b,c]=triangle,det=cross(a,b,c);if(Math.abs(det)<1e-12)fail('measurement_transect_reference_invalid');
    const sign=Math.sign(det),interval=halfPlanes(line,triangle.map((p,i)=>q=>sign*cross(p,triangle[(i+1)%3],q)));
    if(!interval)return [];
    const slopeE=((b[2]-a[2])*(c[1]-a[1])-(c[2]-a[2])*(b[1]-a[1]))/det;
    const slopeN=((b[0]-a[0])*(c[2]-a[2])-(c[0]-a[0])*(b[2]-a[2]))/det;
    return [{index,startT:interval[0],endT:interval[1],sample:p=>a[2]+slopeE*(p[0]-a[0])+slopeN*(p[1]-a[1])}];
  });
}

export async function calculateNativeRasterTransect(absolutePath,request,{signal,maxCells=NATIVE_TRANSECT_LIMIT,maxSegments=NATIVE_TRANSECT_LIMIT,maxBlockBytes=NATIVE_RASTER_BLOCK_LIMIT,windowSize=32,maxWindows=4,onProgress=()=>{},onTiming=()=>{}}={}){
  const started=performance.now();let rasterReadMs=0;
  const check=()=>{if(signal?.aborted)fail('measurement_cancelled');};check();
  if(request?.method!=='surface-transect')fail('measurement_transect_invalid');
  validateLine(request.line);validatePolygon(request.vertices);
  const line={start:[...request.line.start],end:[...request.line.end]},lengthM=Math.hypot(...line.end.map((v,i)=>v-line.start[i]));
  const patches=frozenReferenceIntervals(line,request.referencePatches),baseHash=crypto.createHash('sha256').update(JSON.stringify(request.referencePatches)).digest('hex');
  if(request.baseHash&&request.baseHash!==baseHash)fail('measurement_transect_reference_invalid');
  const segmentLimit=Math.min(maxSegments,NATIVE_TRANSECT_LIMIT);
  if(!Number.isSafeInteger(segmentLimit)||segmentLimit<1)fail('measurement_transect_limit');
  const windowSide=Math.min(64,Math.max(1,Number.isSafeInteger(windowSize)?windowSize:32)),cacheLimit=Math.min(4,Math.max(1,Number.isSafeInteger(maxWindows)?maxWindows:4));
  const sourceStat=await fs.promises.stat(absolutePath);
  if(!sourceStat.isFile()||sourceStat.size!==Number(request.source.byteSize))fail('measurement_source_changed');
  const hashStarted=performance.now(),hash=crypto.createHash('sha256');
  try{for await(const chunk of fs.createReadStream(absolutePath,{highWaterMark:1024*1024,signal})){check();hash.update(chunk);}}catch(error){check();throw error;}
  if(hash.digest('hex')!==request.source.sha256)fail('measurement_source_changed');check();
  const sourceHashMs=performance.now()-hashStarted,samplingStarted=performance.now();
  await validateMeasurementTiffHeader(absolutePath);check();
  const tiff=await fromFile(absolutePath);
  try{
    const image=await tiff.getImage(0),definition=nativeRasterDefinition(image,request,{maxBlockBytes,bandMetadata:await readRasterBandMetadata(image)});
    await validateRasterEncodedBlocks(image,{maxBlockBytes:Math.min(maxBlockBytes,NATIVE_RASTER_BLOCK_LIMIT)});check();
    const cells=traceRasterCells(line,definition,{maxCells}),breaks=unique([0,1,...cells.flatMap(c=>[c.startT,c.endT]),...patches.flatMap(p=>[p.startT,p.endT])]);
    if(breaks.length-1>segmentLimit)fail('measurement_transect_limit');
    const cache=new Map(),nodata=image.getGDALNoData(),segments=[],layout={...definition,blockWidth:image.getTileWidth(),blockHeight:image.getTileHeight()};let cellIndex=0,reads=0;
    async function pixel(col,row){
      const [left,top,right,bottom]=transectRasterWindow(col,row,layout,windowSide),key=`${left}:${top}`;
      let window=cache.get(key);
      if(window){cache.delete(key);cache.set(key,window);}
      else{
        check();if(++reads>NATIVE_TRANSECT_LIMIT)fail('measurement_transect_limit');
        const readStarted=performance.now(),values=await image.readRasters({window:[left,top,right,bottom],samples:[0],interleave:true,signal});rasterReadMs+=performance.now()-readStarted;check();
        window={values,width:right-left};cache.set(key,window);if(cache.size>cacheLimit)cache.delete(cache.keys().next().value);
      }
      return Number(window.values[(row-top)*window.width+col-left]);
    }
    for(let i=0;i<breaks.length-1;i++){
      check();const startT=breaks[i],endT=breaks[i+1],mid=(startT+endT)/2;
      while(cellIndex<cells.length-1&&mid>=cells[cellIndex].endT)cellIndex++;
      const cell=cells[cellIndex],patch=patches.find(p=>mid>=p.startT&&mid<=p.endT),start=at(line,startT),end=at(line,endT);
      const segment={startM:startT*lengthM,endM:endT*lengthM,start,end,status:'outside-selection'};
      if(cell.col!==null)segment.cell=[cell.col,cell.row];
      if(patch){
        segment.baseStartM=patch.sample(start);segment.baseEndM=patch.sample(end);
        if(!Number.isFinite(segment.baseStartM)||!Number.isFinite(segment.baseEndM))fail('measurement_transect_reference_invalid');
        if(cell.col===null)segment.status='outside-raster';
        else{
          const raw=await pixel(cell.col,cell.row);
          if(!Number.isFinite(raw)||(nodata!=null&&raw===Number(nodata)))segment.status='nodata';
          else{segment.status='sample';segment.surfaceM=raw*definition.verticalFactor;if(!Number.isFinite(segment.surfaceM))segment.status='nodata';}
        }
      }
      if(segment.status!=='sample')delete segment.surfaceM;
      segments.push(segment);
      if(i%128===0||i===breaks.length-2){onProgress((i+1)/Math.max(1,breaks.length-1));await new Promise(resolve=>setImmediate(resolve));}
    }
    check();const finalStat=await fs.promises.stat(absolutePath);if(['size','ino','dev','mtimeMs','ctimeMs'].some(k=>sourceStat[k]!==finalStat[k]))fail('measurement_source_changed');
    const declared=definition.verticalUnitBasis==='requester-declared'||definition.verticalUnitBasis==='administrator-declared';
    try{onTiming({phase:'raster-transect',sourceHashMs,rasterReadMs,sampleMs:Math.max(0,performance.now()-samplingStarted-rasterReadMs),totalMs:performance.now()-started,cellCount:cells.filter(c=>c.col!==null).length,segmentCount:segments.length,windowReads:reads});}catch{}
    return {schemaVersion:1,status:'calculated',method:'surface-transect',calculationOrigin:'server-native-raster',sampling:'native-cell-step',parentCalculationId:request.parentCalculationId,baseHash,reference:request.reference,line,lengthM,segments,cellCount:cells.filter(c=>c.col!==null).length,
      source:{assetId:request.source.id,kind:request.source.kind,sha256:request.source.sha256,modelVersionId:request.modelVersionId,resolutionM:[definition.dx,-definition.dy],crs:definition.crs,verticalUnit:'m',verticalUnitBasis:definition.verticalUnitBasis,...(definition.verticalUnitEvidence?{verticalUnitEvidence:definition.verticalUnitEvidence}:{}),verticalDatum:'unknown'},
      warnings:['Elevations use constant native cell values; the base follows the completed measurement’s frozen reference triangles. Gaps are not interpolated. Vertical datum has not been verified.',...(declared?['Source height units were requester-declared, not encoded in the raster or independently verified.']:[])]};
  }catch(error){check();throw error;}finally{await tiff.close();}
}
