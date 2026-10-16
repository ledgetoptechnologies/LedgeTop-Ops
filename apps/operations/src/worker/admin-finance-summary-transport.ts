import type {CompanyFinanceSummary,FinancePeriod} from '../../../../packages/shared/src/admin-finance-summary';
import {withEnabledConfiguredProjectAlphaApiV2Connection,type ProjectAlphaApiV2ConnectionEnvironment} from './project-alpha-api-v2-connections';
import {decodeCompanyFinanceSummary} from './admin-finance-summary-boundary';

export type FinanceSummaryRead={status:'ok';summary:CompanyFinanceSummary}|{status:'unavailable'|'incompatible'|'forbidden';summary:null};
const LIMIT=128*1024;
function cancel(body:ReadableStream<Uint8Array>|null):void{if(body&&!body.locked)void body.cancel().catch(()=>undefined);}
function boundedWait<T>(pending:Promise<T>,signal:AbortSignal):Promise<T>{
  return new Promise((resolve,reject)=>{
    const aborted=()=>{signal.removeEventListener('abort',aborted);reject(Error('finance_deadline'));};
    if(signal.aborted){reject(Error('finance_deadline'));return;}
    signal.addEventListener('abort',aborted,{once:true});
    void pending.then(value=>{signal.removeEventListener('abort',aborted);resolve(value);},error=>{signal.removeEventListener('abort',aborted);reject(error);});
  });
}
async function bytes(response:Response,signal:AbortSignal):Promise<Uint8Array|null>{
  const length=response.headers.get('Content-Length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>LIMIT)){cancel(response.body);return null;}
  const reader=response.body?.getReader();if(!reader)return null;
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const part=await boundedWait(reader.read(),signal);if(part.done)break;
    size+=part.value.byteLength;if(size>LIMIT){void reader.cancel().catch(()=>undefined);return null;}chunks.push(part.value);}}
  catch{void reader.cancel().catch(()=>undefined);return null;}finally{reader.releaseLock();}
  const result=new Uint8Array(size);let offset=0;for(const part of chunks){result.set(part,offset);offset+=part.byteLength;}return result;
}

/** One bounded aggregate request. Credentials are confined to the configured
 * bridge; redirects, cookies, unbounded bodies and unpinned identities fail closed. */
export async function readConfiguredCompanyFinanceSummary(env:ProjectAlphaApiV2ConnectionEnvironment,sourceId:string,period:FinancePeriod,
  send:typeof fetch=fetch,timeoutMs=8000):Promise<FinanceSummaryRead>{
  const result=await withEnabledConfiguredProjectAlphaApiV2Connection(env,sourceId,async connection=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(Math.max(timeoutMs,1),8000));
    try{
      const url=new URL('/api/v2/financial-summary',connection.baseUrl);url.searchParams.set('from',period.from);url.searchParams.set('to',period.to);
      const headers=new Headers({Accept:'application/json',Authorization:'Bearer '+connection.apiKey,
        'X-PA-Source-Instance-ID':connection.expectedSourceInstanceId,'X-PA-Application-ID':connection.expectedApplicationId,
        'X-PA-History-Epoch':connection.expectedHistoryEpoch??''});
      if(connection.accessClientId&&connection.accessClientSecret){headers.set('CF-Access-Client-Id',connection.accessClientId);headers.set('CF-Access-Client-Secret',connection.accessClientSecret);}
      const pending=send(url,{method:'GET',headers,redirect:'manual',credentials:'omit',cache:'no-store',signal:controller.signal});
      void pending.then(response=>{if(controller.signal.aborted)cancel(response.body);},()=>undefined);
      const response=await boundedWait(pending,controller.signal);
      if(response.redirected||response.headers.has('Location')||response.headers.has('Set-Cookie')
        ||response.status>=300&&response.status<400){cancel(response.body);return{status:'incompatible',summary:null} as const;}
      if(response.status===401||response.status===403){cancel(response.body);return{status:'forbidden',summary:null} as const;}
      if(response.status!==200){cancel(response.body);return{status:response.status>=500?'unavailable':'incompatible',summary:null} as const;}
      if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type')??'')
        ||!(response.headers.get('Cache-Control')??'').split(',').some(value=>value.trim().toLowerCase()==='no-store')){
        cancel(response.body);return{status:'incompatible',summary:null} as const;}
      const requestId=response.headers.get('X-Request-ID');if(!requestId){cancel(response.body);return{status:'incompatible',summary:null} as const;}
      const body=await bytes(response,controller.signal);if(!body)return{status:controller.signal.aborted?'unavailable':'incompatible',summary:null} as const;
      const summary=decodeCompanyFinanceSummary(body,{sourceInstanceId:connection.expectedSourceInstanceId,
        applicationId:connection.expectedApplicationId,historyEpoch:connection.expectedHistoryEpoch??'',requestId,period});
      return summary?{status:'ok',summary} as const:{status:'incompatible',summary:null} as const;
    }catch{return{status:'unavailable',summary:null} as const;}finally{clearTimeout(timer);}
  });
  return result.status==='enabled'?result.value:{status:result.status==='disabled'?'forbidden':'incompatible',summary:null};
}
