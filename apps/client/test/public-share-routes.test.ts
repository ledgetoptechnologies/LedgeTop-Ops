import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers",()=>({WorkflowEntrypoint:class{},WorkerEntrypoint:class{}}));
import worker from "../src/worker/index";
import { createSessionCookie, hmac, sha256 } from "../src/worker/security";
import type { PublicShareLifecycleRow } from "../src/worker/public-share-lifecycle";

const fragment="f".repeat(48),sessionSecret="s".repeat(48),pepper="p".repeat(48);

async function fixture(patch:Partial<PublicShareLifecycleRow>={},options:{missing?:boolean;accessCode?:string;raceAccessCodeChange?:boolean}={}){
  const base:PublicShareLifecycleRow={id:"share-a",public_id:"public-a",project_id:"project-a",token_hash:await sha256(fragment),label:null,password_hash:null,password_salt:null,password_iterations:null,password_algorithm:null,expires_at:null,revoked_at:null,revoked_reason:null,unavailable_since:null,share_version:3,client_name:"Acme",project_name:"Site",r2_prefix:"jobs/acme/",project_active:1,project_exists:1};
  const share={...base,...patch};
  if(options.accessCode){share.password_salt="salt-a";share.password_iterations=1;share.password_algorithm="hmac-sha256-v1";share.password_hash=await hmac(pepper,`access-code:v1:${share.password_salt}:${options.accessCode}`);}
  const statements:string[]=[];let lifecycleReads=0;
  const db:any={prepare(query:string){statements.push(query);let values:unknown[]=[];const statement={bind(...bound:unknown[]){values=bound;return statement;},async first<T>(){
    if(query.includes("FROM shares s LEFT JOIN projects")){
      lifecycleReads+=1;
      if(options.missing)return null;
      if(query.includes("s.token_hash=?")&&!values.includes(share.token_hash))return null;
      if(query.includes("s.public_id=?")&&!values.includes(share.public_id))return null;
      if(query.includes("s.id=?")&&!values.includes(share.id))return null;
      if(options.raceAccessCodeChange&&lifecycleReads>1)return{...share,share_version:share.share_version+1,password_hash:"concurrently-changed-hash"} as T;
      return share as T;
    }
    if(query.includes("SELECT public_id,share_version FROM shares"))return{public_id:share.public_id,share_version:share.share_version} as T;
    return null;
  },async all<T>(){return{results:[] as T[]};},async run(){return{meta:{changes:1}};}};return statement;},withSession(){return db;},async batch(items:any[]){return Promise.all(items.map(item=>item.run?item.run():{meta:{changes:1}}));}};
  const limiter={async limit(){return{success:true};}};
  const env:any={ENVIRONMENT:"development",EXPECTED_HOST:"client.example",DELIVERY_DB:db,DATA_BUCKET:{async list(){return{objects:[{key:"jobs/acme/photo.jpg"}],delimitedPrefixes:[],truncated:false};}},PUBLIC_SESSION_RATE_LIMITER:limiter,PUBLIC_MEDIA_RATE_LIMITER:limiter,ACCESS_CODE_RATE_LIMITER:limiter,DELIVERY_SESSION_SECRET:sessionSecret,SESSION_KEY_ID:"v1",DELIVERY_ACCESS_CODE_PEPPER:pepper,AUDIT_IP_SECRET:"a".repeat(48)};
  const ctx:any={waitUntil(promise:Promise<unknown>){void promise.catch(()=>undefined);},passThroughOnException(){}};
  return{env,ctx,share,statements};
}

async function exchange(value:Awaited<ReturnType<typeof fixture>>,secret=fragment,accessCode?:string){
  return worker.fetch(new Request("https://client.example/api/public/shares/public-a/session",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({secret,accessCode})}),value.env,value.ctx);
}

