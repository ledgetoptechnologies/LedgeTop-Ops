import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers",()=>({WorkflowEntrypoint:class{}}));
import worker from "../src/worker/index";
import { encodeItemRef } from "../src/worker/files";
import { createSessionCookie } from "../src/worker/security";
import type { ShareRow } from "../src/worker/types";

const root="Jobs/Clients/Acme/",selectedRelative="Edited/video.mov",siblingRelative="Edited/private.mov";
const selectedKey=`${root}${selectedRelative}`,siblingKey=`${root}${siblingRelative}`;
const share:ShareRow={id:"share-file",public_id:"public-file",project_id:"project-file",token_hash:"hash",label:"Selected video",password_hash:null,password_salt:null,password_iterations:null,password_algorithm:null,expires_at:null,revoked_at:null,revoked_reason:null,unavailable_since:null,share_version:2,client_name:"Acme",project_name:"Site",r2_prefix:root,r2_object_key:selectedKey,image_location_map_enabled:0};

async function fixture(){
  const reads:string[]=[],queries:string[]=[];
  const statementFor=(query:string)=>{let values:unknown[]=[];const statement={bind(...bound:unknown[]){values=bound;return statement;},async first<T>(){
    queries.push(query);
    if(query.includes("FROM shares s LEFT JOIN projects")){
      if(query.includes("s.public_id=?")&&!values.includes(share.public_id))return null;
      if(query.includes("s.id=?")&&!values.includes(share.id))return null;
      return share as T;
    }
    if(query.includes("SELECT stream_uid,stream_status FROM file_index"))return{stream_uid:"stream-video",stream_status:"ready"} as T;
    return null;
  },async all<T>(){queries.push(query);return{results:[] as T[]};},async run(){queries.push(query);return{meta:{changes:1}};}};return statement;};
  const database={prepare:statementFor,withSession(){return database;},async batch(statements:any[]){return Promise.all(statements.map(statement=>statement.run()));}};
  const object={key:selectedKey,size:4096,etag:"source",httpEtag:'"source"',uploaded:new Date("2026-08-19T12:00:00.000Z"),httpMetadata:{contentType:"video/quicktime"},customMetadata:{},writeHttpMetadata(headers:Headers){headers.set("Content-Type","video/quicktime");}};
  const bucket={async head(key:string){reads.push(`head:${key}`);return key===selectedKey?object:null;},async get(key:string){reads.push(`get:${key}`);return key===selectedKey?{...object,body:new Blob(["video"]).stream()}:null;}};
  const limiter={async limit(){return{success:true};}},secret="s".repeat(48);
  const env:any={ENVIRONMENT:"development",EXPECTED_HOST:"client.example",PUBLIC_BASE_URL:"https://client.example",DELIVERY_DB:database,DATA_BUCKET:bucket,DELIVERY_SESSION_SECRET:secret,SESSION_KEY_ID:"v1",AUDIT_IP_SECRET:"a".repeat(48),PUBLIC_MANIFEST_RATE_LIMITER:limiter,PUBLIC_MEDIA_RATE_LIMITER:limiter,PUBLIC_THUMBNAIL_RATE_LIMITER:limiter,PUBLIC_DOWNLOAD_RATE_LIMITER:limiter,PUBLIC_STREAM_RATE_LIMITER:limiter,PUBLIC_BULK_RATE_LIMITER:limiter,STREAM_CUSTOMER_CODE:"customer",STREAM:{video(){return{async generateToken(){return"stream-token";}};}}};
  const cookie=(await createSessionCookie(secret,"v1",share.id,share.share_version,Date.now()+60_000)).split(";")[0]!;
  const ctx:any={waitUntil(){},passThroughOnException(){}};
  const request=(path:string,init:RequestInit={})=>worker.fetch(new Request(`https://client.example${path}`,{...init,headers:{Cookie:cookie,Origin:"https://client.example",...(init.body?{"Content-Type":"application/json"}:{}),...init.headers}}),env,ctx);
  return{request,reads,queries};
}

