// Shared presentation math only. Elevation samples always come from the server.
export function profileLine(vertices, azimuth = 0, offsetPercent = 0) {
  if (!Array.isArray(vertices) || vertices.length < 3 || vertices.length > 256 || vertices.some(p => !Array.isArray(p) || p.length < 2 || !p.slice(0, 2).every(Number.isFinite))) throw new Error('A saved polygon is required for a section.');
  if (!Number.isFinite(azimuth) || !Number.isFinite(offsetPercent)) throw new Error('Invalid section direction or position.');
  const angle = azimuth * Math.PI / 180, direction = [Math.cos(angle), Math.sin(angle)], across = [-direction[1], direction[0]];
  const origin = vertices[0], local = vertices.map(p => [p[0] - origin[0], p[1] - origin[1]]);
  const along = local.map(p => p[0] * direction[0] + p[1] * direction[1]), cross = local.map(p => p[0] * across[0] + p[1] * across[1]);
  const min = Math.min(...along), max = Math.max(...along), low = Math.min(...cross), high = Math.max(...cross);
  const offset = (low + high) / 2 + Math.max(-100, Math.min(100, offsetPercent)) / 100 * (high - low) / 2;
  const at = distance => [origin[0] + direction[0] * distance + across[0] * offset, origin[1] + direction[1] * distance + across[1] * offset];
  if (!(max > min)) throw new Error('The section must have a nonzero length.');
  return {start: at(min), end: at(max)};
}

export function validatePointSamplingGrid(grid) {
  if(!grid||grid.version!==1||!Number.isSafeInteger(grid.width)||grid.width<1||!Number.isSafeInteger(grid.height)||grid.height<1||grid.width*grid.height>2000000||!Number.isFinite(grid.cellSizeM)||grid.cellSizeM<.001||grid.cellSizeM>100||grid.rowOrder!=='north-to-south'||grid.reduction!=='maximum-z'||grid.emptyCells!=='missing'||!['minE','minN','maxE','maxN'].every(k=>Number.isFinite(grid.bounds?.[k]))||grid.bounds.maxE<=grid.bounds.minE||grid.bounds.maxN<=grid.bounds.minN)throw new Error('The point surface is missing a valid sampling grid.');
  return grid;
}
export function validateNativeProfile(result, {line, parentCalculationId, source} = {}) {
  const point=result?.source?.kind==='ept';
  const finitePair = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(b));
  if (result?.method !== 'surface-transect' || result.sampling !== (point?'point-grid-step':'native-cell-step') || !Number.isFinite(result.lengthM) || result.lengthM <= 0 || !finitePair(result.line?.start) || !finitePair(result.line?.end) || !Array.isArray(result.segments) || !result.segments.length || result.segments.length > 20000) throw new Error('The server did not return a bounded elevation profile.');
  if (!near(result.lengthM, Math.hypot(...result.line.start.map((v, i) => result.line.end[i] - v)))) throw new Error('The section length does not match its endpoints.');
  if (line && ['start', 'end'].some(k => !finitePair(line[k]) || line[k].some((v, i) => Math.abs(v - result.line[k][i]) > 1e-6))) throw new Error('The returned section is from a different line.');
  if (parentCalculationId && result.parentCalculationId !== parentCalculationId) throw new Error('The section does not match this volume calculation.');
  if (result.source?.verticalUnit !== 'm' || !/^[a-f0-9]{64}$/i.test(result.source?.sha256 || '') || !result.source?.modelVersionId || !/^[a-f0-9]{64}$/i.test(result.baseHash || '') || !/^EPSG:\d{4,6}$/.test(result.source?.crs || '') || !['dsm','dtm','ept'].includes(result.source?.kind) || typeof result.source.verticalUnitBasis !== 'string' || !result.source.verticalUnitBasis || (!point&&(!finitePair(result.source?.resolutionM)||result.source.resolutionM.some(v=>v<=0))) || !Number.isSafeInteger(result.cellCount) || result.cellCount < 0 || result.cellCount > 20000) throw new Error('The section is missing source or reference-base provenance.');
  if(point){
    validatePointSamplingGrid(result.source.samplingGrid);
    // Presentation validates provenance; the request API enforces authority.
    // Staff-declared heights stay explicitly declared, never relabelled encoded.
    if(result.calculationOrigin!=='server-original-point-surface'||!/^[a-f0-9]{64}$/i.test(result.source.manifestSha256||'')||!['ept-vertical-crs','administrator-declared'].includes(result.source.verticalUnitBasis)||!['all','ground'].includes(result.source.classFilter))throw new Error('The section is missing point-source provenance.');
    if(source&&(['manifestSha256','classFilter','verticalUnitBasis','verticalUnit','crs'].some(k=>source[k]!==result.source[k])||JSON.stringify(source.samplingGrid)!==JSON.stringify(result.source.samplingGrid)))throw new Error('The section uses a different point surface grid or source.');
  }
  if (source && ['assetId', 'sha256', 'modelVersionId', 'kind'].some(k => source[k] !== result.source[k])) throw new Error('The section uses a different elevation source.');
  let previous = 0;const normalized=[];
  for (const [index,s] of result.segments.entries()) {
    const zeroContact=point&&Number.isFinite(s.startM)&&s.startM===s.endM&&s.startM===previous&&s.startM>=0&&s.endM<=result.lengthM&&(index===result.segments.length-1?s.endM===result.lengthM:result.segments[index+1]?.startM===s.endM);
    if (!['sample', 'nodata', point?'outside-surface':'outside-raster', 'outside-selection'].includes(s.status) || !near(s.startM, previous) || (!(s.endM > s.startM)&&!zeroContact) || s.endM > result.lengthM + 1e-6 || !finitePair(s.start) || !finitePair(s.end)) throw new Error('The section contains invalid or missing station intervals.');
    for (const [key, station] of [['start',s.startM],['end',s.endM]]) if(s[key].some((v,i)=>Math.abs(v-(result.line.start[i]+(result.line.end[i]-result.line.start[i])*station/result.lengthM))>1e-6))throw new Error('Section coordinates do not match their station on the requested line.');
    if ((['sample','nodata'].includes(s.status)||s.cell!==undefined) && (!Array.isArray(s.cell)||s.cell.length!==2||!s.cell.every(v=>Number.isSafeInteger(v)&&v>=0)))throw new Error('The section contains invalid native cell indices.');
    if (s.status === 'sample' && ![s.surfaceM, s.baseStartM, s.baseEndM].every(Number.isFinite)) throw new Error('The section contains an invalid elevation sample.');
    // Older point jobs could retain a zero-extent floating-point contact.
    // Validate its provenance, geometry and neighbors before omitting it from
    // presentation; never bridge positive gaps or change the stored result.
    if(!zeroContact)normalized.push(s);
    previous = s.endM;
  }
  if (!near(previous, result.lengthM)) throw new Error('The section is incomplete.');
  return normalized.length===result.segments.length?result:{...result,segments:normalized.map(segment=>structuredClone(segment))};
}

