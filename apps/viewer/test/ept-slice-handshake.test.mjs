import test from 'node:test';
import assert from 'node:assert/strict';
import { EPT_SLICE_CAPABILITY as marker } from '../ept-slice-capability.mjs';
import { createEptSliceHandshake } from '../ept-slice-handshake.mjs';

const fixture = () => { const state={clear:0,set:0},adapter={capability:marker,set(){state.set++;return true;},clear(){state.clear++;return true;}},frame={Potree:{ltdsSliceCapability:marker},__ltdsEptSliceAdapter:adapter};return {state,frame,adapter}; };
test('requires explicit opt-in and matching frame and adapter markers',()=>{
  const f=fixture();assert.equal(createEptSliceHandshake().connect({frame:f.frame,capability:marker,adapter:f.adapter}),false);
  const h=createEptSliceHandshake({enabled:true});
  assert.equal(h.connect({frame:{Potree:{ltdsSliceCapability:'old'}},adapter:f.adapter}),false);
  assert.equal(h.connect({frame:f.frame,capability:marker,adapter:{...f.adapter,capability:'new'}}),false);
  assert.equal(h.connect({frame:f.frame,capability:marker,adapter:f.adapter}),true);
  assert.equal(h.set(f.frame,{axis:'easting'}),true);assert.equal(f.state.set,1);
  assert.equal(h.set({},{}),false);assert.equal(f.state.clear,1);assert.equal(h.connected,false);
});
test('frame replacement, adapter failure and lifecycle loss clear access',()=>{
  const a=fixture(),b=fixture(),h=createEptSliceHandshake({enabled:true});
  assert.equal(h.connect({frame:a.frame,capability:marker,adapter:a.adapter}),true);
  assert.equal(h.connect({frame:b.frame,capability:marker,adapter:b.adapter}),true);assert.equal(a.state.clear,1);
  b.adapter.set=()=>{throw new Error('lost frame')};assert.equal(h.set(b.frame,{}),false);assert.equal(b.state.clear,1);
  assert.equal(h.connect({frame:a.frame,capability:marker,adapter:a.adapter}),true);
  assert.equal(h.dispose(),true);assert.equal(a.state.clear,2);assert.equal(h.connected,false);
  assert.equal(h.connect({frame:a.frame,capability:marker,adapter:a.adapter}),false);
});
test('a same-frame navigation to old assets clears the prior adapter',()=>{
  const f=fixture(),h=createEptSliceHandshake({enabled:true});
  assert.equal(h.connect({frame:f.frame,adapter:f.adapter}),true);
  f.frame.Potree={};assert.equal(h.set(f.frame,{}),false);assert.equal(f.state.clear,1);assert.equal(h.connected,false);
});
test('failed cleanup prevents replacement and reports failure',()=>{
  const a=fixture(),b=fixture(),h=createEptSliceHandshake({enabled:true});a.adapter.clear=()=>{throw Error('iframe lost');};
  assert.equal(h.connect({frame:a.frame,capability:marker,adapter:a.adapter}),true);
  assert.equal(h.connect({frame:b.frame,capability:marker,adapter:b.adapter}),false);assert.equal(h.connected,false);
  assert.equal(h.connect({frame:b.frame,capability:marker,adapter:b.adapter}),false,'failed cleanup permanently fences this bridge');
});
test('ownership interruption clears authority and asks the parent to reset once',()=>{
  const f=fixture(),notices=[],h=createEptSliceHandshake({enabled:true,onUnavailable:value=>notices.push(value)});
  assert.equal(h.connect({frame:f.frame,adapter:f.adapter}),true);
  assert.equal(h.interrupt({},'ignored'),false);assert.equal(h.interrupt(f.frame),true);
  assert.deepEqual(notices,[{reason:'clip-ownership-lost',cleared:true}]);assert.equal(f.state.clear,1);
  assert.equal(h.set(f.frame,{}),false);assert.equal(h.interrupt(f.frame),false);
});
