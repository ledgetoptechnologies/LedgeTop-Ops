'use strict';
const PHASES=new Set(['queue','child','point-surface','point-transect','raster-volume','raster-transect']);
const DURATIONS=['queueWaitMs','totalMs','verifiedReadMs','sourceHashMs','decodeGridMs','sampleMs','rasterReadMs'];
const COUNTS=['pointsRead','nodesRead','cellCount','segmentCount','windowReads'];
const MAX_DURATION=366*24*60*60*1000;
function sanitizedMeasurementTiming(value){
  if(!value||!PHASES.has(value.phase))return null;
  const result={phase:value.phase};
  for(const key of DURATIONS)if(Object.hasOwn(value,key))result[key]=typeof value[key]==='number'&&Number.isFinite(value[key])&&value[key]>=0&&value[key]<=MAX_DURATION?Math.round(value[key]*1000)/1000:null;
  for(const key of COUNTS)if(Number.isSafeInteger(value[key])&&value[key]>=0&&value[key]<=1_000_000_000)result[key]=value[key];
  if(typeof value.cacheHit==='boolean')result.cacheHit=value.cacheHit;
  return result;
}
function queueWaitTiming(createdAt,claimedAt,now=Date.now()){
  const iso=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&new Date(Date.parse(value)).toISOString()===value;
  let wait=null;
  try{if(iso(createdAt)&&iso(claimedAt)){const created=Date.parse(createdAt),claimed=Date.parse(claimedAt);if(Number.isFinite(now)&&created<=claimed&&claimed<=now&&claimed-created<=MAX_DURATION)wait=claimed-created;}}catch{}
  return{phase:'queue',queueWaitMs:wait};
}
function readQueueTiming(database,table,id){
  if(!['measurement_calculation_jobs','ephemeral_measurement_jobs'].includes(table))return{phase:'queue',queueWaitMs:null};
  try{const row=database.prepare(`SELECT created_at,updated_at FROM ${table} WHERE id=?`).get(id);return queueWaitTiming(row?.created_at,row?.updated_at);}catch{return{phase:'queue',queueWaitMs:null};}
}
function emitMeasurementTiming(request,value,sink=record=>console.info(JSON.stringify(record))){
  const timing=sanitizedMeasurementTiming(value);if(!timing)return;
  const method=['surface-cut-fill','point-surface-cut-fill','surface-transect','closed-mesh','reconstructed-estimate'].includes(request?.method)?request.method:'unknown';
  const sourceKind=['dsm','dtm','ept','obj'].includes(request?.source?.kind)?request.source.kind:'unknown';
  try{sink({event:'measurement.timing',method,sourceKind,...timing});}catch{} // Diagnostics cannot change calculation success.
}
module.exports={sanitizedMeasurementTiming,queueWaitTiming,readQueueTiming,emitMeasurementTiming};
