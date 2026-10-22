// Renderer-independent measurement geometry. Coordinates are E/N/Z metres,
// never screen coordinates or a renderer's movable local origin.
export const measurementCollection = mode => ['ortho', 'dsm', 'dtm'].includes(mode) ? 'map' : 'spatial3d';
// Editing uses world-space vertices; screen handles never become coordinates.
export function changeMeasurementVertex(record, {type,index,point}) {
  const vertices=record.vertices.map(p=>p.slice());
  if(!Number.isInteger(index)||index<0||index>=vertices.length)throw new Error('Select a vertex first.');
  if(type==='delete'){
    if(vertices.length<=(record.kind==='polygon'?3:2))throw new Error(record.kind==='polygon'?'A polygon needs at least three points.':'A distance needs at least two points.');
    vertices.splice(index,1);
  }else if(type==='insert'){
    if(vertices.length>=2000)throw new Error('Maximum 2000 vertices.');
    if(record.kind!=='polygon'&&index===vertices.length-1)throw new Error('Select an existing edge.');
    const next=vertices[(index+1)%vertices.length];vertices.splice(index+1,0,vertices[index].map((v,i)=>(v+next[i])/2));
  }else if(type==='move')vertices[index]=point?.slice();
  else throw new Error('Unknown vertex action.');
  const updated={...record,vertices};validateMeasurementGeometry(updated);return vertices;
}
export function measurementEditHandles(record,positions,selected,width,height){
  const midpoints=[];
  for(let i=0;i<(record.kind==='polygon'?positions.length:positions.length-1);i++){
    const a=positions[i],b=positions[(i+1)%positions.length];
    if(a&&b&&Math.hypot(a[0]-b[0],a[1]-b[1])>=44){const x=(a[0]+b[0])/2,y=(a[1]+b[1])/2;if(x>=0&&y>=0&&x<=width&&y<=height)midpoints.push({index:i,x,y});}
  }
  const p=positions[selected];
  const deletion=p&&record.vertices.length>(record.kind==='polygon'?3:2)?{x:Math.max(6,Math.min(width-82,p[0]+20)),y:Math.max(6,Math.min(height-30,p[1]-42)),width:76,height:26}:null;
  return {midpoints,deletion};
}
const length = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
export function measurementMetrics(record) {
  const points = record.vertices;
  if (!Array.isArray(points) || points.some(p => p.length !== 3 || p.some(v => !Number.isFinite(v)))) throw new Error('Invalid measurement coordinates.');
  const closed = record.kind === 'polygon';
  const edges = points.slice(0, closed ? points.length : -1).map((p, i) => length(p, points[(i + 1) % points.length]));
  const horizontalEdges = points.slice(0, closed ? points.length : -1).map((p, i) => Math.hypot(p[0] - points[(i + 1) % points.length][0], p[1] - points[(i + 1) % points.length][1]));
  // Translation before cross products avoids cancellation in large projected coordinates.
  const origin = points[0] || [0, 0, 0], local = points.map(p => p.map((v, i) => v - origin[i]));
  const normal = [0, 0, 0];
  if (closed) for (let i = 0; i < local.length; i++) {
    const a = local[i], b = local[(i + 1) % local.length];
    normal[0] += a[1] * b[2] - a[2] * b[1];
    normal[1] += a[2] * b[0] - a[0] * b[2];
    normal[2] += a[0] * b[1] - a[1] * b[0];
  }
  const magnitude = Math.hypot(...normal);
  const departure = magnitude ? Math.max(...local.map(p => Math.abs(p.reduce((s, v, i) => s + v * normal[i], 0) / magnitude))) : 0;
  return { edgeLengthsM: edges, lengthM: edges.reduce((a, b) => a + b, 0), horizontalLengthM: horizontalEdges.reduce((a, b) => a + b, 0),
    horizontalAreaM2: Math.abs(normal[2]) / 2, planarAreaM2: closed && departure <= 0.001 ? magnitude / 2 : null,
    planarityDepartureM: departure, elevationDifferenceM: points.length ? Math.max(...points.map(p => p[2])) - Math.min(...points.map(p => p[2])) : 0 };
}
export function validateMeasurementGeometry(record) {
  const metrics = measurementMetrics(record), minimum = record.kind === 'polygon' ? 3 : 2;
  if (record.vertices.length < minimum || record.vertices.length > 2000) throw new Error(`Place ${minimum}–2000 vertices.`);
  if (metrics.edgeLengthsM.some(v => v < 1e-8)) throw new Error('Remove repeated adjacent vertices.');
  if (record.kind === 'polygon') {
    const p = record.vertices, axes = [[0, 1], [0, 2], [1, 2]];
    const area = ([x,y]) => Math.abs(p.reduce((s,a,i) => s + (a[x]-p[0][x])*(p[(i+1)%p.length][y]-p[0][y])-(p[(i+1)%p.length][x]-p[0][x])*(a[y]-p[0][y]),0));
    const [x,y] = axes.sort((a,b) => area(b)-area(a))[0];
    if (area([x,y]) < 1e-10) throw new Error('The polygon must enclose an area.');
    const cross = (a,b,c) => (b[x]-a[x])*(c[y]-a[y])-(b[y]-a[y])*(c[x]-a[x]);
    const on = (a,b,c) => Math.abs(cross(a,b,c)) < 1e-10 && c[x]>=Math.min(a[x],b[x])-1e-10 && c[x]<=Math.max(a[x],b[x])+1e-10 && c[y]>=Math.min(a[y],b[y])-1e-10 && c[y]<=Math.max(a[y],b[y])+1e-10;
    for(let i=0;i<p.length;i++) for(let j=i+1;j<p.length;j++) {
      if(j===i+1 || (i===0 && j===p.length-1)) continue;
      const a=p[i],b=p[(i+1)%p.length],c=p[j],d=p[(j+1)%p.length];
      if ((cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0) || on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b)) throw new Error('Polygon edges must not cross or overlap.');
    }
  }
  return metrics;
}
const measurementDecimal = new Intl.NumberFormat('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});
const measurementInteger = new Intl.NumberFormat('en-US',{maximumFractionDigits:0});
export function measurementValue(value, power = 1, units = 'imperial') {
  if (!Number.isFinite(value)) return 'Unavailable';
  const decimal = n => measurementDecimal.format(n);
  const choices = { imperial: [1 / 0.3048, 'ft'], feet: [1 / 0.3048, 'ft'], yards: [1 / 0.9144, 'yd'], metric: [1, 'm'], centimeters: [100, 'cm'] };
  if (power === 1 && units === 'imperial') {
    const total = Math.round(Math.abs(value) / 0.0254 * 1000) / 1000;
    return `${value < 0 ? '−' : ''}${measurementInteger.format(Math.floor(total / 12))}′ ${decimal(total % 12)}″`;
  }
  const [factor, suffix] = choices[units] || choices.imperial;
  return `${decimal(value * factor ** power)} ${suffix}${power === 2 ? '²' : power === 3 ? '³' : ''}`;
}
const csvCell = value => { let s = String(value ?? ''); if (/^[=+@\-\t\r]/.test(s)) s = `'${s}`; return `"${s.replaceAll('"', '""')}"`; };
export function exportMeasurements(records, format, { toLonLat, units = 'imperial' } = {}) {
  const documents = records.map(r => ({ ...r, metrics: measurementMetrics(r) }));
  if (format === 'json') return JSON.stringify({ schemaVersion: 1, coordinateUnits: 'metres', displayUnits: units, measurements: documents }, null, 2);
  if (format === 'csv') {
    const headers=['id','name','collection','crs','length_m','horizontal_area_m2','planar_area_m2','cut_m3','fill_m3','net_m3','method','status','warnings','volume_m3','coverage','source_json','reference_json','provenance_json'];
    const rows=documents.map(r=>{
      const result=r.results||{};
      const provenance={...result.provenance,...Object.fromEntries(['calculationOrigin','verified','calculationJobId','numericalModel','checks'].filter(key=>result[key]!==undefined).map(key=>[key,result[key]]))};
      const source=result.source||(result.sourceKind?{kind:result.sourceKind,resolutionM:result.sourceResolutionM,modelVersionId:result.modelVersionId}:r.source)||{};
      return [r.id,r.name,r.collection,r.coordinateReference.crs,r.metrics.lengthM,r.metrics.horizontalAreaM2,r.metrics.planarAreaM2,result.cutM3,result.fillM3,result.netM3,result.method,result.status,JSON.stringify(result.warnings||[]),result.volumeM3,result.coverage,JSON.stringify(source),JSON.stringify(result.reference||{}),JSON.stringify(provenance)];
    });
    return [headers,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n');
  }
  if (format === 'geojson') {
    if (typeof toLonLat !== 'function') throw new Error('A verified geographic transform is required for GeoJSON.');
    return JSON.stringify({ type:'FeatureCollection', features:documents.map(r => {
      const coordinates=r.vertices.map(p=>{const v=toLonLat(p);if(!v||v.length<2||v.some(n=>!Number.isFinite(n))||Math.abs(v[0])>180||Math.abs(v[1])>90)throw new Error('Geographic coordinates unavailable.');return v.slice(0,2);});
      return {type:'Feature',id:r.id,properties:{name:r.name,sourceCRS:r.coordinateReference.crs,elevationReference:'Source vertical datum; not assumed WGS84 ellipsoid',sourceVertices:r.vertices,metrics:r.metrics,results:r.results},geometry:r.kind==='polygon'?{type:'Polygon',coordinates:[[...coordinates,coordinates[0]]]}:{type:'LineString',coordinates}};
    })},null,2);
  }
  if (format === 'dxf') {
    const lines=['0','SECTION','2','HEADER','9','$INSUNITS','70','6','0','ENDSEC','0','SECTION','2','ENTITIES'];
    for(const r of documents) {
      lines.push('999',`CRS ${r.coordinateReference.crs.replace(/[\r\n]/g,' ')}; measurement ${r.id}`, '0','POLYLINE','8','MEASUREMENTS','66','1','70',r.kind==='polygon'?'9':'8');
      for(const p of r.vertices) lines.push('0','VERTEX','8','MEASUREMENTS','10',String(p[0]),'20',String(p[1]),'30',String(p[2]),'70','32');
      lines.push('0','SEQEND','0','TEXT','8','LABELS','10',String(r.vertices[0][0]),'20',String(r.vertices[0][1]),'30',String(r.vertices[0][2]),'40','0.25','1',r.name.replace(/[\r\n]/g,' '));
    }
    return [...lines,'0','ENDSEC','0','EOF'].join('\r\n');
  }
  throw new Error('Unsupported export format.');
}
