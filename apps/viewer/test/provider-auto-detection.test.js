'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { detectProviderType, NodeOdmProvider } = require('../server/nodeOdmProvider');

const nodeInfo = { version:'2.2.3',engine:'odm',engineVersion:'3.5.6',taskQueueCount:2,maxImages:null };
const clusterInfo = { version:'1.5.3',engine:'odm',engineVersion:'3.5.6',taskQueueCount:0,maxImages:500,totalMemory:99999999999,availableMemory:99999999999,cpuCores:99999999999 };
// The version and engine fields match the observed isolated 3.6.2 image;
// resource values are representative fixtures, not recorded host metrics.
const node362Info = { version:'3.6.2',engine:'odm',engineVersion:'3.6.2',taskQueueCount:0,maxImages:null,maxParallelTasks:1,totalMemory:4096,availableMemory:2048,cpuCores:2 };

test('provider type detection requires positive NodeODM or ClusterODM capability evidence', () => {
  assert.equal(detectProviderType(nodeInfo), 'nodeodm');
  assert.equal(detectProviderType(clusterInfo), 'clusterodm');
  assert.throws(() => detectProviderType({ ...clusterInfo, totalMemory:1024 }), { code:'provider_probe_ambiguous' });
  assert.throws(() => detectProviderType({ version:'2.2.3' }), { code:'provider_probe_unsupported' });
  assert.throws(() => detectProviderType({ ...nodeInfo, version:'3.0.0' }), { code:'provider_probe_ambiguous' });
  assert.equal(detectProviderType(node362Info), 'nodeodm');
  for (const changed of [{version:'3.6.3'},{engine:'other'},{engineVersion:'3.6.3'}, {totalMemory:99999999999,availableMemory:99999999999,cpuCores:99999999999}])
    assert.throws(() => detectProviderType({...node362Info,...changed}), {code:'provider_probe_ambiguous'});
  for (const field of ['totalMemory','availableMemory','cpuCores'])
    assert.throws(() => detectProviderType({...node362Info,[field]:99999999999}), {code:'provider_probe_ambiguous'});
  assert.throws(() => detectProviderType({...node362Info,maxImages:undefined}), {code:'provider_probe_unsupported'});
});

test('NodeODM 3.6.2 capability probe preserves typed options, fingerprint and a processing-compatibility warning',async()=>{
  let info={...node362Info};
  const options=[{name:'max-concurrency',type:'int',value:'2'},{name:'fast-orthophoto',type:'bool',value:'false'},{name:'feature-quality',type:'enum',domain:['lowest','low'],value:'lowest'}];
  const fetchImpl=async input=>new Response(JSON.stringify(String(input).endsWith('/info')?info:options),{headers:{'content-type':'application/json'}});
  const adapter=new NodeOdmProvider({endpoint:'http://127.0.0.1:3000',providerType:'nodeodm',fetchImpl});
  const first=await adapter.capabilities();assert.equal(first.capabilities.providerType,'nodeodm');assert.equal(first.capabilities.options[0].value,2);assert.equal(first.capabilities.options[1].value,false);
  assert.match(first.capabilities.compatibilityWarning,/not yet been verified/);
  info={...info,taskQueueCount:2,availableMemory:1024};assert.equal((await adapter.capabilities()).fingerprint,first.fingerprint);
  await assert.rejects(new NodeOdmProvider({endpoint:'http://127.0.0.1:3000',providerType:'clusterodm',fetchImpl}).capabilities(),{code:'provider_type_mismatch'});
});

test('capability probe records detected engine details and rejects a configured-type mismatch', async () => {
  const fetchImpl = async (input) => new Response(String(input).includes('/info') ? JSON.stringify(clusterInfo) : JSON.stringify([{ name:'pc-ept',type:'bool',value:'true' }]), { status:200,headers:{'content-type':'application/json'} });
  const detected = await new NodeOdmProvider({ endpoint:'https://cluster.example.test',fetchImpl }).capabilities();
  assert.equal(detected.capabilities.providerType, 'clusterodm');
  assert.equal(detected.capabilities.apiVersion, '1.5.3');
  assert.equal(detected.capabilities.engine, 'odm');
  assert.equal(detected.capabilities.engineVersion, '3.5.6');
  assert.equal(detected.capabilities.taskQueueCount, 0);
  assert.equal(detected.capabilities.options[0].value, true);
  await assert.rejects(new NodeOdmProvider({ endpoint:'https://cluster.example.test',providerType:'nodeodm',fetchImpl }).capabilities(), { code:'provider_type_mismatch' });
});
