'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{parseResponse}=require('../server/nativeReferenceJsonCandidate');
test('native response parser rejects duplicate decoded keys at every depth',()=>{
  for(const json of ['{"x":1,"x":2}','{"x":1,"\\u0078":2}','{"job":{"id":1,"id":2}}','[{"a":1,"a":2}]','{"x":1,}','{"x":01}','{"job":{"generation":1.0000000000000001}}','{"job":{"generation":9007199254740993}}','{"x":"\\uZZZZ"}',`${'['.repeat(66)}0${']'.repeat(66)}`])assert.throws(()=>parseResponse(json));
  const valid='{"job":{"id":"a\\\"b","count":2},"extra":[true,null,{"µ":"ok"}]}';assert.deepEqual(parseResponse(valid),JSON.parse(valid));
});
