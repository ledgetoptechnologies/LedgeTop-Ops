import {HTTPException} from 'hono/http-exception';

export function requireProjectAccessAuthorityMutations(env:{PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED?:string}):void{
  if(env.PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED!=='true')
    throw new HTTPException(503,{message:'project_access_authority_mutations_paused'});
}
