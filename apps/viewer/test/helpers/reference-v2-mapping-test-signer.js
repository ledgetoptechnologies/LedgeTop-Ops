'use strict';
// PUBLIC TEST KEY: every byte is intentionally disclosed. Never use this key,
// this helper, or its signatures for a real issuer or authorization decision.
const fs=require('node:fs'),crypto=require('node:crypto'),p=require('../../server/referenceProtocol');
const fields='version kind issuer keyId audience operation issuedAt expiresAt nonce environment trustDomain coordinatorDeploymentId coordinatorAuthorityId coordinatorEpoch viewerDeploymentId viewerLedgerId viewerLedgerEpoch viewerAttemptId coordinatorAttemptId submissionId jobId generation manifestSha256 pipelineDigest intentDigest claimLineageSha256'.split(' ');
const domain=Buffer.from('ltds-v2-two-attempt-binding-experiment-v1\0','ascii');
const privateKey=crypto.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,0x51)]),format:'der',type:'pkcs8'});
function signPublicFixture(raw){
 if(!Buffer.isBuffer(raw)||!raw.length||raw.length>16384||[...raw].some(x=>x>127))throw Error('invalid public fixture');
 const body=JSON.parse(raw.toString('ascii'));if(!body||Object.getPrototypeOf(body)!==Object.prototype||Object.keys(body).length!==fields.length||fields.some(k=>!Object.hasOwn(body,k))||!p.canonicalBytes(body).equals(raw)||body.version!==1||body.kind!=='attempt-mapping'||body.operation!=='bind-attempt'||body.issuer!=='viewer'||body.keyId!=='fixture-key'||body.environment!=='staging'||body.trustDomain!=='test'||body.audience!=='coord-deploy'||body.coordinatorDeploymentId!=='coord-deploy'||body.viewerDeploymentId!=='viewer-deploy'||body.coordinatorAuthorityId!=='00000000-0000-4000-8000-000000000004')throw Error('invalid public fixture');
 return {scope:'public_test_key_not_authority',publicKeySpkiDerHex:crypto.createPublicKey(privateKey).export({format:'der',type:'spki'}).toString('hex'),signatureBase64url:crypto.sign(null,Buffer.concat([domain,raw]),privateKey).toString('base64url')};
}
if(require.main===module){try{const chunks=[];let total=0,n;const buffer=Buffer.alloc(4096);while((n=fs.readSync(0,buffer,0,buffer.length,null))>0){total+=n;if(total>16384)throw Error('invalid public fixture');chunks.push(Buffer.from(buffer.subarray(0,n)))}const result=signPublicFixture(Buffer.concat(chunks));process.stdout.write(JSON.stringify(result)+'\n')}catch{process.stderr.write('invalid public fixture\n');process.exitCode=1}}
module.exports={signPublicFixture};
