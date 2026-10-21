import test from 'node:test';
import assert from 'node:assert/strict';
import {mountNativeProfile} from '../measurement-profile-panel.mjs';
import {profileLine} from '../measurement-native-profile.mjs';

const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function payload(line,height=7){const lengthM=Math.hypot(line.end[0]-line.start[0],line.end[1]-line.start[1]);return {method:'surface-transect',sampling:'native-cell-step',line:structuredClone(line),lengthM,cellCount:1,parentCalculationId:'volume',baseHash:'b'.repeat(64),source:{assetId:'dsm',kind:'dsm',modelVersionId:'v',sha256:'a'.repeat(64),verticalUnit:'m',verticalUnitBasis:'raster-metadata',crs:'EPSG:32616',resolutionM:[1,1]},segments:[{startM:0,endM:lengthM,start:line.start,end:line.end,status:'sample',surfaceM:height,baseStartM:0,baseEndM:0,cell:[0,0]}]};}
function fixture(t){
 t.mock.timers.enable({apis:['setTimeout']});
 const nodes=new Map(),downloads=[],created=[];
 function element(){const e={value:'0',hidden:false,disabled:false,textContent:'',width:300,height:300,clientWidth:300,clientHeight:300,setCustomValidity(value){this.validation=value;},setAttribute(k,v){this[k]=v;},removeAttribute(k){delete this[k];},getBoundingClientRect:()=>({left:0,width:300}),click(){downloads.push(this.download);},toBlob(fn){this.blobCallback=fn;}};let current=[];const ctx={paths:[],beginPath(){current=[];},moveTo(...p){current.push(p);},lineTo(...p){current.push(p);},stroke(){this.paths.push(current);},clearRect(){},fillRect(){},closePath(){},fill(){},fillText(){},arc(){},drawImage(){}};e.getContext=()=>ctx;return e;}
 const host={innerHTML:'',querySelector(key){if(!nodes.has(key))nodes.set(key,element());return nodes.get(key);},setAttribute(k,v){this[k]=v;},removeAttribute(k){delete this[k];},replaceChildren(){this.removed=true;}};
 const previous=globalThis.document;globalThis.document={createElement(){const next=element();created.push(next);return next;}};t.after(()=>{globalThis.document=previous;});
 const record={name:'Pile',vertices:[[0,0,0],[10,0,0],[10,10,0],[0,10,0]],results:{source:{kind:'dsm'}}},jobs=[];
 const mounted=mountNativeProfile(host,{record,units:'metric',calculate(_record,options){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});const job={...options,resolve,reject,cancel:async()=>{job.cancelled=true;}};jobs.push(job);options.onJob(job);return promise;}});t.after(()=>mounted.dispose());
 const get=name=>host.querySelector(`[data-${name}]`);
 const change=(value)=>{get('azimuth').value=String(value);get('azimuth').oninput();};
 return {host,jobs,get,change,mounted,downloads,created,finish(index=jobs.length-1,height=7){jobs[index].resolve(payload(jobs[index].line,height));}};
}
test('retains a clearly marked previous chart and matching plan during changes and failures; blocks stale exports',async t=>{
 const f=fixture(t);f.finish();await flush();assert.equal(f.get('profile-csv').disabled,false);
 f.change(90);assert.equal(f.get('profile-previous').hidden,false);assert.equal(f.get('profile-csv').disabled,true);
 // Force a fresh repaint rather than the cached image to verify the plotted line.
 f.get('profile-chart').clientWidth=301;f.get('profile-chart').onpointerleave();
 const line=f.get('profile-plan').getContext('2d').paths.at(-1);assert.equal(line[0][1],line[1][1],'plan stays on completed horizontal section, not requested vertical line');
 f.get('profile-chart').onkeydown({key:'Home',preventDefault(){}});assert.match(f.get('profile-readout').textContent,/Surface 7/,'last-good chart remains inspectable');
 f.get('profile-csv').onclick();f.get('profile-png').onclick();assert.deepEqual(f.downloads,[],'handlers reject stale exports even when called directly');
 t.mock.timers.tick(350);assert.equal(f.jobs.length,2);f.jobs[1].reject(new Error('offline'));await flush();
 assert.match(f.get('profile-status').textContent,/offline/);assert.equal(f.get('profile-previous').hidden,false);assert.equal(f.get('update').hidden,false);
 f.get('profile-chart').onkeydown({key:'Home',preventDefault(){}});assert.match(f.get('profile-readout').textContent,/Surface 7/);
 f.get('update').onclick();f.finish(2,9);await flush();assert.equal(f.get('profile-previous').hidden,true);assert.equal(f.get('profile-csv').disabled,false);assert.equal(f.get('cancel').hidden,true);
 f.get('profile-chart').onkeydown({key:'Home',preventDefault(){}});assert.match(f.get('profile-readout').textContent,/Surface 9/);
});
test('rapid inputs coalesce behind one in-flight request and superseded results never replace the last-good chart',async t=>{
 const f=fixture(t);f.finish();await flush();f.change(10);t.mock.timers.tick(350);assert.equal(f.jobs.length,2);
 for(const angle of [20,30,40])f.change(angle);t.mock.timers.tick(350);assert.equal(f.jobs.length,2);
 f.finish(1,99);await flush();assert.equal(f.jobs.length,3);assert.equal(f.get('profile-previous').hidden,false);
 f.get('profile-chart').onkeydown({key:'Home',preventDefault(){}});assert.match(f.get('profile-readout').textContent,/Surface 7/);
 assert.deepEqual(f.jobs[2].line,profileLine([[0,0,0],[10,0,0],[10,10,0],[0,10,0]],40,0));
 f.finish(2,11);await flush();assert.equal(f.get('profile-previous').hidden,true);f.get('profile-chart').onkeydown({key:'Home',preventDefault(){}});assert.match(f.get('profile-readout').textContent,/Surface 11/);
});
test('cancel and late completion retain the previous section and disable misleading exports',async t=>{
 const f=fixture(t);f.finish();await flush();f.change(25);t.mock.timers.tick(350);
 await f.get('cancel').onclick();assert.equal(f.jobs[1].cancelled,true);assert.equal(f.jobs[1].signal.aborted,true);assert.match(f.get('profile-status').textContent,/Cancellation requested/);
 f.finish(1,99);await flush();assert.equal(f.get('profile-previous').hidden,false);assert.equal(f.get('profile-png').disabled,true);f.get('profile-chart').onkeydown({key:'Home',preventDefault(){}});assert.match(f.get('profile-readout').textContent,/Surface 7/);
 f.mounted.dispose();assert.equal(f.host.removed,true);
});
test('initial failure does not claim a previous section; pending PNG capture cannot export under new controls',async t=>{
 const f=fixture(t);f.jobs[0].reject(new Error('first request failed'));await flush();assert.equal(f.get('profile-previous').hidden,true);assert.equal(f.get('profile-csv').disabled,true);
 f.get('update').onclick();f.finish();await flush();f.get('profile-png').onclick();const capture=f.created.at(-1);assert.equal(typeof capture.blobCallback,'function');
 f.change(35);capture.blobCallback(new Blob(['old chart']));assert.deepEqual(f.downloads,[]);
});
test('a failed cancellation preserves the previous completed chart and offers recovery',async t=>{
 const f=fixture(t);f.finish();await flush();f.change(15);t.mock.timers.tick(350);f.jobs[1].cancel=async()=>{throw new Error('cancellation refused');};
 await f.get('cancel').onclick();assert.match(f.get('profile-status').textContent,/cancellation refused/);assert.equal(f.get('profile-previous').hidden,false);assert.equal(f.get('profile-png').disabled,true);
 f.finish(1,12);await flush();assert.equal(f.get('profile-previous').hidden,true);assert.equal(f.get('profile-csv').disabled,false);
});
