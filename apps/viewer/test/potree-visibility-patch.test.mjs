import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {patchPotreeVisibilitySelection} from '../scripts/patch-potree-ept.mjs';
import {assertInstalledPotreeVisibility} from '../scripts/verify-potree-visibility.mjs';
// Source QA uses public; exact-image QA uses the same shipped static module in
// dist. Never mount a replacement frontend module over the production image.
const performanceFile=['public','dist'].map(root=>new URL(`../${root}/pointcloud-performance.js`,import.meta.url)).find(file=>fs.existsSync(file));
assert.ok(performanceFile,'Packaged point-cloud performance module is required');
const {createAdaptivePointBudget}=createRequire(import.meta.url)(fileURLToPath(performanceFile));

const releasedBudget='\t\t\tif (numVisiblePoints + node.getNumPoints() > Potree.pointBudget) {\n\t\t\t\tbreak;\n\t\t\t}';
const fixture=[
  'prefix function updateVisibility(pointclouds, camera, renderer){',
  '\t\tlet loadedToGPUThisFrame = 0;',
  '\t\t\tvisible = visible && !(numVisiblePoints + node.getNumPoints() > Potree.pointBudget);',
  '\t\t\tvisible = visible && !(numVisiblePointsInPointclouds.get(pointcloud) + node.getNumPoints() > pointcloud.pointBudget);',
  '\t\t\tvisible = visible || node.getLevel() <= 2;',releasedBudget,
  '\t\t\tif (node.isTreeNode()) {\n\t\t\t\texports.lru.touch(node.geometryNode);',
  '\t};\n\tclass PointCloudArena4DNode {} suffix',
].join('\n');
test('visibility patch is bounded, idempotent and rejects unknown pinned selection layouts',()=>{
  const patched=patchPotreeVisibilitySelection(fixture);
  assert.equal(patchPotreeVisibilitySelection(patched),patched);
  assert.match(patched,/^prefix /);assert.match(patched,/ suffix$/);
  assert.doesNotMatch(patched,/visible = visible \|\|/);
  assert.match(patched,/continue;/);assert.doesNotMatch(patched,/break;/);
  for(const changed of [fixture.replace('<= 2','<= 3'),fixture.replace('break;','return;'),fixture.replace('class PointCloudArena4DNode','class Unknown')])assert.throws(()=>patchPotreeVisibilitySelection(changed),/pinned Potree visibility/);
});

test('installed visibility verification rejects unpatched and partially patched bytes without repairing them',()=>{
  assert.throws(()=>assertInstalledPotreeVisibility(fixture),/Installed Potree visibility\/demand patch is missing or incomplete/);
  const patched=patchPotreeVisibilitySelection(fixture);
  assert.equal(assertInstalledPotreeVisibility(patched),patched);
  const partial=patched.replace('.pending = true','.pending = false');
  assert.throws(()=>assertInstalledPotreeVisibility(partial),/Installed Potree visibility\/demand patch is missing or incomplete/);
  assert.equal(fixture.includes('ltdsBudgetDemand'),false);
});

// Execute the actual pinned third-party routine in image QA, not a reimplemented
// selector. Its renderer/geometry I/O is replaced with deterministic nodes.
if(process.env.POTREE_BUNDLE)assert.ok(fs.existsSync(process.env.POTREE_BUNDLE),'Explicit POTREE_BUNDLE is missing; exact-image verification cannot substitute another bundle or skip it');
const bundlePath=process.env.POTREE_BUNDLE||['public/potree/build/potree/potree.js','dist/potree/build/potree/potree.js'].find(file=>fs.existsSync(file));
const bundle=bundlePath?fs.readFileSync(bundlePath,'utf8'):null;

