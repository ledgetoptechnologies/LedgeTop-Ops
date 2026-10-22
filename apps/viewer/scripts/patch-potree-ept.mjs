import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const sharedNode='new Potree.PointCloudCopcGeometryNode(geometry)';
const nonexistentNode='new Potree.PointCloudEptGeometryNode(geometry)';
const releasedEptWorkerRoute="let workerPath = Potree.scriptPath +\n\t\t\t\t'/workers/EptLaszipDecoderWorker.js';";
const patchedEptWorkerRoute="let workerPath = Potree.scriptPath +\n\t\t\t\t(isFullFile ? '/workers/EptLazRsDecoderWorker.js' : '/workers/EptLaszipDecoderWorker.js');";
const releasedWorkerFactory='let worker = new Worker(url);';
const patchedWorkerFactory='let worker = new Worker(url, url.endsWith("/EptLazRsDecoderWorker.js") ? {type: "module"} : undefined);';
const releasedDecodedPointCount='\t\t\t\t\tpointCount,\n\t\t\t\t\tnew Vector3(...e.data.mean));';
const patchedDecodedPointCount='\t\t\t\t\tNumber.isSafeInteger(e.data.pointCount) && e.data.pointCount > 0 ? e.data.pointCount : pointCount,\n\t\t\t\t\tnew Vector3(...e.data.mean));';

export function patchPotreeEptSource(source){
  const start=source.indexOf('class EptLoader');
  const end=source.indexOf('class CopcLoader',start+1);
  if(start<0||end<=start)throw new Error('pinned Potree EPT/COPC loader boundaries changed');
  const block=source.slice(start,end),copcBlock=source.slice(end);
  const sharedCount=block.split(sharedNode).length-1,nonexistentCount=block.split(nonexistentNode).length-1;
  if(!copcBlock.includes(sharedNode))throw new Error('pinned Potree COPC loader signature changed');
  // Potree 1.8.2 deliberately shares PointCloudCopcGeometryNode between COPC
  // and EPT. PointCloudEptGeometryNode is not exported by this release; using
  // it crashes in the iframe before EPT metadata can finish loading.
  if(sharedCount===1&&nonexistentCount===0)return source;
  if(sharedCount===0&&nonexistentCount===1){
    return source.slice(0,start)+block.replace(nonexistentNode,sharedNode)+source.slice(end);
  }
  throw new Error('pinned Potree EPT loader signature changed');
}

export function patchPotreeEptWorkerRoute(source){
  const releasedCount=source.split(releasedEptWorkerRoute).length-1;
  const patchedCount=source.split(patchedEptWorkerRoute).length-1;
  if(releasedCount===0&&patchedCount===1)return source;
  if(releasedCount===1&&patchedCount===0)return source.replace(releasedEptWorkerRoute,patchedEptWorkerRoute);
  throw new Error('pinned Potree EPT worker route signature changed');
}

export function patchPotreeEptWorkerFactory(source){
  const releasedCount=source.split(releasedWorkerFactory).length-1;
  const patchedCount=source.split(patchedWorkerFactory).length-1;
  if(releasedCount===0&&patchedCount===1)return source;
  if(releasedCount===1&&patchedCount===0)return source.replace(releasedWorkerFactory,patchedWorkerFactory);
  throw new Error('pinned Potree worker factory signature changed');
}

export function patchPotreeEptDecodedPointCount(source){
  const releasedCount=source.split(releasedDecodedPointCount).length-1;
  const patchedCount=source.split(patchedDecodedPointCount).length-1;
  if(releasedCount===0&&patchedCount===1)return source;
  if(releasedCount===1&&patchedCount===0)return source.replace(releasedDecodedPointCount,patchedDecodedPointCount);
  throw new Error('pinned Potree EPT decoded point-count signature changed');
}

export function patchPotreeVisibilitySelection(source){
  const start=source.indexOf('function updateVisibility(pointclouds, camera, renderer){');
  const end=source.indexOf('\n\tclass PointCloudArena4DNode',start);
  if(start<0||end<=start)throw new Error('pinned Potree visibility boundaries changed');
  let block=source.slice(start,end);
  const replacements=[
    ['\t\tlet loadedToGPUThisFrame = 0;',
      '\t\tlet loadedToGPUThisFrame = 0;\n\t\t// LTDS: per-frame, spatially eligible demand; never a requested-budget override.\n\t\tfor (const pc of pointclouds) pc.ltdsBudgetDemand = { requiredPoints: 0, drawnPoints: 0, pending: false };'],
    ['\t\t\tvisible = visible && !(numVisiblePoints + node.getNumPoints() > Potree.pointBudget);',
      '\t\t\t// LTDS: apply global budget after spatial and clipping eligibility.'],
    ['\t\t\tvisible = visible && !(numVisiblePointsInPointclouds.get(pointcloud) + node.getNumPoints() > pointcloud.pointBudget);',
      '\t\t\t// LTDS: apply per-cloud budget after spatial and clipping eligibility.'],
    ['\t\t\tvisible = visible || node.getLevel() <= 2;',
      '\t\t\t// LTDS: coarse nodes obey the same frustum and point-budget bounds.'],
    ['\t\t\tif (numVisiblePoints + node.getNumPoints() > Potree.pointBudget) {\n\t\t\t\tbreak;\n\t\t\t}',
      '\t\t\t// LTDS: skip an ineligible additive subtree, not the remaining siblings.\n\t\t\tif (!visible) continue;\n\t\t\tif (numVisiblePointsInPointclouds.get(pointcloud) + node.getNumPoints() > pointcloud.pointBudget) continue;\n\t\t\tif (numVisiblePoints + node.getNumPoints() > Potree.pointBudget) {\n\t\t\t\tconst demand = pointcloud.ltdsBudgetDemand, required = numVisiblePoints + node.getNumPoints();\n\t\t\t\tdemand.requiredPoints = demand.requiredPoints ? Math.min(demand.requiredPoints, required) : required;\n\t\t\t\tcontinue;\n\t\t\t}'],
    ['\t\t\tif (node.isTreeNode()) {\n\t\t\t\texports.lru.touch(node.geometryNode);',
      '\t\t\t// LTDS: loading and not-yet-uploaded selections cannot justify a density probe.\n\t\t\tif (node.isTreeNode()) pointcloud.ltdsBudgetDemand.drawnPoints += node.getNumPoints();\n\t\t\telse pointcloud.ltdsBudgetDemand.pending = true;\n\t\t\tif (node.isTreeNode()) {\n\t\t\t\texports.lru.touch(node.geometryNode);'],
  ];
  for(const [released,patched]of replacements){
    const oldCount=block.split(released).length-1,newCount=block.split(patched).length-1;
    if(oldCount===1&&newCount===0)block=block.replace(released,patched);
    else if(newCount!==1||oldCount!==patched.split(released).length-1)throw new Error('pinned Potree visibility selection signature changed');
  }
  return source.slice(0,start)+block+source.slice(end);
}

function replaceFile(file,patcher){
  const source=fs.readFileSync(file,'utf8'),patched=patcher(source);
  if(patched===source)return;
  const temporary=`${file}.patched-${process.pid}`;
  fs.writeFileSync(temporary,patched,{mode:fs.statSync(file).mode});
  fs.renameSync(temporary,file);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const bundleFile=process.argv[2];
  if(!bundleFile)throw new Error('Potree bundle path is required');
  replaceFile(bundleFile,(source)=>patchPotreeVisibilitySelection(patchPotreeEptDecodedPointCount(patchPotreeEptWorkerFactory(patchPotreeEptWorkerRoute(patchPotreeEptSource(source))))));
}