describe("public share session lifecycle routes",()=>{
  it("exchanges a valid never-expire fragment and issues a host-only session",async()=>{
    const response=await exchange(await fixture());
    expect(response.status).toBe(200);expect(response.headers.get("Set-Cookie")).toContain("__Host-ltds_delivery=");expect(response.headers.get("Set-Cookie")).toMatch(/Max-Age=43(?:199|200)/);
  });
  it.each([
    [{expires_at:"2000-01-01T00:00:00Z"},"SHARE_EXPIRED"],
    [{revoked_at:"2026-08-15T00:00:00Z",revoked_reason:"manual"},"SHARE_REVOKED"],
    [{project_active:0},"SHARE_PROJECT_INACTIVE"],
    [{project_exists:0},"SHARE_RESOURCE_REMOVED"],
  ] as const)("returns an explicit lifecycle code for %j",async(patch,code)=>{
    const response=await exchange(await fixture(patch));expect(response.status).toBe(410);expect(await response.json()).toMatchObject({code});
  });
  it("does not reveal lifecycle details for a bad fragment or mismatched public id",async()=>{
    const value=await fixture(),warnings:unknown[]=[];const warning=vi.spyOn(console,"warn").mockImplementation(record=>{warnings.push(record);});
    const bad="x".repeat(48);
    expect(await (await exchange(value,bad)).json()).toMatchObject({code:"SHARE_INVALID"});
    const response=await worker.fetch(new Request("https://client.example/api/public/shares/other/session",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({secret:fragment})}),value.env,value.ctx);
    expect(await response.json()).toMatchObject({code:"SHARE_INVALID"});
    expect(JSON.stringify(warnings)).not.toContain(bad);expect(JSON.stringify(warnings)).not.toContain(fragment);warning.mockRestore();
  });
  it("distinguishes required and invalid access codes",async()=>{
    const value=await fixture({}, {accessCode:"correct-code"});
    expect(await (await exchange(value)).json()).toMatchObject({code:"ACCESS_CODE_REQUIRED"});
    expect(await (await exchange(value,fragment,"wrong-code")).json()).toMatchObject({code:"ACCESS_CODE_INVALID"});
    expect((await exchange(value,fragment,"correct-code")).status).toBe(200);
  });
  it("does not mint a current-version cookie when the access code changes concurrently",async()=>{
    const value=await fixture({}, {accessCode:"correct-code",raceAccessCodeChange:true});
    const response=await exchange(value,fragment,"correct-code");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({code:"SHARE_SESSION_STALE"});
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });
  it("renews a valid near-expiry cookie and rejects a stale security version",async()=>{
    const value=await fixture();
    const near=(await createSessionCookie(sessionSecret,"v1",value.share.id,value.share.share_version,Date.now()+60_000)).split(";")[0]!;
    const renewed=await worker.fetch(new Request("https://client.example/api/public/shares/public-a/not-a-route",{headers:{Cookie:near}}),value.env,value.ctx);
    expect(renewed.headers.get("Set-Cookie")).toContain("__Host-ltds_delivery=");
    const stale=(await createSessionCookie(sessionSecret,"v1",value.share.id,value.share.share_version-1,Date.now()+60_000)).split(";")[0]!;
    const rejected=await worker.fetch(new Request("https://client.example/api/public/shares/public-a/not-a-route",{headers:{Cookie:stale}}),value.env,value.ctx);
    expect(rejected.status).toBe(401);expect(await rejected.json()).toMatchObject({code:"SHARE_SESSION_STALE"});
  });
  it("returns a retryable code when the share database or storage lookup fails",async()=>{
    const databaseFailure=await fixture();databaseFailure.env.DELIVERY_DB.prepare=()=>{throw new Error("database unavailable");};
    const dbResponse=await exchange(databaseFailure);expect(dbResponse.status).toBe(503);expect(await dbResponse.json()).toMatchObject({code:"SHARE_TEMPORARILY_UNAVAILABLE"});
    const storageFailure=await fixture();storageFailure.env.DATA_BUCKET.list=()=>{throw new Error("storage unavailable");};
    const storageResponse=await exchange(storageFailure);expect(storageResponse.status).toBe(503);expect(await storageResponse.json()).toMatchObject({code:"SHARE_TEMPORARILY_UNAVAILABLE"});
  });
});
