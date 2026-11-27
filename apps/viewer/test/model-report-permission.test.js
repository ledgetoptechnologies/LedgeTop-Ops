'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {newSharePermissions,effectiveSharePermissions,assetAllowed,reportAllowed}=require('../server/publicSharePolicy');
const {permissions}=require('../server/apiV1');

test('new public links leave the model report off unless chosen',()=>{
  assert.equal(newSharePermissions({download:true}).report,false);
  assert.equal(newSharePermissions({}).report,false);
  assert.equal(newSharePermissions({report:true}).report,true);
  assert.equal(newSharePermissions({report:true},'client').report,true);
  assert.equal(newSharePermissions({report:'yes'}).report,false);
});

test('a stored link without the field keeps what it allowed: the report followed downloads',()=>{
  assert.equal(effectiveSharePermissions({view:true,download:true}).report,true);
  assert.equal(effectiveSharePermissions({view:true,download:false}).report,false);
  assert.equal(effectiveSharePermissions({view:true,download:true,report:false}).report,false);
  assert.equal(effectiveSharePermissions({view:true,download:false,report:true}).report,true);
  assert.equal(effectiveSharePermissions({view:true,download:true,report:'true'}).report,false);
});

test('reportAllowed fails closed on anything but true, or absent with downloads on',()=>{
  assert.equal(reportAllowed(undefined),false);
  assert.equal(reportAllowed(null),false);
  assert.equal(reportAllowed({download:true}),true);
  assert.equal(reportAllowed({download:true,report:null}),false);
  assert.equal(reportAllowed({download:true,report:0}),false);
  assert.equal(reportAllowed({report:true}),true);
});

test('link asset policy and Operations-issued session permissions follow the same rule',()=>{
  assert.equal(assetAllowed({permissions:{view:true,download:true,report:false}},'report'),false);
  assert.equal(assetAllowed({permissions:{view:true,download:true}},'report'),true);
  assert.equal(assetAllowed({permissions:{view:true,download:false,report:true}},'report'),true);
  assert.equal(assetAllowed({permissions:{view:true,download:true,report:false}},'ortho'),true);
  assert.equal(permissions({download:true}).report,undefined,'an older Operations release keeps today\'s behaviour');
  assert.equal(permissions({download:true,report:false}).report,false);
  assert.equal(permissions({download:false,report:true}).report,true);
  assert.equal(permissions({download:true,report:'no'}).report,false);
});
