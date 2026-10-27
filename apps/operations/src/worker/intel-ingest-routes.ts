import { dispatchCompetitorIntelIngest } from './competitor-intel-ingest-routes';
import { dispatchOwnerIntelSourceIngest } from './owner-intel-source-ingest';
import type { Env } from './types';

/** Shared incoming dispatcher used by the Worker fetch entrypoint. */
export async function dispatchIntelIngest(request:Request,env:Env,now=Date.now()):Promise<Response|null>{
 const source=dispatchOwnerIntelSourceIngest(request,env,now);
 if(source){const response=await source;if(response)return response;}
 const frozen=dispatchCompetitorIntelIngest(request,env,now);
 return frozen?await frozen:null;
}
