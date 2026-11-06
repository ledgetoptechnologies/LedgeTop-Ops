'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createTransport}=require('../server/nativeEpochTransportCandidate');
const task='00000000-0000-4000-8000-000000000001',operation='00000000-0000-4000-8000-000000000002',capability='a'.repeat(43);
test('candidate transport rejects non-loopback and disabled configurations',()=>{
  for(const endpoint of ['http://example.com:80','http://192.168.50.90:80','http://127.0.0.1:80/path','http://user:secret@127.0.0.1:80'])assert.throws(()=>createTransport({endpoint,environmentToken:'test',enabled:true}),{code:'native_epoch_hold'});
  assert.throws(()=>createTransport({endpoint:'http://127.0.0.1:80',environmentToken:'test'}),{code:'native_epoch_hold'});
  for(const token of ['','bad,token','bad\ntoken','contains space'])assert.throws(()=>createTransport({endpoint:'http://127.0.0.1:1234',environmentToken:token,enabled:true}),{code:'native_epoch_hold'});
});
test('loopback transport sends exact canonical body and holds redirects or malformed replies',async t=>{
  let seen;const server=http.createServer((req,res)=>{let data=[];req.on('data',part=>data.push(part));req.on('end',()=>{seen={method:req.method,path:req.url,capability:req.headers['x-ledgetop-capability'],environment:req.headers['x-ledgetop-environment-token'],body:Buffer.concat(data).toString('utf8')};if(req.url.includes('/revoke')){res.writeHead(302,{location:'http://example.invalid/'});res.end();}else if(req.url.includes('/intent')){res.writeHead(200,{'content-type':'application/json'});res.end('{"x":1,"x":2}');}else{res.writeHead(200,{'content-type':'application/json'});res.end('{"result":"ok"}');}});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const client=createTransport({endpoint:`http://127.0.0.1:${server.address().port}`,environmentToken:'synthetic',enabled:true});
  assert.deepEqual(await client.request('open',task,operation,capability,{schemaVersion:2,operationKind:'plan_bind',manifestId:'test',manifestSha256:'a'.repeat(64)}),{result:'ok'});
  assert.equal(seen.method,'POST');assert.equal(seen.capability,capability);assert.equal(seen.environment,'synthetic');assert.equal(seen.body,`{"manifestId":"test","manifestSha256":"${'a'.repeat(64)}","operationKind":"plan_bind","schemaVersion":2}`);assert.match(seen.path,/\/1\/1\/open$/);
  await assert.rejects(client.request('revoke',task,operation,capability,{schemaVersion:2}),{code:'native_epoch_hold'});
  await assert.rejects(client.request('intent',task,operation,capability,Buffer.from('{}')),{code:'native_epoch_hold'});
  assert.throws(()=>createTransport({endpoint:'https://127.0.0.1:443',environmentToken:'test',enabled:true}),{code:'native_epoch_hold'});
});