export function profileStation(result, station) {
  if (!result?.segments?.length || !Number.isFinite(station)) return null;
  station = Math.max(0, Math.min(result.lengthM, station));
  let lo = 0, hi = result.segments.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (result.segments[mid].endM <= station) lo = mid + 1; else hi = mid; }
  const segment = result.segments[lo], t = Math.max(0, Math.min(1, (station - segment.startM) / (segment.endM - segment.startM)));
  const base = segment.status === 'sample' ? segment.baseStartM + (segment.baseEndM - segment.baseStartM) * t : null;
  return {index: lo, station, segment, x: segment.start[0] + (segment.end[0] - segment.start[0]) * t, y: segment.start[1] + (segment.end[1] - segment.start[1]) * t, base, difference: base === null ? null : segment.surfaceM - base};
}

// Raw SI values remain unrounded in the export. Quote metadata and prevent CSV
// spreadsheet formulas; display-unit choices do not alter measured coordinates.
const csv = value => { let text = String(value ?? ''); if (typeof value !== 'number' && /^[=+@\-\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
export function exportNativeProfile(result) {
  result=validateNativeProfile(result);
  const header = ['station_start_m', 'station_end_m', 'status', 'surface_m', 'base_start_m', 'base_end_m', 'easting_start_m', 'northing_start_m', 'easting_end_m', 'northing_end_m', 'column', 'row', 'crs', 'vertical_unit_basis', 'vertical_datum', 'model_version', 'source_sha256', 'parent_calculation', 'base_hash'];
  const rows = result.segments.map(s => [s.startM, s.endM, s.status, s.status === 'sample' ? s.surfaceM : '', s.status === 'sample' ? s.baseStartM : '', s.status === 'sample' ? s.baseEndM : '', ...s.start, ...s.end, ...(s.cell || ['', '']), result.source.crs, result.source.verticalUnitBasis, 'unverified', result.source.modelVersionId, result.source.sha256, result.parentCalculationId, result.baseHash]);
  return [header, ...rows].map(row => row.map(csv).join(',')).join('\r\n');
}
