'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),p=require('../server/referenceProtocol'),v=require('./fixtures/source-retention-v2-proposal-vector.json');
test('public v2 proposal vector binds original manifest and synthetic snapshot intent',()=>{
 p.validateManifest(v.inputManifest);const payload=v.envelope.payload;
 assert.equal(payload.inputManifestSha256,p.manifestSha256(v.inputManifest));
 const closure=v.inputManifest.objects.map(({id,byteSize,sha256})=>({id,byteSize,sha256})).sort((a,b)=>Buffer.compare(Buffer.from(a.id),Buffer.from(b.id)));
 assert.deepEqual(payload.objects,closure);assert.deepEqual(v.sourceIntent.objects,closure);
 assert.equal(v.sourceIntent.manifestSha256,payload.inputManifestSha256);
 assert.equal(payload.snapshotId,`${payload.datasetId}@ltds-${p.sha256(p.canonicalBytes(v.sourceIntent)).slice(0,32)}`);
 const msg=(prefix,value)=>Buffer.concat([Buffer.from(prefix,'ascii'),Buffer.from([0]),p.canonicalBytes(value)]),source=msg('LTDS-SOURCE-CLOSURE-V2',closure),signed=msg('LTDS-SOURCE-RETENTION-V2',payload);
 assert.equal(source.toString('base64'),v.closureMessageBase64);assert.equal(p.sha256(source),payload.sourceClosureSha256);
 assert.equal(signed.toString('base64'),v.signedMessageBase64);assert.equal(p.sha256(signed),v.signedMessageSha256);
 const key=crypto.createPublicKey({key:Buffer.from(v.publicKeySpkiDerBase64,'base64'),format:'der',type:'spki'});assert.equal(crypto.verify(null,signed,key,Buffer.from(v.envelope.signature,'base64url')),true);
});
