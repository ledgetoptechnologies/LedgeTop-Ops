'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { detectProviderType, NodeOdmProvider } = require('../server/nodeOdmProvider');

const nodeInfo = { version:'2.2.3',engine:'odm',engineVersion:'3.5.6',taskQueueCount:2,maxImages:null };
const clusterInfo = { version:'1.5.3',engine:'odm',engineVersion:'3.5.6',taskQueueCount:0,maxImages:500,totalMemory:99999999999,availableMemory:99999999999,cpuCores:99999999999 };

test('provider type detection requires positive NodeODM or ClusterODM capability evidence', () => {
  assert.equal(detectProviderType(nodeInfo), 'nodeodm');
  assert.equal(detectProviderType(clusterInfo), 'clusterodm');
  assert.throws(() => detectProviderType({ ...clusterInfo, totalMemory:1024 }), { code:'provider_probe_ambiguous' });
  assert.throws(() => detectProviderType({ version:'2.2.3' }), { code:'provider_probe_unsupported' });
  assert.throws(() => detectProviderType({ ...nodeInfo, version:'3.0.0' }), { code:'provider_probe_ambiguous' });
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