test('explicit missing image bundle fails rather than falling back to an available source or dist bundle',()=>{
  const env={...process.env,POTREE_BUNDLE:fileURLToPath(new URL('./missing-potree-verification-fixture.js',import.meta.url))};delete env.NODE_TEST_CONTEXT;
  const child=spawnSync(process.execPath,['--test',fileURLToPath(import.meta.url)],{env,encoding:'utf8',timeout:10000});
  assert.equal(child.error,undefined);assert.notEqual(child.status,0);assert.match(child.stdout+child.stderr,/Explicit POTREE_BUNDLE is missing/);
});
function makeNode(id,points,{inside=true,level=3,children=[],priority=1}={}){
  const vector={clone:()=>({sub:()=>({length:()=>priority})})};
  return {id,spacing:1,geometryNode:{},sceneNode:{visible:false},_transformVersion:0,getBoundingBox:()=>({inside,max:vector,min:vector}),getBoundingSphere:()=>({radius:1,center:{x:0,y:0,z:0,distanceTo:()=>10}}),getLevel:()=>level,getNumPoints:()=>points,isGeometryNode:()=>false,isTreeNode:()=>true,getChildren:()=>children};
}
function select(source,nodes,{budget=100000,cloudBudget=Infinity,maxLevel=Infinity,perspectiveDistance=null}={}){
  const start=source.indexOf('function updateVisibility(pointclouds, camera, renderer){'),end=source.indexOf('\n\tclass PointCloudArena4DNode',start);
  assert.ok(start>=0&&end>start);
  const visited=[];
  const pc={visible:true,visibleNodes:[],updateMatrixWorld(){},matrixWorld:{},material:{clipBoxes:[]},pointBudget:cloudBudget,maxLevel,minimumNodePixelSize:30,numVisibleNodes:0,numVisiblePoints:0};
  const Potree={pointBudget:budget,maxNodesLoading:0,_pointcloudTransformVersion:new Map([[pc,{number:0,transform:{equals:()=>true}}]])};
  const queued=nodes.map(node=>({node,pointcloud:0,weight:100}));
  const queue={size:()=>queued.length,pop:()=>{queued.sort((a,b)=>b.weight-a.weight);const item=queued.shift();visited.push(item.node.id);return item;},push:item=>queued.push(item)};
  const structures=()=>({frustums:[{intersectsBox:box=>box.inside}],camObjPositions:[{x:0,y:0,z:perspectiveDistance}],priorityQueue:queue});
  const run=new Function('Potree','updateVisibilityStructures','exports',source.slice(start,end)+';return updateVisibility;')(Potree,structures,{lru:{touch(){}}});
  const result=run([pc],perspectiveDistance===null?{}:{isPerspectiveCamera:true,fov:60}, {domElement:{clientWidth:800,clientHeight:600}});
  return {points:result.numVisiblePoints,visited,drawn:result.visibleNodes.map(node=>node.id),demand:pc.ltdsBudgetDemand};
}
const installedOptions={skip:bundle?false:'Installed pinned Potree required; image QA supplies POTREE_BUNDLE.'};

test('installed perspective selector refines on approach and releases detail on retreat at the same point budget',installedOptions,()=>{
  const source=assertInstalledPotreeVisibility(bundle);
  const root=makeNode('root',30000,{level:0,children:[makeNode('local-detail',40000,{level:1})]});
  assert.deepEqual(select(source,[root],{perspectiveDistance:100}).drawn,['root']);
  const close=select(source,[root],{perspectiveDistance:10});
  assert.deepEqual(close.drawn,['root','local-detail']);
  assert.equal(close.points,70000);
  assert.deepEqual(select(source,[root],{perspectiveDistance:100}).drawn,['root']);
});

