'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createManagedScopeMap,scopesOverlap}=require('../server/referenceManagedScopes');
test('explicit configured root mapping catches aliases and component ancestors, not string prefixes',()=>{
 const config={caseMode:'sensitive',revision:'r1',roots:{datasets:{domain:'main',prefix:'data'},trash:{domain:'main',prefix:'data/trash'},models:{domain:'main',prefix:'models'},terra_import:{domain:'main',prefix:'data'}}};const m=createManagedScopeMap(config);
 assert.equal(scopesOverlap(m.scope('datasets','trash/job'),m.scope('trash','job')),true);assert.equal(scopesOverlap(m.scope('datasets','site'),m.scope('terra_import','site/photos')),true);assert.equal(scopesOverlap(m.scope('datasets','site'),m.scope('datasets','site2')),false);assert.equal(scopesOverlap(m.scope('models','site'),m.scope('datasets','site')),false);
 config.revision='r2';config.roots.datasets.prefix='changed';assert.equal(m.scope('datasets','site').revision,'r1');assert.deepEqual(m.scope('datasets','site').components,['data','site']);
});
test('unknown roots and ambiguous paths or stale revisions fail closed',()=>{
 const m=createManagedScopeMap({caseMode:'sensitive',revision:'r1',roots:{datasets:{domain:'main',prefix:''}}}),s=m.scope('datasets','safe');for(const bad of ['','../x','a//b','a\\b','a/./b','a/é','/a'])assert.throws(()=>m.scope('datasets',bad),{code:'managed_scope_unverified'});assert.throws(()=>m.scope('trash','x'),{code:'managed_scope_unverified'});assert.throws(()=>scopesOverlap(s,{...s,revision:'r2'}),{code:'managed_scope_unverified'});assert.throws(()=>scopesOverlap(s,{...s,components:['a/b']}),{code:'managed_scope_unverified'});assert.equal(scopesOverlap(m.scopeRoot('datasets'),m.scope('datasets','A/b')),true);assert.equal(scopesOverlap(m.scope('datasets','A/b'),m.scope('datasets','a/b')),false);
});
test('invalid maps are rejected and configuration alone is not an alias attestation',()=>{
 for(const roots of [{unknown:{domain:'d',prefix:''}},{datasets:{domain:'D',prefix:''}},{datasets:{domain:'d',prefix:'../x'}}])assert.throws(()=>createManagedScopeMap({caseMode:'sensitive',revision:'r1',roots}),{code:'managed_scope_unverified'});assert.throws(()=>createManagedScopeMap({revision:'r1',roots:{datasets:{domain:'d',prefix:''}}}),{code:'managed_scope_unverified'});
 const m=createManagedScopeMap({caseMode:'sensitive',revision:'r1',roots:{datasets:{domain:'first',prefix:''},trash:{domain:'second',prefix:''}}});assert.equal(scopesOverlap(m.scope('datasets','same'),m.scope('trash','same')),false,'a dishonest configuration could hide a real alias; owner attestation is required');
});
