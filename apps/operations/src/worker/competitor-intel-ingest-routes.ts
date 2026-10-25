import type { Env } from './types';
import { IntelIngestError,strictIntelJson,validateIntelObservation } from './competitor-intel-ingest-schema';
import { INTEL_INGEST_PATH,intelSignatureHeaders,readIntelBody,verifyIntelSignature } from './competitor-intel-ingest-security';
import { acceptIntelObservation,readIngestProducerKey } from './competitor-intel-ingest-store';
export type IntelIngestEnvironment=Pick<Env,'OPS_DB'|'ENVIRONMENT'|'INCOMING_BASE_URL'|'INCOMING_EXPECTED_HOST'> & {COMPETITOR_INTEL_INGEST_ENABLED?:string};
function json(value:unknown,status=200){return Response.json(value,{status,headers:{'Cache-Control':'no-store','Cloudflare-CDN-Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
/** Incoming-host machine admission for this exact path only. All human and
 * unrelated incoming routes retain their existing admission and credentials. */
export function dispatchCompetitorIntelIngest(request:Request,env:IntelIngestEnvironment,now=Date.now()):Promise<Response>|null {
 const url=new URL(request.url);if(url.pathname!==INTEL_INGEST_PATH||url.username||url.password)return null;
 try{const incoming=new URL(env.INCOMING_BASE_URL);if(incoming.origin!==env.INCOMING_BASE_URL||incoming.protocol!=='https:'||incoming.host!==env.INCOMING_EXPECTED_HOST
  ||url.origin!==incoming.origin||env.ENVIRONMENT==='production'&&incoming.origin!=='https://incoming.ledgetopdroneservices.com')return null;}catch{return null;}
 if(env.COMPETITOR_INTEL_INGEST_ENABLED!=='true')return Promise.resolve(json({error:'not_found'},404));
 return (async()=>{try{
  const control=await env.OPS_DB.withSession('first-primary').prepare('SELECT enabled FROM ci_ingest_control WHERE singleton=1').first<{enabled:number}>();
  if(control?.enabled!==1)return json({error:'not_found'},404);
  const headers=intelSignatureHeaders(request,now),key=await readIngestProducerKey(env.OPS_DB,headers.producer,headers.keyId);
  if(!['active','previous'].includes(key.state))throw new IntelIngestError('key_not_active',403);
  const raw=await readIntelBody(request);await verifyIntelSignature(raw,headers,key);
  const observation=validateIntelObservation(strictIntelJson(raw),headers.producer,now);
  return json(await acceptIntelObservation(env.OPS_DB,key,observation,raw,headers.digest,now));
 }catch(error){return error instanceof IntelIngestError?json({error:error.code},error.status):json({error:'retryable'},503);}})();
}
