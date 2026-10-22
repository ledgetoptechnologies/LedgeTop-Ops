import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { readSelectedObj, validateClosedMesh } from './measurementMeshCalculation.mjs';
import { calculatePointSurface } from './measurementPointSurface.mjs';
import { insideSelection } from './measurementSelection.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],distance2=(a,b)=>a.reduce((s,v,k)=>s+(v-b[k])**2,0);
export function pointTree(points){
  function build(indices,depth=0){if(!indices.length)return null;const axis=depth%3;indices.sort((a,b)=>points[a][axis]-points[b][axis]||a-b);const middle=Math.floor(indices.length/2);return{index:indices[middle],axis,left:build(indices.slice(0,middle),depth+1),right:build(indices.slice(middle+1),depth+1)};}
  const root=build(points.map((_,i)=>i));
  return {nearest(point,count=1,radius=Infinity){const best=[],maximum=radius*radius;function visit(node){if(!node)return;const p=points[node.index],d=distance2(point,p);if(d<=maximum){let i=best.findIndex(v=>v.distance2>d);if(i<0)i=best.length;best.splice(i,0,{index:node.index,distance2:d});if(best.length>count)best.pop();}const delta=point[node.axis]-p[node.axis],first=delta<0?node.left:node.right,second=delta<0?node.right:node.left;visit(first);if(delta*delta<=(best.length<count?maximum:Math.min(maximum,best.at(-1).distance2)))visit(second);}visit(root);return best;}};
}
function smallestEigenvector(matrix){
  const a=matrix.map(row=>[...row]),v=[[1,0,0],[0,1,0],[0,0,1]];
  for(let iteration=0;iteration<24;iteration++){let p=0,q=1;for(const[i,j]of[[0,2],[1,2]])if(Math.abs(a[i][j])>Math.abs(a[p][q])){p=i;q=j;}if(Math.abs(a[p][q])<1e-16)break;const angle=.5*Math.atan2(2*a[p][q],a[q][q]-a[p][p]),c=Math.cos(angle),s=Math.sin(angle),app=a[p][p],aqq=a[q][q],apq=a[p][q];a[p][p]=c*c*app-2*s*c*apq+s*s*aqq;a[q][q]=s*s*app+2*s*c*apq+c*c*aqq;a[p][q]=a[q][p]=0;for(let k=0;k<3;k++){if(k!==p&&k!==q){const akp=a[k][p],akq=a[k][q];a[k][p]=a[p][k]=c*akp-s*akq;a[k][q]=a[q][k]=s*akp+c*akq;}const vkp=v[k][p],vkq=v[k][q];v[k][p]=c*vkp-s*vkq;v[k][q]=s*vkp+c*vkq;}}
  const order=[0,1,2].sort((i,j)=>a[i][i]-a[j][j]);if(!(a[order[1]][order[1]]>Math.max(1e-16,a[order[2]][order[2]]*1e-7)))fail('measurement_reconstruction_normals_unstable');return v.map(row=>row[order[0]]);
}
export function prepareOrientedPoints(input,{seed,normalRadiusM}){
  if(!Array.isArray(input)||input.length<50||input.length>100_000||!Number.isFinite(normalRadiusM)||normalRadiusM<=0||normalRadiusM>100)fail('measurement_reconstruction_input_limit');
  const seen=new Set(),points=[];for(const p of input){if(!Array.isArray(p)||p.length!==3||!p.every(Number.isFinite))fail('measurement_reconstruction_input_invalid');const key=p.join(',');if(!seen.has(key)){seen.add(key);points.push(p);}}
  if(points.length<50)fail('measurement_reconstruction_input_limit');
  const tree=pointTree(points),neighbors=points.map(p=>tree.nearest(p,25,normalRadiusM).map(n=>n.index));
  const first=tree.nearest(seed)[0].index,indices=[first],included=new Set(indices);for(let i=0;i<indices.length;i++)for(const j of neighbors[indices[i]])if(!included.has(j)){included.add(j);indices.push(j);}
  if(indices.length<50)fail('measurement_reconstruction_seed_component_too_small');
  const normals=new Map();for(const i of indices){const neighborhood=neighbors[i].filter(j=>included.has(j));if(neighborhood.length<6)fail('measurement_reconstruction_normal_radius_too_small');const mean=[0,1,2].map(k=>neighborhood.reduce((sum,j)=>sum+points[j][k],0)/neighborhood.length),matrix=[[0,0,0],[0,0,0],[0,0,0]];for(const j of neighborhood){const p=points[j].map((x,k)=>x-mean[k]);for(let a=0;a<3;a++)for(let b=0;b<3;b++)matrix[a][b]+=p[a]*p[b];}normals.set(i,smallestEigenvector(matrix));}
  const oriented=new Set([first]),pending=[first];for(let at=0;at<pending.length;at++){const i=pending[at];for(const j of neighbors[i]){if(!included.has(j)||oriented.has(j))continue;if(dot(normals.get(i),normals.get(j))<0)normals.set(j,normals.get(j).map(v=>-v));oriented.add(j);pending.push(j);}}
  const selected=indices.map(i=>points[i]),center=[0,1,2].map(k=>selected.reduce((sum,p)=>sum+p[k],0)/selected.length),sign=indices.reduce((sum,i)=>sum+dot(normals.get(i),points[i].map((v,k)=>v-center[k])),0)<0?-1:1;
  return{points:selected.map(p=>p.map((v,k)=>v-center[k])),normals:indices.map(i=>normals.get(i).map(v=>v*sign)),origin:center,sourcePointCount:input.length,uniquePointCount:points.length,selectedPointCount:indices.length,excludedDisconnectedPoints:points.length-indices.length,normalRadiusM,normalMethod:'24-neighbor PCA with seeded connectivity and consistent orientation'};
}
export function parsePoissonPly(text){
  const lines=text.split(/\r?\n/),end=lines.indexOf('end_header');if(lines[0]!=='ply'||!lines.includes('format ascii 1.0')||end<0||end>100)fail('measurement_reconstruction_output_invalid');
  let vertexCount=0,faceCount=0,section=null;const properties=[];
  for(const line of lines.slice(0,end)){const parts=line.trim().split(/\s+/);if(parts[0]==='element'){section=parts[1];if(section==='vertex')vertexCount=Number(parts[2]);else if(section==='face')faceCount=Number(parts[2]);else fail('measurement_reconstruction_output_invalid');}else if(parts[0]==='property'&&section==='vertex'){if(parts[1]==='list')fail('measurement_reconstruction_output_invalid');properties.push(parts[2]);}}
  if(!Number.isSafeInteger(vertexCount)||vertexCount<4||vertexCount>200_000||!Number.isSafeInteger(faceCount)||faceCount<4||faceCount>200_000||['x','y','z'].some(k=>!properties.includes(k)))fail('measurement_reconstruction_output_limit');
  const vertices=[];for(let i=0;i<vertexCount;i++){const values=lines[end+1+i]?.trim().split(/\s+/).map(Number);if(!values||values.length!==properties.length||!values.every(Number.isFinite))fail('measurement_reconstruction_output_invalid');vertices.push(['x','y','z'].map(k=>values[properties.indexOf(k)]));}
  const triangles=[];for(let i=0;i<faceCount;i++){const values=lines[end+1+vertexCount+i]?.trim().split(/\s+/).map(Number);if(values?.length!==4||values[0]!==3||!values.slice(1).every(v=>Number.isSafeInteger(v)&&v>=0&&v<vertexCount))fail('measurement_reconstruction_output_invalid');triangles.push(values.slice(1));}
  return{vertices,triangles};
}
export function validateReconstructionBounds(mesh,request,origin=[0,0,0]){
  const polygon=request.vertices,selection=request.selection;if(!polygon||!Number.isFinite(selection?.minElevationM)||!Number.isFinite(selection?.maxElevationM))fail('measurement_reconstruction_selection_required');
  const points=mesh.vertices.map(p=>p.map((v,k)=>v+origin[k]));
  for(const p of points)if(p[2]<selection.minElevationM-1e-8||p[2]>selection.maxElevationM+1e-8||!insideSelection(p[0],p[1],polygon))fail('measurement_reconstruction_outside_selection');
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const checked=new Set();
  for(const face of mesh.triangles)for(let i=0;i<3;i++){
    const ids=[face[i],face[(i+1)%3]].sort((a,b)=>a-b),key=ids.join(',');if(checked.has(key))continue;checked.add(key);
    const a=points[ids[0]],b=points[ids[1]];if(!insideSelection((a[0]+b[0])/2,(a[1]+b[1])/2,polygon))fail('measurement_reconstruction_outside_selection');
    for(let j=0;j<polygon.length;j++){const c=polygon[j],d=polygon[(j+1)%polygon.length],abC=cross(a,b,c),abD=cross(a,b,d),cdA=cross(c,d,a),cdB=cross(c,d,b);if(abC*abD< -1e-16&&cdA*cdB< -1e-16)fail('measurement_reconstruction_outside_selection');}
  }
}
function runPoisson(binary,input,output,scratch,depth,{signal,memoryMiB=4096}={}){
  return new Promise((resolve,reject)=>{
    const args=['--in',input,'--out',output,'--depth',String(depth),'--fullDepth',String(Math.min(5,depth)),'--scale','1.1','--samplesPerNode','1.5','--pointWeight','2','--iters','8','--maxMemory','3','--ascii','--tempDir',scratch];
    const child=spawn(binary,args,{windowsHide:true,stdio:'ignore',env:{...process.env,OMP_NUM_THREADS:'2'}});let settled=false;
    const stop=code=>{if(settled)return;settled=true;clearInterval(memoryTimer);clearTimeout(deadline);signal?.removeEventListener('abort',abort);child.kill('SIGKILL');reject(Object.assign(new Error(code),{code}));};
    const abort=()=>stop('measurement_cancelled');signal?.addEventListener('abort',abort,{once:true});
    const memoryTimer=setInterval(()=>{if(process.platform==='linux'&&child.pid){try{const rss=Number(fs.readFileSync(`/proc/${child.pid}/status`,'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1])*1024+process.memoryUsage().rss;if(rss>memoryMiB*1024*1024)stop('measurement_memory_limit');}catch{}}},500);
    const deadline=setTimeout(()=>stop('measurement_timeout'),240_000);
    child.on('error',()=>stop('measurement_reconstruction_unavailable'));
    child.on('exit',(code)=>{if(settled)return;if(code!==0)return stop('measurement_reconstruction_failed');settled=true;clearInterval(memoryTimer);clearTimeout(deadline);signal?.removeEventListener('abort',abort);resolve();});
    if(signal?.aborted)abort();
  });
}
export async function reconstructPoints(points,request,{binary=process.env.MEASUREMENT_POISSON_BIN||'/opt/poisson/PoissonRecon',signal,scratchRoot=os.tmpdir(),memoryMiB=4096}={}){
  const settings=request.reconstruction;if(!settings?.acknowledgeInferredGeometry)fail('measurement_reconstruction_acknowledgement_required');
  if(!Number.isInteger(settings.depth)||settings.depth<6||settings.depth>9||!Number.isFinite(settings.supportDistanceM)||settings.supportDistanceM<=0||settings.supportDistanceM>100)fail('measurement_reconstruction_settings_invalid');
  const oriented=prepareOrientedPoints(points,{seed:request.selection.seed,normalRadiusM:settings.normalRadiusM}),scratch=await fs.promises.mkdtemp(path.join(scratchRoot,'viewer-reconstruction-'));
  try{
    const input=path.join(scratch,'points.ply'),output=path.join(scratch,'estimated.ply');
    const header=`ply\nformat ascii 1.0\nelement vertex ${oriented.points.length}\nproperty double x\nproperty double y\nproperty double z\nproperty double nx\nproperty double ny\nproperty double nz\nend_header\n`;
    await fs.promises.writeFile(input,header+oriented.points.map((p,i)=>[...p,...oriented.normals[i]].join(' ')).join('\n')+'\n',{flag:'wx',signal});
    await runPoisson(binary,input,output,scratch,settings.depth,{signal,memoryMiB});
    const stat=await fs.promises.stat(output);if(!stat.isFile()||stat.size>32*1024*1024)fail('measurement_reconstruction_output_limit');
    const parsed=parsePoissonPly(await fs.promises.readFile(output,'utf8')),validated=validateClosedMesh(parsed);validateReconstructionBounds(validated,request,oriented.origin);
    const tree=pointTree(oriented.points),distances=validated.vertices.map(p=>Math.sqrt(tree.nearest(p)[0].distance2)),unsupported=distances.map(d=>d>settings.supportDistanceM);
    let unsupportedArea=0,totalArea=0;for(const t of validated.triangles){const[a,b,c]=t.map(i=>validated.vertices[i]),u=b.map((v,k)=>v-a[k]),v=c.map((v,k)=>v-a[k]),area=Math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])/2;totalArea+=area;if(t.some(i=>unsupported[i]))unsupportedArea+=area;}
    const stride=Math.max(1,Math.ceil(validated.triangles.length/10000)),triangles=validated.triangles.filter((_,i)=>i%stride===0),used=[...new Set(triangles.flat())],indices=new Map(used.map((v,i)=>[v,i])),sorted=[...distances].sort((a,b)=>a-b);
    return{method:'reconstructed-estimate',status:'estimate',volumeM3:validated.volumeM3,surfaceAreaM2:validated.surfaceAreaM2,calculationOrigin:'server-reconstructed-estimate',checks:validated.checks,source:{assetId:request.source.id,sha256:request.source.sha256,manifestSha256:request.source.manifestSha256,modelVersionId:request.modelVersionId},reconstruction:{...settings,engine:'PoissonRecon',engineVersion:'18.76',sourceCommit:'262b0f539d404057d1f36e1adc07fc9388678899',precision:'double',threads:2,normalMethod:oriented.normalMethod,selectedPointCount:oriented.selectedPointCount,excludedDisconnectedPoints:oriented.excludedDisconnectedPoints},support:{thresholdM:settings.supportDistanceM,unsupportedAreaFraction:unsupportedArea/totalArea,nearestSourceDistanceM:{p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],max:sorted.at(-1)},meaning:'Proximity to source samples only; not proof that a generated surface was observed.'},selection:request.selection,sourceCoordinateFrame:request.sourceCoordinateFrame||'projected',preview:{previewOnly:true,inferred:true,vertices:used.map(i=>validated.vertices[i].map((v,k)=>v+oriented.origin[k])),triangles:triangles.map(t=>t.map(i=>indices.get(i))),inferredVertices:used.map(i=>unsupported[i]),supportDistancesM:used.map(i=>distances[i])},warnings:['ESTIMATE: Every reconstructed face is inferred geometry, including faces close to observed samples.','Screened Poisson reconstruction may bridge holes, infer an unseen underside, smooth edges, or change object shape. This is not a validated observed-object volume.','The support overlay marks distance from source samples; nearby samples do not prove physical accuracy.']};
  }finally{const resolved=path.resolve(scratch);if(resolved.startsWith(path.resolve(scratchRoot)+path.sep)&&path.basename(resolved).startsWith('viewer-reconstruction-'))await fs.promises.rm(resolved,{recursive:true,force:true});}
}
export async function reconstructSelectedObj(absolutePath,request,options={}){const selected=await readSelectedObj(absolutePath,request,options),used=[...new Set(selected.triangles.flat())];return reconstructPoints(used.map(i=>selected.vertices[i]),request,options);}
export async function reconstructSelectedEpt(absolutePath,request,options={}){const selected=await calculatePointSurface(absolutePath,request,{...options,collectOnly:true});const result=await reconstructPoints(selected.points,request,options);result.source.pointsRead=selected.pointsRead;result.source.nodesRead=selected.nodesRead;result.source.allIntersectingHierarchyLevels=true;return result;}
