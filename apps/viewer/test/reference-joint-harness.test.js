'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {validateConfig,closedBody,start} = require('./helpers/reference-joint-harness.cjs');
const config = () => ({keyPath:path.resolve('synthetic.key'),certPath:path.resolve('synthetic.pem'),controlEndpoint:'https://processing:9443',controlToken:'synthetic-control-token',fixtureControlToken:'synthetic-fixture-token',environment:'staging',host:'127.0.0.1',port:0});
const env = {REFERENCE_SYNTHETIC_FIXTURE:'1'};
test('joint fixture requires opt-in before loading or creating storage',async () => {
  assert.throws(() => validateConfig(config(),{}),{code:'SYNTHETIC_FIXTURE_REQUIRED'});
  await assert.rejects(start(config(),{}),{code:'SYNTHETIC_FIXTURE_REQUIRED'});
});
test('joint fixture accepts explicit synthetic config and rejects TLS bypass',() => {
  assert.equal(validateConfig(config(),env).port,0);
  assert.throws(() => validateConfig(config(),{...env,NODE_TLS_REJECT_UNAUTHORIZED:'0'}),{code:'TLS_VALIDATION_REQUIRED'});
  for (const controlEndpoint of ['http://processing:9443','https://u:p@processing','https://processing/path','https://processing/?token=x']) {
    assert.throws(() => validateConfig({...config(),controlEndpoint},env),{code:'INVALID_CONFIG'});
  }
  assert.throws(() => validateConfig({...config(),fixtureControlToken:config().controlToken},env),{code:'SEPARATE_FIXTURE_TOKEN_REQUIRED'});
  assert.throws(() => validateConfig({...config(),sourceFile:'customer.jpg'},env),{code:'INVALID_CONFIG'});
  assert.throws(() => validateConfig({...config(),fixtureRoot:path.parse(path.resolve('.')).root},env),{code:'INVALID_CONFIG'});
});
test('fixture control bodies are closed with bounded unique subset IDs',() => {
  assert.deepEqual(closedBody({}),{});
  assert.deepEqual(closedBody({acceptedObjectIds:['archive-1']},true),{acceptedObjectIds:['archive-1']});
  for (const body of [null,[],{restart:true},{acceptedObjectIds:['a']},{acceptedObjectIds:[]}]) {
    assert.throws(() => closedBody(body),{code:'INVALID_FIXTURE_BODY'});
  }
  for (const acceptedObjectIds of [[],['a','a'],['../source'],Array.from({length:33},(_,i) => 'o'+i)]) {
    assert.throws(() => closedBody({acceptedObjectIds},true),{code:'INVALID_FIXTURE_BODY'});
  }
});
