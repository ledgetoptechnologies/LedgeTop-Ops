let csrf="";
export function setCsrf(value:string){csrf=value;}
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
