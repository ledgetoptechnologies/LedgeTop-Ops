// Local-only browser event harness. Uses the shipped controller verbatim and
// synthetic decoded hits; it is not a Potree GPU/EPT or live-model acceptance.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const shell = readFileSync(new URL('public/pointcloud.html', root), 'utf8');
const start = shell.indexOf('class PCPointerControls {');
const end = shell.indexOf('// Replace Potree\'s EarthControls', start);
if (start < 0 || end < start) throw new Error('shipped point controller unavailable');
const controller = `import * as THREE from '/three.module.js';
const { POINT_PICK_WINDOW, NAVIGATION_POLICY, orbitRadiansForPixels, wheelZoomScale,
 worldUnitsPerPixel, maxPanStep, clampZoomDistance, radiusAfterDolly,
 isPlausibleAnchorDistance, canUseOverviewAnchor } = window.LtdsPointCloudNavigation;
const insertionActive = { m: false, v: false };
${shell.slice(start, end)}
export { PCPointerControls };`;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Point-cloud controls QA</title>
<style>body{margin:16px;background:#171717;color:white;font:16px sans-serif}button{padding:12px;margin-right:8px}canvas{display:block;margin-top:16px;width:600px;height:400px;touch-action:none}pre{white-space:pre-wrap}</style></head><body>
<h1>Point-cloud controls QA</h1><p>Shipped controller, synthetic decoded hits. No live assets or sessions.</p>
<button id="deep">Reset deeper surface</button><button id="near">Reset near surface</button>
<button id="collapsed">Reset collapsed radius</button><button id="sparse">Toggle sparse pick miss</button>
<pre id="status">Loading</pre><script src="/navigation.js"></script><script type="module">
import * as THREE from '/three.module.js';
import { PCPointerControls } from '/controls.js';
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(600,400); document.body.appendChild(renderer.domElement);
const camera = new THREE.PerspectiveCamera(60,1.5,0.01,100000); camera.up.set(0,0,1);
const direction = new THREE.Vector3(0,.8,-.6);
const view = { position: new THREE.Vector3(0,-200,150), radius:250,
 getPivot(){return this.position.clone().addScaledVector(direction,this.radius)},
 lookAt(point){this.radius=point.distanceTo(this.position);direction.copy(point).sub(this.position).normalize()} };
const scene = new THREE.Scene();
function sync(){camera.position.copy(view.position);camera.lookAt(view.getPivot());camera.updateMatrixWorld(true);return camera}
const viewer = { renderer, scene:{view,scene,pointclouds:[],getActiveCamera:sync} };
const controls = new PCPointerControls(viewer);
const surface = new THREE.Vector3(); let missing=false, wheels=0, lastOrbit=false, moves=0;
controls._pointPick=()=>missing?null:surface.clone();
controls._cloudBounds=()=>new THREE.Box3(new THREE.Vector3(-50,-50,-30),new THREE.Vector3(50,50,30));
const marker=new THREE.Mesh(new THREE.SphereGeometry(2),new THREE.MeshBasicMaterial({color:0xee5007,wireframe:true}));scene.add(marker);
function reset(kind){controls._blur();view.position.set(0,-200,150);direction.set(0,.8,-.6);view.radius=kind==='collapsed'?.1:250;
 surface.copy(view.position).addScaledVector(direction,kind==='near'?20:290);marker.position.copy(surface);missing=false;wheels=0;moves=0;lastOrbit=false;sync()}
for(const kind of ['deep','near','collapsed'])document.getElementById(kind).onclick=()=>reset(kind);
document.getElementById('sparse').onclick=()=>{missing=!missing};
renderer.domElement.addEventListener('pointerdown',()=>{lastOrbit=controls._mode==='orbit'});
renderer.domElement.addEventListener('pointermove',()=>{if(controls._mode==='orbit')moves++});
renderer.domElement.addEventListener('wheel',()=>wheels++);
window.addEventListener('blur',()=>controls._blur());
renderer.domElement.addEventListener('contextmenu',e=>e.preventDefault());
function frame(){sync();renderer.render(scene,camera);document.getElementById('status').textContent=JSON.stringify({radius:Number(view.radius.toFixed(5)),surfaceDepth:Number(surface.clone().sub(view.position).dot(direction).toFixed(5)),lastOrbit,moves,wheels,missing,position:view.position.toArray().map(v=>Number(v.toFixed(5)))},null,2);requestAnimationFrame(frame)}
reset('deep');frame();
</script></body></html>`;
const routes = new Map([
  ['/', ['text/html', () => html]],
  ['/controls.js', ['text/javascript', () => controller]],
  ['/navigation.js', ['text/javascript', () => readFileSync(new URL('public/pointcloud-navigation.js', root))]],
  ['/three.module.js', ['text/javascript', () => readFileSync(new URL('node_modules/three/build/three.module.js', root))]],
  ['/three.core.js', ['text/javascript', () => readFileSync(new URL('node_modules/three/build/three.core.js', root))]],
]);
const server = createServer((request,response)=>{
  const route=routes.get(request.url);
  if(request.method!=='GET'||!route){response.writeHead(404).end();return;}
  response.writeHead(200,{'Content-Type':route[0],'Cache-Control':'no-store'});response.end(route[1]());
});
server.listen(0,'127.0.0.1',()=>console.log('Point controls QA: http://127.0.0.1:'+server.address().port));
