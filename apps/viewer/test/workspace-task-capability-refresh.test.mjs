import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../workspace-new-task.mjs',import.meta.url),'utf8');
function harness(api){
  const context={node:{value:'node'},currentProviders:[{id:'node',capabilityFingerprint:'old'}],presets:[{id:'preset',enabled:true,options:{count:7}}],signal:{aborted:false},form:{elements:{presetId:{value:'preset'}},querySelector:()=>({textContent:''})},api,renders:0,providerOptions(){context.renders++;}};
  vm.createContext(context);
  const start=source.indexOf('  const capabilityRefreshes='),end=source.indexOf('  function setBusy(',start);
  vm.runInContext(source.slice(start,end)+'\nthis.refresh=refreshTaskCapabilities;',context);return context;
}
test('task refresh calls read-authorized fresh endpoint and coalesces overlapping opens',async()=>{
  const calls=[];let complete;
  const ctx=harness(async(path,options)=>{calls.push({path,options});if(path.endsWith('/refresh'))await new Promise(resolve=>{complete=resolve});return path.includes('/providers?')?{providers:[{id:'node',capabilityFingerprint:'new'}]}:{presets:[{id:'preset',options:{count:8}}]};});
  const first=ctx.refresh(),second=ctx.refresh({requireFresh:true});assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/v1/processing/providers/node/capabilities/refresh');
  assert.equal(calls[0].options.method,'POST');complete();await Promise.all([first,second]);
  assert.equal(calls.length,3);assert.equal(ctx.currentProviders[0].capabilityFingerprint,'new');assert.equal(ctx.renders,1);
});
test('offline capability refresh fails closed while retaining cached providers and selected preset',async()=>{
  const ctx=harness(async()=>{throw new Error('offline')});
  await assert.rejects(ctx.refresh({requireFresh:true}),/offline/);assert.equal(ctx.currentProviders[0].capabilityFingerprint,'old');assert.equal(ctx.presets[0].options.count,7);assert.equal(ctx.renders,0);
});
test('removed selected preset is retained disabled for review rather than silently changed to defaults',async()=>{
  const ctx=harness(async path=>path.includes('/providers?')?{providers:[{id:'node'}]}:{presets:[]});
  await ctx.refresh();assert.equal(ctx.presets.length,1);assert.equal(ctx.presets[0].id,'preset');assert.equal(ctx.presets[0].enabled,false);assert.equal(ctx.presets[0].options.count,7);
});
test('closing task while refreshing prevents late state mutation',async()=>{
  let complete;const ctx=harness(async path=>{if(path.endsWith('/refresh'))await new Promise(resolve=>{complete=resolve});return {providers:[],presets:[]};});
  const pending=ctx.refresh();ctx.signal.aborted=true;complete();await pending;
  assert.equal(ctx.currentProviders[0].capabilityFingerprint,'old');assert.equal(ctx.renders,0);
});
