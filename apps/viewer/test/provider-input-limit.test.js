'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { NodeOdmProvider } = require('../server/nodeOdmProvider');
const { exceedsProviderInputLimit, uploadBatchEnd } = require('../server/providerInputLimit');

test('optional coordinator cap is recognized only as a positive safe integer', async () => {
  let limit;
  const fetchImpl = async input => new Response(JSON.stringify(String(input).endsWith('/info')
    ? {version:'2.2.3',engine:'odm',engineVersion:'3.5.6',taskQueueCount:0,maxImages:null,ledgetopMaxInputBytes:limit} : []),
  {headers:{'content-type':'application/json'}});
  const provider = new NodeOdmProvider({endpoint:'http://localhost:3000',fetchImpl});
  for (limit of [undefined, null, 0, -1, 1.5, '42', Number.MAX_SAFE_INTEGER + 1])
    assert.equal((await provider.capabilities()).capabilities.ledgetopMaxInputBytes, undefined);
  limit = 42;
  assert.equal((await provider.capabilities()).capabilities.ledgetopMaxInputBytes, 42);
});

test('request batching reserves framing, rejects an oversized file, and preserves legacy batches', () => {
  const files = Array.from({length:25}, (_, i) => ({relativePath:`photo-${i}.jpg`,byteSize:10000}));
  assert.equal(uploadBatchEnd(files,0,undefined),20);
  assert.equal(uploadBatchEnd(files,0,100000),2);
  assert.equal(uploadBatchEnd(files,2,100000),4);
  assert.throws(() => uploadBatchEnd([{relativePath:'x.jpg',byteSize:100000}],0,100000), {code:'provider_upload_file_too_large'});
});

test('task ceiling counts images and auxiliary inputs together without overflowing', () => {
  const files = [{byteSize:30},{byteSize:11},{byteSize:1}];
  assert.equal(exceedsProviderInputLimit(files,42), false);
  assert.equal(exceedsProviderInputLimit(files,41), true);
  assert.equal(exceedsProviderInputLimit(files,undefined), false);
  assert.equal(exceedsProviderInputLimit([{byteSize:Number.MAX_SAFE_INTEGER},{byteSize:1}],Number.MAX_SAFE_INTEGER),true);
  assert.throws(() => exceedsProviderInputLimit([{byteSize:-1}],42), {code:'dataset_source_changed'});
});

test('upload reports known 413 errors without treating the response as an acceptance receipt', async () => {
  for (const reason of ['task_input_limit_exceeded','body_too_large','unrecognized']) {
    const fetchImpl = async () => new Response(JSON.stringify({error:reason}),{status:413,headers:{'content-type':'application/json'}});
    const provider = new NodeOdmProvider({endpoint:'http://localhost:3000',fetchImpl});
    await assert.rejects(provider.upload('test',[{relativePath:'a.jpg',buffer:Buffer.from('x')}]), error => {
      assert.equal(error.status,413);
      assert.equal(error.code,reason === 'unrecognized' ? 'provider_request_failed' : reason);
      if (reason !== 'unrecognized') assert.match(error.message,/some files may have been accepted/);
      return true;
    });
  }
});

test('serialized multipart batch fits the advertised request limit', async () => {
  const max=100000;
  const inputs=Array.from({length:5},(_,i)=>({relativePath:`photo-${i}.jpg`,byteSize:10000,buffer:Buffer.alloc(10000, i)}));
  const end=uploadBatchEnd(inputs,0,max);
  let observedBytes=0;
  const fetchImpl=async (url,init)=>{
    const request=new Request(url,init);
    observedBytes=(await request.arrayBuffer()).byteLength;
    return new Response(JSON.stringify({success:true}),{headers:{'content-type':'application/json'}});
  };
  await new NodeOdmProvider({endpoint:'http://localhost:3000',fetchImpl}).upload('task',inputs.slice(0,end));
  assert.ok(observedBytes<=max,`multipart body ${observedBytes} exceeds ${max}`);
  assert.equal(end,2);
});
