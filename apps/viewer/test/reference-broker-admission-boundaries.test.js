'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { ReferenceTransferBroker } = require('../server/referenceTransferBroker');
const p = require('../server/referenceProtocol');

function setup(t, size, contentHash, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-admission-boundary-'));
  const source = path.join(root, 'source.jpg');
  const fd = fs.openSync(source, 'w'); fs.ftruncateSync(fd, size); fs.closeSync(fd);
  const broker = new ReferenceTransferBroker({ databasePath:path.join(root,'broker.db'), managedRoot:root,
    environment:'staging', allowCreate:true, ...options });
  t.after(() => { broker.close(); fs.rmSync(root, {recursive:true, force:true}); });
  const manifest = {id:'m-1',revision:1,sha256:'0'.repeat(64),totalBytes:size,objectCount:1,
    inputCounts:{images:1,lidarObjects:0,points:0},objects:[{id:'object-1',name:'source.jpg',byteSize:size,sha256:contentHash,kind:'image',mediaType:'image/jpeg'}]};
  manifest.sha256 = p.manifestSha256(manifest);
  const capabilities = p.createCapabilities('staging');
  const minted = broker.mintGrant({jobId:'job-1',generation:1,manifest,reservationAvailable:true,
    reservation:{reservationId:'reservation-1',generation:1,expiresAt:new Date(Date.now()+60000).toISOString(),manifestSha256:manifest.sha256,byteBudget:size*3,nonce:'nonce-1'},
    objectFiles:{'object-1':source},capabilities,capabilityFingerprint:capabilities.capabilityFingerprint});
  return {broker, req:{grantId:minted.grantId,objectId:'object-1',authorization:'Bearer '+minted.grant.token,method:'GET'}};
}

test('default whole-object response cap refuses a >16 MiB object before streaming', async t => {
  const f = setup(t, 16777217, 'a'.repeat(64));
  await assert.rejects(f.broker.readObject(f.req), {code:'TRANSFER_LIMIT'});
  assert.equal(f.broker.db.prepare('SELECT requests FROM reference_job_usage').get().requests, 0);
});

test('abort and retry each charge full response and cannot exceed cumulative budget', async t => {
  const f = setup(t, 3, p.sha256(Buffer.alloc(3)));
  const first = await f.broker.readObject(f.req); first.body.destroy(); await once(first.body, 'close');
  for (let i=0; i<2; i++) { const next=await f.broker.readObject(f.req); for await (const chunk of next.body) assert.equal(chunk.length,3); }
  await assert.rejects(f.broker.readObject(f.req), {code:'TRANSFER_LIMIT'});
  assert.deepEqual({...f.broker.db.prepare('SELECT requests,charged_bytes FROM reference_job_usage').get()}, {requests:3,charged_bytes:9});
});

test('whole-object 10000-photo minimum exceeds the actual broker default request limit', t => {
  const f=setup(t, 3, p.sha256(Buffer.alloc(3)));
  assert.equal(f.broker.settings.maxRequests, 100);
  assert.ok(10000 > f.broker.settings.maxRequests);
});
