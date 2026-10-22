import test from 'node:test';
import assert from 'node:assert/strict';
import {presetSaveRequest} from '../workspace-preset-request.mjs';
const provider={id:'node',type:'nodeodm',capabilityFingerprint:'v1'};
const preset={id:'custom',displayName:'Survey',description:'Keep this',enabled:false,providerType:'nodeodm',capabilityFingerprint:'v1',options:{dtm:true,crop:1}};
test('save as creates a separate preset and retains explicit false/zero task values',()=>{
  const request=presetSaveRequest({provider,selectedPreset:preset,overrides:{dtm:false,crop:0},name:' Copy '});
  assert.equal(request.method,'POST');assert.equal(request.body.displayName,'Copy');assert.deepEqual(request.body.options,{dtm:false,crop:0});assert.deepEqual(preset.options,{dtm:true,crop:1});
});
test('explicit update preserves selected preset identity, description and enabled state',()=>{
  const request=presetSaveRequest({provider,selectedPreset:preset,overrides:{crop:2},update:true});
  assert.equal(request.path,'/api/v1/processing/presets/custom');assert.equal(request.method,'PATCH');assert.equal(request.body.description,'Keep this');assert.equal(request.body.enabled,false);assert.equal(request.body.displayName,'Survey');
});
test('missing, built-in and incompatible presets cannot be updated implicitly',()=>{
  for(const selectedPreset of [undefined,{...preset,builtIn:true},{...preset,capabilityFingerprint:'old'}])assert.throws(()=>presetSaveRequest({provider,selectedPreset,update:true}));
  assert.throws(()=>presetSaveRequest({provider,name:''}));assert.throws(()=>presetSaveRequest({name:'Preset'}));
});
