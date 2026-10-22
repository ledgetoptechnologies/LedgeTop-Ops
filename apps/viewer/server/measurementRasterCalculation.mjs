import fs from 'node:fs';
import crypto from 'node:crypto';
import { fromFile } from 'geotiff';
import { createSurfaceAccumulator, estimateSurfacePatchWork } from '../measurement-volume.mjs';
import { insideSelection } from './measurementSelection.mjs';
import { rasterDirectoryValue, rasterDecodedBlockBytes, validateRasterEncodedBlocks } from '../raster-source-metadata.mjs';
import { validateMeasurementTiffHeader } from './measurementTiffHeader.mjs';
import { readRasterBandMetadata, resolveRasterVerticalUnits } from '../raster-vertical-units.mjs';
import { reviewedRasterUnitEvidence } from './measurementUnitEvidence.mjs';
import { createDelaunayReference } from './measurementDelaunayReference.mjs';
const fail = code => { throw Object.assign(new Error(code), { code }); };
export const NATIVE_RASTER_BLOCK_LIMIT = 256 * 1024 * 1024;
export function nativeRasterDefinition(image, request, { maxBlockBytes = NATIVE_RASTER_BLOCK_LIMIT, bandMetadata = null } = {}) {
  const keys = image.getGeoKeys(), directory = image.getFileDirectory?.() || image.fileDirectory, epsg = Number(String(request.coordinateReference.crs).replace(/^EPSG:/i, ''));
  const rasterCrs = Number(keys.ProjectedCSTypeGeoKey), metres = keys.ProjLinearUnitsGeoKey !== undefined ? Number(keys.ProjLinearUnitsGeoKey) === 9001 : ((rasterCrs >= 32601 && rasterCrs <= 32660)||(rasterCrs>=32701&&rasterCrs<=32760));
  if (!metres || rasterCrs !== epsg) fail('measurement_source_crs_mismatch');
  if (Number(keys.GTRasterTypeGeoKey || 1) !== 1) fail('measurement_pixel_is_point_unsupported');
  const staffDeclaration=request.authority?.adminHash&&!request.authority.scope;
  const evidence=reviewedRasterUnitEvidence(request,image);
  const explicitEvidence=evidence?.basis==='server-inspected-explicit-metadata';
  let units;
  try { units=resolveRasterVerticalUnits(image,{bandMetadata,confirmMeters:!explicitEvidence&&request.sourceVerticalUnit==='m',confirmationBasis:staffDeclaration?'administrator-declared':'requester-declared'}); }
  catch(error) {
    if(error.code!=='measurement_source_vertical_units_required'||!evidence||explicitEvidence)throw error;
    units={verticalFactor:1,verticalUnitBasis:evidence.basis};
  }
  // A reviewed metre source never silently overrides conflicting explicit units.
  if(evidence&&units.verticalFactor!==(explicitEvidence?evidence.verticalFactor:1))fail('measurement_source_vertical_units_conflict');
  if(evidence&&['requester-declared','administrator-declared'].includes(units.verticalUnitBasis))units.verticalUnitBasis=evidence.basis;
  const {verticalFactor,verticalUnitBasis}=units;
  const transform = rasterDirectoryValue(directory, 'ModelTransformation');
  if (transform && [1,2,4,6,8,9,12,13,14].some(i => transform[i] !== 0)) fail('measurement_rotated_raster_unsupported');
  const [ox, oy] = image.getOrigin(), [dx, dy] = image.getResolution();
  if (![ox, oy, dx, dy].every(Number.isFinite) || dx <= 0 || dy >= 0) fail('measurement_raster_transform_unsupported');
  const blockBytes = rasterDecodedBlockBytes(image);
  const limit = Math.min(maxBlockBytes, NATIVE_RASTER_BLOCK_LIMIT);
  if (!Number.isFinite(blockBytes) || blockBytes <= 0 || blockBytes > limit) fail('measurement_raster_block_too_large');
  // Corrupt or unusually inefficient encoded blocks must not bypass the
  // decoded-memory bound when the TIFF source allocates its input buffer.
  // V3 encoded-count arrays may be lazy: native callers await their bounded
  // validation separately. Plain fixture dictionaries remain synchronous.
  const encodedCounts = typeof directory.getValue === 'function' ? [] : (directory.TileByteCounts || directory.StripByteCounts || []);
  for (const count of typeof encodedCounts === 'number' ? [encodedCounts] : encodedCounts) {
    if (!Number.isFinite(Number(count)) || Number(count) <= 0 || Number(count) > limit) fail('measurement_raster_block_too_large');
  }
  return { ox, oy, dx, dy, crs: `EPSG:${rasterCrs}`, verticalUnit: 'm', verticalFactor, verticalUnitBasis, ...(evidence?{verticalUnitEvidence:evidence}:{}), blockBytes, width: image.getWidth(), height: image.getHeight() };
}
// Header-only preflight never reads/decompresses pixel blocks. Source hashes and
// live authority are checked again by the isolated worker before integration.
export async function preflightNativeRaster(absolutePath, request, options = {}) {
  const stat = await fs.promises.stat(absolutePath);
  if (!stat.isFile() || stat.size !== Number(request.source.byteSize)) fail('measurement_source_changed');
  await validateMeasurementTiffHeader(absolutePath);
  const tiff = await fromFile(absolutePath);
  try { const image=await tiff.getImage(0),definition=nativeRasterDefinition(image, request, {...options,bandMetadata:await readRasterBandMetadata(image)});await validateRasterEncodedBlocks(image,{maxBlockBytes:Math.min(options.maxBlockBytes || NATIVE_RASTER_BLOCK_LIMIT,NATIVE_RASTER_BLOCK_LIMIT)});return definition; }
  finally { await tiff.close(); }
}
export async function calculateNativeRaster(absolutePath, request, { signal, maxCells = 100_000_000, maxBlockBytes = NATIVE_RASTER_BLOCK_LIMIT, windowSize = 512, onProgress = () => {}, onTiming = () => {} } = {}) {
  const started=performance.now();let rasterReadMs=0,windowReads=0;
  // Large outlines remain native resolution. Only a bounded window (at most
  // 2 MiB of normalized Float64 samples) is resident during integration.
  if(!Number.isInteger(windowSize)||windowSize<1||windowSize>512)fail('measurement_limit');
  if(!Number.isSafeInteger(maxCells)||maxCells<1)fail('measurement_limit');
  maxCells=Math.min(maxCells,100_000_000);
  const check = () => { if (signal?.aborted) fail('measurement_cancelled'); };
  const sourceStat = await fs.promises.stat(absolutePath);
  if (!sourceStat.isFile() || sourceStat.size !== Number(request.source.byteSize)) fail('measurement_source_changed');
  // Hashed imported assets are immutable by contract; verify that contract before
  // reading, then compare inode/size/mtime after integration as a second guard.
  const hashStarted=performance.now(),hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(absolutePath, { highWaterMark: 1024 * 1024, signal })) { check(); hash.update(chunk); }
  if (hash.digest('hex') !== request.source.sha256) fail('measurement_source_changed');
  const sourceHashMs=performance.now()-hashStarted,samplingStarted=performance.now();
  await validateMeasurementTiffHeader(absolutePath);
  const tiff = await fromFile(absolutePath);
  try {
    const image = await tiff.getImage(0), definition = nativeRasterDefinition(image, request, { maxBlockBytes,bandMetadata:await readRasterBandMetadata(image) }), { ox, oy, dx, dy, width, height } = definition;
    await validateRasterEncodedBlocks(image,{maxBlockBytes:Math.min(maxBlockBytes,NATIVE_RASTER_BLOCK_LIMIT)});
    const xs = request.vertices.map(p => p[0]), ys = request.vertices.map(p => p[1]);
    const left = Math.max(0, Math.floor((Math.min(...xs) - ox) / dx)), right = Math.min(width, Math.ceil((Math.max(...xs) - ox) / dx));
    const top = Math.max(0, Math.floor((Math.max(...ys) - oy) / dy)), bottom = Math.min(height, Math.ceil((Math.min(...ys) - oy) / dy));
    const cells = Math.max(0, right - left) * Math.max(0, bottom - top);
    if (cells > maxCells) fail('measurement_limit');
    let vertices=request.vertices;
    // The calculation source, not the view used to draw the outline, defines
    // the base heights. Mesh/point picks may be a different LOD or surface.
    if(request.reference?.type!=='custom'){
      vertices=[];
      for(const [e,n]of request.vertices){
        const x=Math.floor((e-ox)/dx),y=Math.floor((n-oy)/dy);
        if(x<0||y<0||x>=width||y>=height)fail('measurement_boundary_elevation_unavailable');
        const readStarted=performance.now(),values=await image.readRasters({window:[x,y,x+1,y+1],samples:[0],interleave:true,signal}),z=Number(values[0]),nodata=image.getGDALNoData();rasterReadMs+=performance.now()-readStarted;windowReads++;
        if(!Number.isFinite(z)||(nodata!=null&&z===Number(nodata)))fail('measurement_boundary_elevation_unavailable');
        vertices.push([e,n,z * definition.verticalFactor]);
      }
    }
    const referenceBase=(!request.reference?.type||request.reference.type==='boundary-triangulated')?createDelaunayReference(vertices,request.reference):undefined;
    const accumulator = createSurfaceAccumulator({ vertices, reference: request.reference, referenceBase, spatialPatchCulling:true, maxCells, maxWork: 1_000_000_000 });
    if(cells&&estimateSurfacePatchWork(accumulator.reference.patches,{width:right-left,height:bottom-top,bounds:{minE:ox+left*dx,maxE:ox+right*dx,maxN:oy+top*dy,minN:oy+bottom*dy}})>1_000_000_000)fail('measurement_limit');
    let processed = 0;
    const previewSamples = [], previewStride = Math.max(1, Math.ceil(cells / 4096));
    for (let row = top; row < bottom; row += windowSize) for (let col = left; col < right; col += windowSize) {
      check();
      const r = Math.min(right, col + windowSize), b = Math.min(bottom, row + windowSize);
      const readStarted=performance.now(),values = await image.readRasters({ window: [col, row, r, b], samples: [0], interleave: true, signal });rasterReadMs+=performance.now()-readStarted;windowReads++;
      const rawNodata = image.getGDALNoData();
      for(let y=0;y<b-row;y++)for(let x=0;x<r-col;x++){
        const index=(row+y-top)*(right-left)+(col+x-left),z=Number(values[y*(r-col)+x]);
        if(index%previewStride||previewSamples.length>=4096||!Number.isFinite(z)||(rawNodata!=null&&z===Number(rawNodata)))continue;
        const e=ox+(col+x+.5)*dx,n=oy+(row+y+.5)*dy,baseZ=accumulator.reference.sample(e,n);
        if(Number.isFinite(baseZ)&&insideSelection(e,n,vertices))previewSamples.push([e,n,z * definition.verticalFactor,baseZ]);
      }
      // Convert into Float64 to avoid truncating fractional metres for integer
      // source rasters, and recognize NoData before converting unit values.
      const metricValues = Float64Array.from(values, v => rawNodata != null && Number(v) === Number(rawNodata) ? NaN : Number(v) * definition.verticalFactor);
      accumulator.addGrid({ values: metricValues, width: r - col, height: b - row, bounds: { minE: ox + col * dx, maxE: ox + r * dx, maxN: oy + row * dy, minN: oy + b * dy }, nodata: NaN });
      processed += (r - col) * (b - row); onProgress(processed / Math.max(1, cells));
      // Let abort, memory guards, and heartbeats execute between bounded reads.
      await new Promise(resolve => setImmediate(resolve));
    }
    check();
    const finalStat = await fs.promises.stat(absolutePath);
    if (['size','ino','dev','mtimeMs','ctimeMs'].some(k => sourceStat[k] !== finalStat[k])) fail('measurement_source_changed');
    const result = { ...accumulator.result(), ...(request.reference?.type!=='custom'?{boundaryVertices:vertices}: {}) };
    const declaredBy=definition.verticalUnitBasis==='administrator-declared'?'requesting administrator':definition.verticalUnitBasis==='requester-declared'?'requester':null;
    try{onTiming({phase:'raster-volume',sourceHashMs,rasterReadMs,sampleMs:Math.max(0,performance.now()-samplingStarted-rasterReadMs),totalMs:performance.now()-started,cellCount:cells,windowReads});}catch{}
    return { ...result, calculationOrigin: 'server-native-raster', preview:{previewOnly:true,samples:previewSamples,referencePatches:accumulator.reference.patches.map(patch=>patch.polygon.map(p=>[p[0],p[1],patch.sample(p[0],p[1])]))}, source: { assetId: request.source.id, kind: request.source.kind, sha256: request.source.sha256, modelVersionId: request.modelVersionId, resolutionM: [dx, -dy], crs: definition.crs, verticalUnit: definition.verticalUnit, verticalUnitBasis: definition.verticalUnitBasis, ...(definition.verticalUnitEvidence?{verticalUnitEvidence:definition.verticalUnitEvidence}:{}), boundaryElevationBasis:request.reference?.type==='custom'?'custom-reference':'native-raster' }, warnings: [...result.warnings, ...(declaredBy ? [`Raster vertical units were declared as metres by the ${declaredBy}; they were not encoded in the raster or independently verified by this calculation.`] : [])] };
  } finally { await tiff.close(); }
}
