'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createOrthophotoJpegService}=require('../server/orthophotoJpegService');

test('disabled composition is inert even with hostile configuration getters',async()=>{
  const service=createOrthophotoJpegService({database:{get prepare(){throw new Error('database access');}},
    storage:{get resolve(){throw new Error('storage access');}}});
  assert.deepEqual(await service.runOne(),{status:'disabled'});assert.equal(Object.isFrozen(service),true);
});

test('enabled service requires trusted runtime qualification and complete ownership configuration',()=>{
  assert.throws(()=>createOrthophotoJpegService({enabled:true}),{code:'jpeg_service_composition_required'});
  const options={enabled:true,database:{prepare(){},exec(){}},storage:{resolve(){},requireSpace(){}},
    owner:'worker-1',stagingParent:'/private/cache/orthophoto-jpeg'};
  assert.throws(()=>createOrthophotoJpegService(options),{code:'jpeg_service_composition_required'});
  assert.throws(()=>createOrthophotoJpegService({...options,owner:'unsafe owner',assertRuntimeQualified:async()=>true}),
    {code:'jpeg_service_composition_required'});
  for(const stagingParent of ['/','/cache/../private','/private/','/private//dir','/private\0dir',
    '/private:dir','relative','/private\\dir','/'+ 'x'.repeat(4096)])
    assert.throws(()=>createOrthophotoJpegService({...options,stagingParent,assertRuntimeQualified:async()=>true}),
      {code:'jpeg_service_composition_required'},'bad configuration must reject before a real job can be claimed');
});

test('unqualified runtime cannot inspect the real kernel, touch storage or claim a queue row',async()=>{
  let calls=0;
  const unexpected=()=>assert.fail('queue/storage must remain untouched before qualification');
  const service=createOrthophotoJpegService({enabled:true,database:{prepare:unexpected,exec:unexpected},
    storage:{resolve:unexpected,requireSpace:unexpected},owner:'worker-1',stagingParent:'/private/cache/orthophoto-jpeg',
    assertRuntimeQualified:async context=>{calls++;context.assertCurrent();return false;}});
  await assert.rejects(service.runOne(),{code:'jpeg_worker_runtime_unqualified'});assert.equal(calls,1);
});

test('cancelled service run cannot enter qualification or acquire work',async()=>{
  const unexpected=()=>assert.fail('cancelled service must remain inert'),abort=new AbortController();abort.abort(new Error('stop'));
  const service=createOrthophotoJpegService({enabled:true,database:{prepare:unexpected,exec:unexpected},
    storage:{resolve:unexpected,requireSpace:unexpected},owner:'worker-1',stagingParent:'/private/cache/orthophoto-jpeg',
    assertRuntimeQualified:unexpected});
  await assert.rejects(service.runOne({signal:abort.signal}),/stop/);
});