test('installed selector is already patched in the actual image, not repaired by the test',installedOptions,()=>{
  assert.equal(assertInstalledPotreeVisibility(bundle),bundle);
});
test('installed selector: offscreen coarse and oversized nodes cannot starve visible local detail',installedOptions,()=>{
  const patched=assertInstalledPotreeVisibility(bundle);
  const detail=makeNode('detail',60000);
  assert.equal(select(patched,[detail]).points,60000);
  assert.equal(select(patched,[makeNode('offscreen-oversize',200000,{inside:false}),detail]).points,60000);
  assert.equal(select(patched,[makeNode('offscreen-coarse',50000,{inside:false,level:1}),detail]).points,60000);
});
test('installed selector: an oversized subtree is skipped but eligible siblings still fit the same ceiling',installedOptions,()=>{
  const patched=assertInstalledPotreeVisibility(bundle);
  const result=select(patched,[makeNode('oversize',120000,{children:[makeNode('orphan',1)]}),makeNode('detail',60000)]);
  assert.equal(result.points,60000);assert.deepEqual(result.visited,['oversize','detail']);
});
test('installed selector: visible root and child retain additive ancestry and budget limits',installedOptions,()=>{
  const patched=assertInstalledPotreeVisibility(bundle);
  const root=makeNode('root',30000,{level:0,children:[makeNode('child',40000,{level:1,children:[makeNode('grandchild',40000)]})]});
  const bounded=select(patched,[root]);assert.equal(bounded.points,70000);assert.deepEqual(bounded.drawn,['root','child']);
  assert.equal(select(patched,[root],{budget:120000}).points,110000);
  assert.equal(select(patched,[root],{cloudBudget:50000}).points,30000);
  assert.equal(select(patched,[root],{maxLevel:1}).points,30000);
  assert.equal(select(patched,[makeNode('offscreen-root',30000,{level:0,inside:false,children:[makeNode('offscreen-child',10000,{inside:false})]})]).points,0);
});
test('installed released selector reproduces the previously starving cases before patching',installedOptions,()=>{
  assertInstalledPotreeVisibility(bundle);
  // QA images may already contain the patch: reconstruct only the two verified
  // release signatures to retain a regression control against the same bundle.
  const released=bundle.replace('\t\t\t// LTDS: coarse nodes obey the same frustum and point-budget bounds.','\t\t\tvisible = visible || node.getLevel() <= 2;').replace(/\t\t\t\/\/ LTDS: skip an ineligible additive subtree, not the remaining siblings\.[\s\S]*?\n\t\t\t}/,releasedBudget);
  assert.throws(()=>assertInstalledPotreeVisibility(released),/Installed Potree visibility\/demand patch is missing or incomplete/);
  const detail=makeNode('detail',60000);
  assert.equal(select(released,[makeNode('outside',200000,{inside:false}),detail]).points,0);
  assert.equal(select(released,[makeNode('outside-coarse',50000,{inside:false,level:1}),detail]).points,50000);
});

test('installed selector: blocked demand requires spatial eligibility and reports settled additive ancestors',installedOptions,()=>{
  const patched=assertInstalledPotreeVisibility(bundle);
  const root=makeNode('root',100000,{level:0,children:[makeNode('detail',175000)]});
  assert.deepEqual(select(patched,[root],{budget:250000}).demand,{requiredPoints:275000,drawnPoints:100000,pending:false});
  assert.deepEqual(select(patched,[root],{budget:300000}).demand,{requiredPoints:0,drawnPoints:275000,pending:false});
  assert.equal(select(patched,[root],{budget:250000,cloudBudget:150000}).demand.requiredPoints,0,'global probe cannot defeat a per-cloud ceiling');
  assert.equal(select(patched,[makeNode('outside',300000,{inside:false})],{budget:250000}).demand.requiredPoints,0);
  assert.equal(select(patched,[makeNode('max-level',300000,{level:3})],{budget:250000,maxLevel:3}).demand.requiredPoints,0);
  const loading=makeNode('loading',100000,{level:0,children:[makeNode('detail',175000)]});
  loading.isGeometryNode=()=>true;loading.isTreeNode=()=>false;loading.isLoaded=()=>false;
  assert.deepEqual(select(patched,[loading],{budget:250000}).demand,{requiredPoints:275000,drawnPoints:0,pending:true});
});

test('installed selector and adaptive sampler jointly recover a formerly stuck local-detail frontier',installedOptions,()=>{
  const patched=assertInstalledPotreeVisibility(bundle),controller=createAdaptivePointBudget();let time=0;
  for(let i=0;i<100;i++)controller.sample(time+=200);
  assert.equal(controller.state.live,250000);
  const root=makeNode('root',100000,{level:0,children:[makeNode('local-detail',175000)]});
  let rendered;
  for(let i=0;i<900;i++){
    rendered=select(patched,[root],{budget:controller.state.live});
    controller.sample(time+=1000/60,{visiblePoints:rendered.points,demand:rendered.demand});
  }
  assert.deepEqual(rendered.drawn,['root','local-detail']);
  assert.equal(controller.state.live,287500);
  assert.equal(rendered.points,275000);
});
