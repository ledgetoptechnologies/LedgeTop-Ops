import {rasterDirectoryValue,rasterDecodedBlockBytes,validateRasterEncodedBlocks} from './raster-source-metadata.mjs';
import {readRasterBandMetadata,resolveRasterVerticalUnits} from './raster-vertical-units.mjs';

const MAX_CELLS=1_500_000,MAX_BLOCK=64*1024*1024;
const fail=message=>{throw new Error(`3D overlay unavailable: ${message}`);};
const check=signal=>{if(signal?.aborted)throw new DOMException('Display elevation sampling cancelled','AbortError');};
const finiteVertex=p=>Array.isArray(p)&&p.length===3&&p.every(v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=1e9);
const knownBasis=new Set(['raster-metadata','gdal-band-unit','reviewed-source-provenance','user-declared','administrator-declared','requester-declared']);

export function retainedDisplayBoundary(record,modelVersionId){
  const result=record.results,vertices=result?.boundaryVertices,basis=result?.sourceVerticalUnitBasis||result?.source?.verticalUnitBasis,version=result?.modelVersionId||result?.source?.modelVersionId;
  const point=result?.method==='point-surface-cut-fill',source=result?.source;
  // Point-grid boundaries are normalized metres, but an administrator's unit
  // declaration stays a declaration. Never transfer it to the DSM or recover
  // missing legacy boundaries from reduced preview samples/reference planes.
  const eligible=point?result.calculationOrigin==='server-original-point-surface'&&source?.kind==='ept'&&source.boundaryElevationBasis==='point-grid'&&source.verticalUnit==='m'&&source.modelVersionId===modelVersionId&&source.crs===record.coordinateReference?.crs&&/^EPSG:\d+$/.test(source.crs||'')&&['ept-vertical-crs','administrator-declared'].includes(source.verticalUnitBasis)&&typeof source.assetId==='string'&&source.assetId.length>0&&/^[a-f0-9]{64}$/.test(source.sha256||'')&&/^[a-f0-9]{64}$/.test(source.manifestSha256||''):
    result?.method==='surface-cut-fill'&&knownBasis.has(basis);
  if(!modelVersionId||version!==modelVersionId||!eligible||!Array.isArray(vertices)||vertices.length!==record.vertices.length)return null;
  if(!vertices.every((p,i)=>finiteVertex(p)&&p[0]===record.vertices[i][0]&&p[1]===record.vertices[i][1]))return null;
  return{vertices:vertices.map(p=>p.slice()),basis:`Saved ${point?'point-grid':'surface'} boundary elevations (${point?source.verticalUnitBasis:basis}); display only`};
}

