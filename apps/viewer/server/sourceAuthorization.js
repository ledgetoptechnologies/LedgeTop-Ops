'use strict';
const crypto=require('node:crypto');const {config}=require('./config');const {signViewerEvent}=require('./viewerEvents');const {boundedText}=require('./nodeOdmProvider');
const PATH='/api/viewer/source-authorizations/introspect';

class SourceAuthorizationValidator{
  constructor({enabled=config.clientViewerSharesEnabled,baseUrl=config.opsAutomationBaseUrl,keyId=config.viewerEventKeyId,secret=config.viewerEventSecret,fetchImpl=fetch,positiveMs=5000,refreshMs=3000,negativeMs=1000,timeoutMs=3000,now=()=>Date.now(),monotonic=()=>performance.now()}={}){this.enabled=Boolean(enabled);this.baseUrl=baseUrl;this.keyId=keyId;this.secret=secret;this.fetch=fetchImpl;this.positiveMs=Math.min(5000,Math.max(250,positiveMs));this.refreshMs=Math.min(this.positiveMs,Math.max(0,refreshMs));this.negativeMs=Math.min(1000,Math.max(100,negativeMs));this.timeoutMs=Math.min(5000,Math.max(250,timeoutMs));this.now=now;this.monotonic=monotonic;this.cache=new Map();this.pending=new Map();}
  key(share){const source=share.sourceAuthorization;return crypto.createHash('sha256').update(JSON.stringify([source.id,source.version,source.subject,share.modelId,share.id])).digest('hex');}
  configured(){try{const url=new URL(this.baseUrl);return this.enabled&&url.origin===this.baseUrl&&url.protocol==='https:'&&url.username===''&&url.password===''&&url.pathname==='/'&&!url.search&&!url.hash&&this.secret.length>=32&&/^[A-Za-z0-9._-]{1,64}$/.test(this.keyId);}catch{return false;}}
  // Age of a stored decision on whichever clock moved further, so neither a
  // wall-clock change nor a paused monotonic clock can lengthen it.
  age(entry){return Math.max(this.now()-entry.wallStart,this.monotonic()-entry.monotonicStart);}
  // The lifetime runs from the start of the check and also ends at the source expiry.
  live(entry){return this.age(entry)<entry.lifeMs;}
  async allows(share){if(!share||share.shareClass!=='client')return true;const source=share.sourceAuthorization;if(!this.configured()||!source||source.type!=='client_grant'||typeof source.id!=='string'||!Number.isSafeInteger(source.version)||source.version<1||typeof source.subject!=='string'||!source.subject)return false;const sourceExpiry=source.expiresAt===null?null:Date.parse(source.expiresAt);if(sourceExpiry!==null&&(!Number.isFinite(sourceExpiry)||sourceExpiry<=this.now()))return false;const key=this.key(share),cached=this.cache.get(key);if(cached&&this.live(cached)){if(cached.allowed&&this.age(cached)>=cached.refreshAge&&!this.pending.has(key)){cached.refreshAge=this.age(cached)+this.negativeMs;this.start(key,share,sourceExpiry);}return cached.allowed;}if(cached)this.cache.delete(key);const decision=await(this.pending.get(key)||this.start(key,share,sourceExpiry));return decision.allowed&&this.live(decision);}
  // One check per share at a time. An allow lasts positiveMs from the moment its
  // check STARTED, so Operations decided after that moment and the revocation
  // lag is at most positiveMs, whether the check was waited for or ran in the
  // background. The limit is enforced again when the answer arrives and when
  // each waiting request resumes, as on every cache hit: an allow that arrives or
  // is picked up after its own limit is no allow. A background check never
  // extends the decision it refreshes: an allow replaces it, a refusal replaces
  // it at once, and no decision leaves its expiry alone, after which requests
  // wait for a new check and are denied if that fails too. Never rejects.
  start(key,share,sourceExpiry){const decision={allowed:false,wallStart:this.now(),monotonicStart:this.monotonic(),lifeMs:0,refreshAge:this.refreshMs};decision.lifeMs=Math.min(this.positiveMs,sourceExpiry===null?Infinity:sourceExpiry-decision.wallStart);const promise=(async()=>{try{decision.allowed=await this.check(share)&&this.live(decision);}catch{if(this.cache.get(key)?.allowed)return decision;}if(!decision.allowed)decision.lifeMs=this.negativeMs;this.cache.set(key,decision);while(this.cache.size>10000)this.cache.delete(this.cache.keys().next().value);return decision;})().finally(()=>this.pending.delete(key));this.pending.set(key,promise);return promise;}
  // True or false is a decision from Operations. Throws when there is none:
  // unreachable, timed out, overloaded or failing.
  async check(share){const source=share.sourceAuthorization,url=new URL(PATH,this.baseUrl),body=JSON.stringify({authorizationId:source.id,authorizationVersion:source.version,subject:source.subject,modelId:share.modelId,shareId:share.id}),headers=signViewerEvent({secret:this.secret,keyId:this.keyId,method:'POST',path:PATH,body}),response=await this.fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(this.timeoutMs),headers:{...headers,'Content-Type':'application/json'},body});if(response.status===429||response.status>=500)throw new Error('Operations gave no decision');if(!response.ok)return false;if(!String(response.headers.get('content-type')||'').includes('json'))return false;const text=await boundedText(response,64*1024);let result;try{result=JSON.parse(text);}catch{return false;}const keys=Object.keys(result||{}).sort().join(',');if(keys!=='active,authorizationId,authorizationVersion,expiresAt,modelId,subject'||typeof result.active!=='boolean'||result.authorizationId!==source.id||result.authorizationVersion!==source.version||result.subject!==source.subject||result.modelId!==share.modelId||result.expiresAt!==source.expiresAt)return false;return result.active&&(result.expiresAt===null||Date.parse(result.expiresAt)>this.now());}
}

const sourceAuthorizationValidator=new SourceAuthorizationValidator();
module.exports={PATH,SourceAuthorizationValidator,sourceAuthorizationValidator};
