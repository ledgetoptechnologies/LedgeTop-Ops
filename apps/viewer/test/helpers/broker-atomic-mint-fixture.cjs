'use strict';
// Synthetic-only experiment: temporarily delegates the real broker's inner
// transaction to the fixture's outer SQLite transaction. Never mount in runtime.
const {ReferenceTransferBroker}=require('../../server/referenceTransferBroker');
const persistence=require('./atomic-grant-persistence-fixture.cjs');
const fail=()=>{throw Object.assign(Error('synthetic broker unavailable'),{code:'fixture_hold'})};
function atomicBrokerFixture({scope,broker,verifier,sourcePin,keyProvider}){
 if(scope!=='synthetic-only'||!(broker instanceof ReferenceTransferBroker)||typeof verifier!=='function'||typeof sourcePin!=='function'||typeof keyProvider!=='function')fail();
 persistence.schema(broker.db);
 return {issue(operationId,binding,input){
  if(verifier({operationId,binding,input})!==true||sourcePin({operationId,binding,input})!==true)fail();
  const supplied=keyProvider();if(!supplied||typeof supplied.keyId!=='string'||!Buffer.isBuffer(supplied.key))fail();
  const original=broker.tx;let active=true;
  broker.tx=fn=>{if(!active)fail();return fn();};
  try{return persistence.issue(broker.db,operationId,binding,supplied.keyId,supplied.key,()=>{
    const minted=broker.mintGrant(input);
    // A legacy random grant cannot be adopted or silently reminted.
    if(minted.reused||!minted.grant?.token)fail();return minted.grant;
  });}finally{active=false;broker.tx=original;}
 }};
}
module.exports={atomicBrokerFixture};