// Display geometry only. This never persists vertices/results, starts a job,
// calculates volume, interpolates NoData, or guesses unencoded vertical units.
export async function resolveMeasurementDisplayElevations(record,{modelId,modelVersionId,expectedCrs,source,signal,openTiff,preflight,pool}={}){
  check(signal);
  if(record.collection!=='map'||!Array.isArray(record.vertices)||record.vertices.length<2||record.vertices.length>2000||!record.vertices.every(finiteVertex))fail('invalid map measurement geometry.');
  if(!/^EPSG:\d+$/.test(expectedCrs||'')||record.coordinateReference?.crs!==expectedCrs)fail('the measurement has no matching verified coordinate reference.');
  const retained=retainedDisplayBoundary(record,modelVersionId);if(retained)return retained;
  if(!source?.url||!['dsm','dtm'].includes(source.type))fail('no existing DSM or DTM provides elevations for this map measurement.');
  if(typeof openTiff!=='function'||typeof preflight!=='function')fail('safe elevation source access is unavailable.');
  const vertices=record.vertices.map(p=>p.slice());
  await preflight(source.url,{signal});check(signal);
  const tiff=await openTiff(source.url,{allowFullFile:false,blockSize:262144,cacheSize:32},signal);
  try{
    check(signal);const image=await tiff.getImage(0);check(signal);
    const keys=image.getGeoKeys?.()||{},epsg=Number(expectedCrs.slice(5)),metricHorizontal=keys.ProjLinearUnitsGeoKey!==undefined?Number(keys.ProjLinearUnitsGeoKey)===9001:(epsg>=32601&&epsg<=32660)||(epsg>=32701&&epsg<=32760);
    if(Number(keys.ProjectedCSTypeGeoKey)!==epsg||!metricHorizontal)fail('the elevation surface uses incompatible horizontal units or projection.');
    if(Number(image.getSamplesPerPixel?.()||1)!==1)fail('a single-band elevation surface is required.');
    const directory=image.getFileDirectory?.()||image.fileDirectory||{},transform=rasterDirectoryValue(directory,'ModelTransformation'),[ox,oy]=image.getOrigin(),[dx,dy]=image.getResolution(),w=image.getWidth(),h=image.getHeight();
    if(Number(keys.GTRasterTypeGeoKey||1)!==1||(transform&&[1,2,4,6,8,9,12,13,14].some(i=>transform[i]!==0))||![ox,oy,dx,dy].every(Number.isFinite)||dx<=0||dy>=0||!Number.isSafeInteger(w)||!Number.isSafeInteger(h)||w<1||h<1)fail('the source grid is rotated, point-sampled, or invalid.');
    const blockBytes=rasterDecodedBlockBytes(image);if(!Number.isFinite(blockBytes)||blockBytes<=0||blockBytes>MAX_BLOCK)fail('the source decode blocks exceed the safe browser limit.');
    await validateRasterEncodedBlocks(image,{maxBlockBytes:MAX_BLOCK});check(signal);
    // This marker comes only from the authorized server config, never from a
    // saved measurement or a client unit declaration. Actual volume jobs still
    // hash and validate the source independently on the server.
    const candidate=source.reviewedEvidence;
    const reviewed=candidate?.basis==='reviewed-source-provenance'&&candidate.verticalUnit==='m'&&
      candidate.modelId===modelId&&candidate.modelVersionId===modelVersionId&&candidate.url===source.url&&
      candidate.kind===source.type&&candidate.crs===expectedCrs&&candidate.width===w&&candidate.height===h&&
      typeof candidate.assetId==='string'&&candidate.assetId.length>0&&/^[a-f0-9]{64}$/.test(candidate.sha256||'')&&Number.isSafeInteger(candidate.byteSize)&&candidate.byteSize>0;
    let units;
    try{units=resolveRasterVerticalUnits(image,{bandMetadata:await readRasterBandMetadata(image)});}
    catch(error){if(error.code!=='measurement_source_vertical_units_required'||!reviewed)throw error;units={verticalFactor:1,verticalUnitBasis:candidate.basis};}
    if(reviewed&&units.verticalFactor!==1)fail('explicit elevation units conflict with the reviewed source evidence.');
    const {verticalFactor,verticalUnitBasis}=units;check(signal);
    const cells=vertices.map(([e,n])=>[Math.floor((e-ox)/dx),Math.floor((n-oy)/dy)]);
    if(cells.some(([x,y])=>x<0||y<0||x>=w||y>=h))fail('a measurement vertex is outside the elevation coverage.');
    const left=Math.min(...cells.map(p=>p[0])),right=Math.max(...cells.map(p=>p[0]))+1,top=Math.min(...cells.map(p=>p[1])),bottom=Math.max(...cells.map(p=>p[1]))+1,width=right-left,height=bottom-top;
    const cellValues=new Map();
    if(width*height<=MAX_CELLS){
      const values=await image.readRasters({window:[left,top,right,bottom],samples:[0],interleave:true,signal,pool});check(signal);
      if(!values||values.length!==width*height)fail('the elevation window is incomplete.');
      for(const [x,y]of cells)cellValues.set(`${x},${y}`,values[(y-top)*width+x-left]);
    }else{
      // Only vertices need elevations, not the entire polygon interior. Bound
      // output to <=2000 native cells, deduplicate, and cancel between reads.
      for(const [x,y]of cells){
        const key=`${x},${y}`;if(cellValues.has(key))continue;check(signal);
        const values=await image.readRasters({window:[x,y,x+1,y+1],samples:[0],interleave:true,signal,pool});check(signal);
        if(!values||values.length!==1)fail('the elevation window is incomplete.');cellValues.set(key,values[0]);
      }
    }
    const nodata=image.getGDALNoData?.(),missing=nodata===null||nodata===undefined?null:Number(nodata);
    const sampled=vertices.map((p,i)=>{
      const [x,y]=cells[i],raw=Number(cellValues.get(`${x},${y}`));
      if(!Number.isFinite(raw)||(missing!==null&&raw===missing))fail('a vertex has no source elevation; missing data is not zero.');
      const z=raw*verticalFactor;if(!Number.isFinite(z)||Math.abs(z)>1e9)fail('an elevation conversion is invalid or outside the supported coordinate range.');return[p[0],p[1],z];
    });
    return{vertices:sampled,basis:`${source.type.toUpperCase()} native-cell elevations (${verticalUnitBasis}); display only`};
  }finally{await tiff.close();}
}
