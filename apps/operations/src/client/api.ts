let csrf="";
export function setCsrf(value:string){csrf=value;}
/** A short, non-reversible label for the current staff session (never the token itself). */
let sessionActor="";
/** The signed-in staff id, set once the session loads (scopes per-action retry keys to the person, not the token). */
export function setSessionActor(id:string){sessionActor=id;}
/** A short, non-reversible label for the signed-in staff member; stable across CSRF/session renewals. */
export function sessionScope():string{let h=0x811c9dc5;for(let i=0;i<sessionActor.length;i++){h^=sessionActor.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}return sessionActor?h.toString(36):"anonymous";}
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
export async function api<T>(path:string,init:RequestInit={}):Promise<T>{const headers=new Headers(init.headers);if(init.body&&!headers.has("Content-Type"))headers.set("Content-Type","application/json");if(init.method&&!["GET","HEAD"].includes(init.method.toUpperCase()))headers.set("X-CSRF-Token",csrf);const response=await fetch(path,{credentials:"same-origin",...init,headers});const payload=await response.json().catch(()=>({})) as T&{error?:string};if(!response.ok)throw new ApiError(payload.error||`Request failed (${response.status})`,response.status,payload as Record<string,unknown>);return payload;}
