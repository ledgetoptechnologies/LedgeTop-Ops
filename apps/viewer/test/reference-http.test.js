'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {Readable} = require('node:stream');
const {ReferenceTransferBroker} = require('../server/referenceTransferBroker');
const p = require('../server/referenceProtocol');
const {createReferenceBrokerHandler} = require('../server/referenceHttp');

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'reference-http-'));
  const source = path.join(root,'image.jpg'); fs.writeFileSync(source,'abcdef');
  const broker = new ReferenceTransferBroker({databasePath:path.join(root,'private.db'),managedRoot:root,environment:'staging',allowCreate:true});
  const manifest = {id:'manifest-1',revision:1,sha256:'0'.repeat(64),totalBytes:6,objectCount:1,
    inputCounts:{images:1,lidarObjects:0,points:0},objects:[{id:'image-1',name:'image.jpg',byteSize:6,sha256:p.sha256('abcdef'),kind:'image',mediaType:'image/jpeg'}]};
  manifest.sha256=p.manifestSha256(manifest);
  const capabilities=p.createCapabilities('staging');
  const minted=broker.mintGrant({jobId:'job-1',generation:1,manifest,reservationAvailable:true,
    reservation:{reservationId:'reservation-1',generation:1,expiresAt:new Date(Date.now()+60000).toISOString(),
      manifestSha256:manifest.sha256,byteBudget:18,nonce:'nonce-1'},objectFiles:{'image-1':source},capabilities,
    capabilityFingerprint:capabilities.capabilityFingerprint});
  // Unit fixture only: this trusted callback models validated TLS termination.
  // The default handler is tested separately; no forwarded header enables it.
  const handler=createReferenceBrokerHandler({broker,enabled:true,isProtectedTransport:()=>true,...options});
  const server=http.createServer((req,res)=>{handler(req,res).then(handled=>{if(!handled){res.statusCode=404;res.end();}}).catch(()=>{res.destroy();});});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));broker.close();fs.rmSync(root,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${server.address().port}`;
  return {broker,minted,source,server,origin,handler,authorization:'Bearer '+minted.grant.token,
    get(extra={}){return fetch(origin+'/api/processing/reference/v1/objects/image-1',{headers:{authorization:this.authorization,...extra}});}};
}
test('actual broker HTTP route preserves exact headers and range bytes without token URLs',async t=>{
  const f=await fixture(t),response=await f.get({range:'bytes=1-3'});
  assert.equal(response.status,206);assert.equal(response.headers.get('content-type'),'application/octet-stream');
  assert.equal(response.headers.get('content-length'),'3');assert.equal(response.headers.get('content-range'),'bytes 1-3/6');
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(await response.text(),'bcd');
  const whole=await f.get();assert.equal(whole.status,200);assert.equal(await whole.text(),'abcdef');
});
test('inactive route and unprotected transport never enter the broker',async t=>{
  for(const options of [{enabled:false},{isProtectedTransport:req=>req.socket.encrypted===true}]){
    const f=await fixture(t,options),response=await f.get({'x-forwarded-proto':'https'});
    assert.equal(response.status,options.enabled===false?404:503);assert.equal(f.broker.streams.size,0);
    assert.doesNotMatch(await response.text(),/abcdef|Bearer|private\.db/);
  }
});
test('method, query credential, malformed range and missing bearer are rejected without file disclosure',async t=>{
  const f=await fixture(t);
  const cases=[['?token='+encodeURIComponent(f.minted.grant.token),{},400],['',{},401],['',{method:'POST',headers:{authorization:f.authorization}},405],['',{headers:{authorization:f.authorization,range:'bytes=0-1,4-5'}},416]];
  for(const [suffix,init,status] of cases){const response=await fetch(f.origin+'/api/processing/reference/v1/objects/image-1'+suffix,init);assert.equal(response.status,status);assert.doesNotMatch(await response.text(),/abcdef|Bearer|private\.db/);}
});
test('pre-header source change becomes a bounded error and revocation denies further reads',async t=>{
  const f=await fixture(t);fs.writeFileSync(f.source,'changed');
  const failed=await f.get();assert.equal(failed.status,409);assert.deepEqual(await failed.json(),{error:'source_unavailable'});
  f.broker.revokeGrant(f.minted.grantId);const revoked=await f.get();assert.equal(revoked.status,401);
});
test('error before first streamed byte clears binary length and never serializes the raw error',async t=>{
  const broker={async readAuthorizedObject(){return{status:200,headers:{'Content-Length':'999','Content-Type':'application/octet-stream'},
    body:new Readable({read(){this.destroy(new Error('private source path and bearer must stay private'));}})};}};
  const f=await fixture(t,{broker}),response=await f.get();
  assert.equal(response.status,409);assert.equal(response.headers.get('content-range'),null);
  assert.deepEqual(await response.json(),{error:'source_unavailable'});
});
test('aborted HTTP response destroys the paused source instead of holding a transfer allocation',async t=>{
  let body, started;
  const waiting=new Promise(resolve=>{started=resolve;});
  const broker={async readAuthorizedObject(){body=new Readable({read(){if(!this.sent){this.sent=true;this.push('a');started();}}});
    return{status:200,headers:{'Content-Type':'application/octet-stream'},body};}};
  const f=await fixture(t,{broker});
  await new Promise((resolve,reject)=>{
    const request=http.get(f.origin+'/api/processing/reference/v1/objects/image-1',{headers:{authorization:f.authorization}},response=>{
      response.once('data',()=>{const closed=once(body,'close');response.destroy();closed.then(resolve,reject);});
      response.on('error',()=>{});
    });request.on('error',reject);
  });
  await waiting;assert.equal(body.destroyed,true);
});
