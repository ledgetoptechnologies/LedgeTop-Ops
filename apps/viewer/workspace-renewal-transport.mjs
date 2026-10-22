const PATH='/api/viewer/workspace/session-renewal';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN=/^[A-Za-z0-9_-]{32,128}$/;
const keys=(value,names)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('|')===[...names].sort().join('|');
export function exactRenewalOrigin(value){try{const url=new URL(value);return url.protocol==='https:'&&url.origin===value?value:null;}catch{return null;}}
const failure=(terminal=false)=>Object.assign(new Error('Workspace renewal transport unavailable'),{renewalAuthenticationRequired:terminal});
const terminalErrors=new Map([
  [401,new Set(['Cloudflare Access authentication required','Invalid Cloudflare Access authentication','A current human Cloudflare Access identity is required','Operations authorization is too close to expiry to renew'])],
  [403,new Set(['This Operations staff account is not bound to the current Access identity','Renewal subject does not match the authenticated Operations identity','Global viewer.view permission required'])],
]);
async function readJson(response,url,signal){
  if(signal?.aborted||response.redirected||response.url!==url||['opaqueredirect','opaque','error'].includes(response.type)||!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type')||''))throw failure();
  const reader=response.body?.getReader();if(!reader)throw failure();
  let size=0,text='';const decoder=new TextDecoder();
  try{for(;;){const {done,value}=await reader.read();if(signal?.aborted)throw failure();if(done)break;size+=value.byteLength;if(size>16384)throw failure();text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  let body;try{body=JSON.parse(text);}catch{throw failure();}
  if(!response.ok)throw failure(keys(body,['error'])&&terminalErrors.get(response.status)?.has(body.error));
  return body;
}

// Only the server-issued controller origin and the current Viewer origin are
// accepted. The session ID is a correlation hint, never authentication.
// No bearer, target URL, permissions, or expiry is sent to Operations.
export async function requestWorkspaceRenewalGrant({controllerOrigin,viewerOrigin,subject,sessionId,requestId,signal,fetchImpl=fetch,now=()=>Date.now()}){
  if(signal?.aborted||!exactRenewalOrigin(controllerOrigin)||!exactRenewalOrigin(viewerOrigin)||!UUID.test(requestId)||typeof sessionId!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(sessionId)||typeof subject!=='string'||!/^ops:[A-Za-z0-9._:@-]{1,196}$/.test(subject))throw failure();
  const endpoint=controllerOrigin+PATH,challengeUrl=endpoint+'/challenge';
  const common={mode:'cors',credentials:'include',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal};
  const challenge=await readJson(await fetchImpl(challengeUrl,{...common,method:'GET'}),challengeUrl,signal);
  if(!keys(challenge,['protocolVersion','challenge','expiresAt'])||challenge.protocolVersion!==1||!TOKEN.test(challenge.challenge)||!Number.isSafeInteger(challenge.expiresAt)||challenge.expiresAt*1000<=now())throw failure();
  if(signal?.aborted)throw failure();
  const grant=await readJson(await fetchImpl(endpoint,{...common,method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':challenge.challenge,'Idempotency-Key':requestId},body:JSON.stringify({protocolVersion:1,requestId,sessionId,subject})}),endpoint,signal);
  if(!keys(grant,['protocolVersion','requestId','sessionId','grant','grantExpiresAt','sessionTtlSeconds','redeemUrl'])||grant.protocolVersion!==1||grant.requestId!==requestId||grant.sessionId!==sessionId||!TOKEN.test(grant.grant)||!Number.isSafeInteger(grant.sessionTtlSeconds)||grant.sessionTtlSeconds<=0||!Number.isFinite(Date.parse(grant.grantExpiresAt))||Date.parse(grant.grantExpiresAt)<=now()||grant.redeemUrl!==viewerOrigin+'/api/v1/admin-sessions/redeem')throw failure();
  return grant.grant;
}
