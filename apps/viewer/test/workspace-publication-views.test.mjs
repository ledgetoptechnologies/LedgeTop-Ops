import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {publicationConfirmation,publicationViewNotice,verifiedPublicationViews} from '../workspace-publication-views.mjs';

test('publication names the verified views and warns when point-cloud view is not included',()=>{
  assert.deepEqual(verifiedPublicationViews(['tiles','glb','ortho']),['model','ortho']);
  assert.equal(publicationConfirmation(['tiles','glb','ortho']),
    'Publish these eligible assets: 3D model, Orthophoto?\n\nThe point-cloud view is not among the currently eligible views. A point-cloud source may still exist.');
});
test('verified EPT is a point-cloud view independent of 3D mesh tiles',()=>{
  assert.deepEqual(verifiedPublicationViews(['ept','tiles']),['model','pointCloud']);
  assert.equal(publicationViewNotice(['ept','tiles']),'');
  assert.equal(publicationConfirmation(['ept']),'Publish these eligible assets: Point cloud?');
});
test('confirmation discloses companions and refuses ambiguous or companion-only output',()=>{
  assert.match(publicationConfirmation(['tiles','shots','orthoCutline']),/3D model, Camera positions, Orthophoto boundary/);
  for(const kinds of [[],['shots'],['orthoCutline'],['tiles','future-kind'],null])assert.equal(publicationConfirmation(kinds),null);
});
test('unavailable, malformed or empty view evidence does not make an absence claim',()=>{
  for(const value of [undefined,null,[],['tiles',null]])assert.equal(publicationViewNotice(value),'');
  assert.equal(verifiedPublicationViews(null),null);
});
test('publish workflow confirms the exact assets, respects cancellation and rejects ambiguous evidence',async()=>{
  const source=fs.readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
  const code=source.match(/^async function publishAttempt\(id\).*$/m)?.[0];assert.ok(code);
  let kinds=['tiles','shots'],approved=false,confirmation='',writes=[],errors=[];
  const context=vm.createContext({publicationConfirmation,encodeURIComponent,Error,
    api:async()=>({assetKinds:kinds}),dialogs:{confirm:async text=>{confirmation=text;return approved}},
    mutate:async(...args)=>writes.push(args),toast:message=>errors.push(message)});
  const publish=vm.runInContext(`(${code})`,context);
  await publish('attempt');assert.match(confirmation,/Camera positions/);assert.equal(writes.length,0);
  approved=true;await publish('attempt');assert.equal(writes.length,1);assert.deepEqual([...writes[0][1].body.selectedAssetKinds],kinds);
  kinds=['shots'];await publish('attempt');assert.equal(writes.length,1);assert.match(errors.at(-1),/could not be identified/);
});
test('client workspace sharing shows a notice only from verified output eligibility',()=>{
  const source=fs.readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
  const code=source.match(/function clientSharePanel\(output,onlyOutputId\)\{[\s\S]*?\n\}/)?.[0];assert.ok(code);
  const state={shareContext:{id:'current',loading:false},sharePreflight:{one:{contextId:'current',eligibleAssetKinds:['tiles']}},clientDirectAccess:true};
  const context=vm.createContext({state,publicationViewNotice,esc:text=>text,
    legacyClientSharePanel:()=>'<legacy>',directClientShareCard:()=>'<direct>'});
  const panel=vm.runInContext(`(${code})`,context);
  assert.match(panel({id:'one'},'one'),/point-cloud view is not among/);
  state.shareContext.loading=true;assert.doesNotMatch(panel({id:'one'},'one'),/point-cloud view is not among/);state.shareContext.loading=false;
  state.sharePreflight.one.contextId='old';assert.doesNotMatch(panel({id:'one'},'one'),/point-cloud view is not among/);state.sharePreflight.one.contextId='current';
  state.sharePreflight.one.error='unavailable';assert.doesNotMatch(panel({id:'one'},'one'),/point-cloud view is not among/);state.sharePreflight.one.error=null;
  state.sharePreflight.one.eligibleAssetKinds=['tiles','ept'];assert.doesNotMatch(panel({id:'one'},'one'),/point-cloud view is not among/);
  state.sharePreflight={};assert.doesNotMatch(panel({id:'one'},'one'),/point-cloud view is not among/);
  assert.doesNotMatch(panel(null,null),/point-cloud view is not among/);
});
