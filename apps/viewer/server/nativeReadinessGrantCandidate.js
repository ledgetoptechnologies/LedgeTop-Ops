'use strict';
// Inactive verifier experiment: the caller must supply trusted peer identity,
// issuer public key and clock. No issuer, transport or deployment is wired.
const crypto=require('node:crypto');
const {digest}=require('./nativeReadinessRequestDigestCandidate');
const names=['version','issuer','audience','peerUid','requestId','attemptId','jobId','projectId','subject','owner','requestDigest','notBefore','expiresAt'];
const signatureDomain=Buffer.from('viewer-readiness-grant-v1\0');
const part=/^[A-Za-z0-9_-]+$/;
function authorize(request,{token,peerUid,publicKey,issuer,expectedAction=null,nowMs=Date.now()}={}){
  try{
    if(typeof token!=='string'||token.length>8192||typeof peerUid!=='string'||typeof issuer!=='string'||!issuer||!Number.isSafeInteger(nowMs))return false;
    const pieces=token.split('.');if(pieces.length!==2||pieces.some(p=>!part.test(p)))return false;
    const bytes=Buffer.from(pieces[0],'base64url'),signature=Buffer.from(pieces[1],'base64url');if(bytes.toString('base64url')!==pieces[0]||signature.length!==64||signature.toString('base64url')!==pieces[1])return false;
    const key=crypto.createPublicKey(publicKey);if(key.asymmetricKeyType!=='ed25519'||!crypto.verify(null,Buffer.concat([signatureDomain,bytes]),key,signature))return false;
    const json=bytes.toString('utf8'),claims=JSON.parse(json),required=expectedAction===null?names:[...names,'action'];if(expectedAction!==null&&!['prepare','confirm','complete'].includes(expectedAction))return false;if(!Buffer.from(json).equals(bytes)||JSON.stringify(claims)!==json||!claims||Array.isArray(claims)||Object.getPrototypeOf(claims)!==Object.prototype||Object.keys(claims).sort().join('|')!==[...required].sort().join('|'))return false;
    return claims.version===1&&claims.issuer===issuer&&claims.audience==='viewer-readiness'&&(expectedAction===null||claims.action===expectedAction)&&claims.peerUid===peerUid&&claims.requestId===request.requestId&&claims.attemptId===request.attemptId&&claims.jobId===request.jobId&&claims.projectId===request.event.projectId&&claims.subject===request.event.requestedBySubject&&claims.owner===request.owner&&claims.requestDigest===digest(request)&&Number.isSafeInteger(claims.notBefore)&&Number.isSafeInteger(claims.expiresAt)&&claims.notBefore<=nowMs&&nowMs<claims.expiresAt&&claims.expiresAt-claims.notBefore<=300000&&claims.expiresAt>claims.notBefore;
  }catch{return false;}
}
module.exports={authorize};