describe("single-file public delivery authorization",()=>{
  it("publishes an exact one-item manifest and permits only that video's source and stream",async()=>{
    const value=await fixture(),base="/api/public/shares/public-file",selectedRef=encodeItemRef(selectedRelative);
    const response=await value.request(`${base}/manifest`),manifest=await response.json() as any;
    expect(response.status).toBe(200);
    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0]).toMatchObject({id:selectedRef,name:"video.mov",kind:"video",size:4096});
    expect(manifest.nextCursor).toBeNull();
    expect(manifest.capabilities.cloudTransfer).toEqual({dropbox:false,googleDrive:false,googlePicker:false});
    expect((await value.request(`${base}/manifest?folder=${encodeItemRef("Edited")}`)).status).toBe(404);
    expect((await value.request(`${base}/manifest?cursor=next`)).status).toBe(404);

    const source=await value.request(`${base}/items/${selectedRef}/source`);
    expect(source.status).toBe(200);expect(await source.text()).toBe("video");
    const stream=await value.request(`${base}/items/${selectedRef}/stream-ticket`,{method:"POST"});
    expect(stream.status).toBe(200);expect(await stream.json()).toMatchObject({url:expect.stringContaining("stream-token")});
  });

  it("denies every sibling media path before storage or derivative lookup",async()=>{
    const value=await fixture(),base="/api/public/shares/public-file",siblingRef=encodeItemRef(siblingRelative);
    const routes:Array<[string,string]>=[
      ["GET",`${base}/items/${siblingRef}/source`],["GET",`${base}/items/${siblingRef}/preview`],
      ["GET",`${base}/items/${siblingRef}/download`],["GET",`${base}/items/${siblingRef}/download-ticket`],
      ["GET",`${base}/items/${siblingRef}/thumbnail`],["POST",`${base}/items/${siblingRef}/stream-ticket`],
    ];
    for(const[method,path]of routes)expect((await value.request(path,{method})).status,`${method} ${path}`).toBe(404);
    expect(value.reads).toEqual([]);
    expect(value.queries.some(query=>query.includes("image_thumbnail_jobs")||query.includes("SELECT stream_uid"))).toBe(false);

    const media=await value.request(`${base}/manifest/media`,{method:"POST",body:JSON.stringify({items:[siblingRef]})});
    expect(media.status).toBe(200);expect(await media.json()).toEqual({items:[]});
    expect(value.reads).toEqual([]);
  });

  it("disables map, bulk-download, and every share-scoped cloud-transfer route",async()=>{
    const value=await fixture(),base="/api/public/shares/public-file";
    const locations=await value.request(`${base}/locations`);
    expect(locations.status).toBe(200);expect(await locations.json()).toMatchObject({locations:{points:[],imageCount:0}});
    expect((await value.request(`${base}/locations/${encodeItemRef(selectedRelative)}`)).status).toBe(404);
    const disabled:Array<[string,string,BodyInit|undefined]>=[
      ["POST",`${base}/bulk-download`,JSON.stringify({all:true})],["GET",`${base}/bulk-download/job-one`,undefined],["GET",`${base}/bulk-download/job-one/file`,undefined],
      ["POST",`${base}/cloud-transfers/oauth/dropbox/start`,JSON.stringify({})],
      ["POST",`${base}/cloud-transfers/google/authorizations/auth-one/token`,JSON.stringify({})],
      ["POST",`${base}/cloud-transfers`,JSON.stringify({})],["GET",`${base}/cloud-transfers/job-one`,undefined],
      ["POST",`${base}/cloud-transfers/job-one/cancel`,JSON.stringify({})],["POST",`${base}/cloud-transfers/job-one/retry`,JSON.stringify({})],
    ];
    for(const[method,path,body]of disabled)expect((await value.request(path,{method,body})).status,`${method} ${path}`).toBe(404);
  });
});
