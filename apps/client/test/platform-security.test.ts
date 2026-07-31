import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
import { decodeItemRef, encodeItemRef, isHiddenKey, keyWithinRoot, parseRange, prefixHasVisibleContent, type VisibleContentBucket } from "../src/worker/files";
import { createSessionCookie, presignR2Get, verifyRotatingSessionCookie, verifySessionCookie } from "../src/worker/security";
import { hashAccessCode } from "../../operations/src/worker/crypto";
import { verifyAccessCode } from "../src/worker/security";
import deliveryWorker, { ensurePublicId, framePolicyForPath, markUnavailableFolder, serveAppShell, sourceUrlForItem, streamItem } from "../src/worker/index";
import type { ShareRow } from "../src/worker/types";

describe("delivery app shell",()=>{
  it("preserves the public share path when requesting the SPA fallback",async()=>{let requestedPath="";const response=await serveAppShell(new Request("https://delivery.ledgetopdroneservices.com/s/public-id"),{fetch:async input=>{requestedPath=new URL(typeof input==="string"?input:input instanceof URL?input:input.url).pathname;return new Response("app shell",{status:200});}});expect(requestedPath).toBe("/s/public-id");expect(response.status).toBe(200);expect(response.headers.get("Location")).toBeNull();});
});

describe("inline PDF routing",()=>{
  const base="/api/public/shares/public/items/item-ref";
  it("uses the dedicated PDF route only for PDF source URLs",()=>{
    expect(sourceUrlForItem(base,"pdf")).toBe(`${base}/pdf`);
    expect(sourceUrlForItem(base,"image")).toBe(`${base}/source`);
    expect(sourceUrlForItem(base,"folder")).toBeUndefined();
  });
  it("allows same-origin framing only for the dedicated PDF route",()=>{
    expect(framePolicyForPath(`${base}/pdf`)).toEqual({frameAncestors:"'self'",xFrameOptions:"SAMEORIGIN"});
    expect(framePolicyForPath(`${base}/pdf`,"HEAD")).toEqual({frameAncestors:"'self'",xFrameOptions:"SAMEORIGIN"});
    expect(framePolicyForPath(`${base}/pdf`,"POST")).toEqual({frameAncestors:"'none'",xFrameOptions:"DENY"});
    for(const path of [`${base}/source`,`${base}/preview`,"/health"])expect(framePolicyForPath(path)).toEqual({frameAncestors:"'none'",xFrameOptions:"DENY"});
  });
  async function routeContext(relative="edited/brochure.pdf",missing=false){
    const share:ShareRow={id:"share-1",public_id:"public",project_id:"project-1",token_hash:"hash",label:null,password_hash:null,password_salt:null,password_iterations:null,password_algorithm:null,expires_at:null,revoked_at:null,revoked_reason:null,unavailable_since:null,share_version:2,client_name:"Client",project_name:"Delivery",r2_prefix:"jobs/client/"};
    const pending:Promise<unknown>[]=[];
    const statement={bind(){return statement;},async first<T>(){return share as T;},async all<T>(){return{results:[] as T[]};},async run(){return{meta:{changes:1}};}};
    const database={prepare(){return statement;},withSession(){return database;}};
    const limiter={async limit(){return{success:true};}};
    const env:any={ENVIRONMENT:"development",EXPECTED_HOST:"delivery.example",DELIVERY_DB:database,DATA_BUCKET:{
      async head(){return missing?null:{size:100,httpEtag:"\"pdf-etag\"",writeHttpMetadata(){}};},
      async get(_key:string,options?:{range:{length:number}}){return{body:new Blob([new Uint8Array(options?.range.length??100)]).stream()};},
    },PUBLIC_MEDIA_RATE_LIMITER:limiter,DELIVERY_SESSION_SECRET:"s".repeat(48),SESSION_KEY_ID:"v1",AUDIT_IP_SECRET:"a".repeat(48)};
    const cookie=(await createSessionCookie(env.DELIVERY_SESSION_SECRET,env.SESSION_KEY_ID,share.id,share.share_version,Date.now()+60_000)).split(";")[0]!;
    const url=`https://delivery.example/api/public/shares/public/items/${encodeURIComponent(encodeItemRef(relative))}/pdf`;
    const executionCtx={waitUntil(promise:Promise<unknown>){pending.push(promise);},passThroughOnException(){}} as ExecutionContext;
    return{env,cookie,url,pending,executionCtx};
  }
  it("serves authenticated PDF routes with inline framing headers",async()=>{
    const value=await routeContext();
    const response=await deliveryWorker.fetch(new Request(value.url,{headers:{Cookie:value.cookie}}),value.env,value.executionCtx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toBe('inline; filename="brochure.pdf"');
    expect(response.headers.get("ETag")).toBe("\"pdf-etag\"");
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'self'");
    await Promise.all(value.pending);
  });
  it("keeps ordinary responses unframeable and rejects unauthorized, missing, and non-PDF requests",async()=>{
    const value=await routeContext();
    const unauthorized=await deliveryWorker.fetch(new Request(value.url),value.env,value.executionCtx);
    expect(unauthorized.status).toBe(401);
    const missing=await routeContext("edited/missing.pdf",true);
    expect((await deliveryWorker.fetch(new Request(missing.url,{headers:{Cookie:missing.cookie}}),missing.env,missing.executionCtx)).status).toBe(404);
    const image=await routeContext("edited/photo.jpg");
    expect((await deliveryWorker.fetch(new Request(image.url,{headers:{Cookie:image.cookie}}),image.env,image.executionCtx)).status).toBe(415);
    const health=await deliveryWorker.fetch(new Request("https://delivery.example/health"),value.env,value.executionCtx);
    expect(health.headers.get("X-Frame-Options")).toBe("DENY");
    expect(health.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    const wrongHost=await deliveryWorker.fetch(new Request("https://wrong.example/health"),{...value.env,ENVIRONMENT:"production"},value.executionCtx);
    expect(wrongHost.status).toBe(404);
    expect(wrongHost.headers.get("X-Frame-Options")).toBe("DENY");
    expect(wrongHost.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });
});

describe("public item references",()=>{
  it("round-trips safe relative paths without exposing raw R2 keys",()=>{const ref=encodeItemRef("edited/video 01.mp4");expect(ref).not.toContain("/");expect(decodeItemRef(ref)).toBe("edited/video 01.mp4");expect(keyWithinRoot("jobs/2026/Client/","edited/video 01.mp4")).toBe("jobs/2026/Client/edited/video 01.mp4");});
  it("rejects traversal, backslashes, dump, and reserved metadata",()=>{for(const value of ["../secret","edited\\secret","dump/raw.dng","_ltds/index.json",".previews/hash/thumb.webp"])expect(()=>keyWithinRoot("jobs/client/",value)).toThrow();expect(isHiddenKey("jobs/client/dump/raw.dng")).toBe(true);expect(isHiddenKey("_ltds/cache/file")).toBe(true);expect(isHiddenKey("jobs/client/edited/.previews/hash/thumb.webp")).toBe(true);expect(isHiddenKey("jobs/client/unedited/photo.jpg")).toBe(false);});
});

describe("shared folder availability",()=>{
  function bucket(tree:Record<string,{objects?:string[];folders?:string[]}>):VisibleContentBucket{return{async list({prefix}){const value=tree[prefix]||{};return{objects:(value.objects||[]).map(key=>({key})),delimitedPrefixes:value.folders||[],truncated:false};}};}
  it("finds visible content recursively",async()=>{await expect(prefixHasVisibleContent(bucket({"jobs/client/":{folders:["jobs/client/edited/"]},"jobs/client/edited/":{objects:["jobs/client/edited/photo.jpg"]}}),"jobs/client/")).resolves.toBe(true);});
  it("does not treat dump, reserved metadata, previews, or folder markers as client content",async()=>{await expect(prefixHasVisibleContent(bucket({"jobs/client/":{objects:["jobs/client/"],folders:["jobs/client/dump/","jobs/client/_ltds/","jobs/client/.previews/"]}}),"jobs/client/")).resolves.toBe(false);expect(isHiddenKey("jobs/client/_ltds/index.json")).toBe(true);expect(isHiddenKey("jobs/client/.previews/hash/preview.webp")).toBe(true);});
});

describe("shared folder unavailability grace",()=>{
  const share:ShareRow={id:"share-1",public_id:"public",project_id:"project-1",token_hash:"hash",label:null,password_hash:null,password_salt:null,password_iterations:null,password_algorithm:null,expires_at:null,revoked_at:null,revoked_reason:null,unavailable_since:null,share_version:2,client_name:"Client",project_name:"Delivery",r2_prefix:"jobs/client/"};
  function database(changes:number[]){const queries:string[]=[];const env:Parameters<typeof markUnavailableFolder>[0]={DELIVERY_DB:{prepare(query){queries.push(query);const statement={bind(){return statement;},async run(){return{meta:{changes:changes.shift()||0}};},async first<T>(){return null as T|null;}};return statement;}}};return{env,queries};}
  it("returns 410 immediately but only records the first missing observation",async()=>{const value=database([0,1]);await expect(markUnavailableFolder(value.env,share)).rejects.toMatchObject({status:410});expect(value.queries[0]).toContain("-24 hours");expect(value.queries[1]).toContain("unavailable_since=datetime");expect(value.queries.some(query=>query.includes("share.auto_revoked"))).toBe(false);});
  it("durably revokes and audits after the grace period",async()=>{const value=database([1,1]);await expect(markUnavailableFolder(value.env,{...share,unavailable_since:"2026-07-16 23:00:00"})).rejects.toMatchObject({status:410});expect(value.queries.some(query=>query.includes("share.auto_revoked"))).toBe(true);});
});

describe("delivery sessions",()=>{
  it("uses a host-only secure HttpOnly cookie and verifies its signature",async()=>{const secret="s".repeat(48),expires=Date.now()+60_000;const header=await createSessionCookie(secret,"v1","share-1",3,expires);expect(header).toContain("__Host-ltds_delivery=");expect(header).toContain("HttpOnly");expect(header).toContain("Secure");expect(header).toContain("SameSite=Lax");expect(header).toContain("Path=/");const value=decodeURIComponent(header.split(";")[0]!.split("=").slice(1).join("="));await expect(verifySessionCookie(secret,"v1",value)).resolves.toEqual({shareId:"share-1",shareVersion:3,expiresAt:expires});});
  it("rejects a modified cookie and invalidates sessions when the share version rotates",async()=>{const secret="s".repeat(48),expires=Date.now()+60_000;const header=await createSessionCookie(secret,"v1","share-1",3,expires);const value=decodeURIComponent(header.split(";")[0]!.split("=").slice(1).join("="));await expect(verifySessionCookie(secret,"v1",`${value}x`)).rejects.toThrow();const rotated=value.replace(".3.",".4.");await expect(verifySessionCookie(secret,"v1",rotated)).rejects.toThrow();});
  it("accepts the previous signing key only during the rotation window",async()=>{const expires=Date.now()+60_000;const header=await createSessionCookie("p".repeat(48),"v0","share-1",3,expires);const value=decodeURIComponent(header.split(";")[0]!.split("=").slice(1).join("="));await expect(verifyRotatingSessionCookie(value,{keyId:"v1",secret:"c".repeat(48)},{keyId:"v0",secret:"p".repeat(48)})).resolves.toMatchObject({shareId:"share-1"});await expect(verifyRotatingSessionCookie(value,{keyId:"v1",secret:"c".repeat(48)},null)).rejects.toThrow();});
});

describe("legacy public-id upgrades",()=>{
  const share:ShareRow={id:"share-1",public_id:null,project_id:"project-1",token_hash:"hash",label:null,password_hash:null,password_salt:null,password_iterations:null,password_algorithm:null,expires_at:null,revoked_at:null,revoked_reason:null,unavailable_since:null,share_version:4,client_name:"Client",project_name:"Delivery",r2_prefix:"jobs/client/"};
  function database(changes:number,current:{public_id:string|null;share_version:number}|null):Parameters<typeof ensurePublicId>[0]{const statement={bind(){return statement;},async run(){return{meta:{changes}};},async first<T>(){return current as T|null;}};return{DELIVERY_DB:{prepare(){return statement;}}};}
  it("returns the incremented version after winning a public-id upgrade",async()=>{const result=await ensurePublicId(database(1,null),share);expect(result.publicId).toMatch(/^[A-Za-z0-9_-]+$/);expect(result.shareVersion).toBe(5);});
  it("uses the winning public id and version after losing an upgrade race",async()=>{await expect(ensurePublicId(database(0,{public_id:"winner",share_version:7}),share)).resolves.toEqual({publicId:"winner",shareVersion:7});});
});

describe("access-code interoperability",()=>{
  it("verifies the salted, peppered code generated by Operations in Delivery",async()=>{const pepper="p".repeat(48),stored=await hashAccessCode("confidential-2026",pepper);await expect(verifyAccessCode("confidential-2026",stored.hash,stored.salt,stored.iterations,stored.algorithm,pepper)).resolves.toBe(true);await expect(verifyAccessCode("incorrect-code",stored.hash,stored.salt,stored.iterations,stored.algorithm,pepper)).resolves.toBe(false);});
});

describe("single byte range parsing",()=>{
  it("supports prefix, open, and suffix ranges",()=>{expect(parseRange("bytes=0-99",1000)).toEqual({offset:0,length:100});expect(parseRange("bytes=900-",1000)).toEqual({offset:900,length:100});expect(parseRange("bytes=-100",1000)).toEqual({offset:900,length:100});});
  it("rejects multiple, malformed, and unsatisfiable ranges",()=>{for(const value of ["bytes=0-1,4-5","items=0-1","bytes=1000-1200","bytes=20-10"])expect(()=>parseRange(value,1000)).toThrow();});
});

describe("authenticated original object streaming",()=>{
  const share:ShareRow={id:"share-1",public_id:"public",project_id:"project-1",token_hash:"hash",label:null,password_hash:null,password_salt:null,password_iterations:null,password_algorithm:null,expires_at:null,revoked_at:null,revoked_reason:null,unavailable_since:null,share_version:2,client_name:"Client",project_name:"Delivery",r2_prefix:"jobs/client/"};
  function context(method:"GET"|"HEAD",range?:string,ifNoneMatch?:string,ifRange?:string,relative="edited/photo.jpg"){
    const expectedKey=`jobs/client/${relative}`;
    const reads:Array<{key:string;options?:{range:{offset:number;length:number}}}>=[];
    const pending:Promise<unknown>[]=[];
    const statement={bind(){return statement;},async all(){return{results:[]};},async run(){return{meta:{changes:1}};}};
    const database={prepare(){return statement;},withSession(){return database;}};
    const headers=new Headers();if(range)headers.set("Range",range);if(ifNoneMatch)headers.set("If-None-Match",ifNoneMatch);if(ifRange)headers.set("If-Range",ifRange);
    const request=new Request("https://delivery.example/api/source",{method,headers});
    const c:any={
      get:(name:string)=>name==="share"?share:undefined,
      req:{param:()=>encodeItemRef(relative),header:(name:string)=>request.headers.get(name)??undefined,method,raw:request},
      env:{
        AUDIT_IP_SECRET:"a".repeat(48),
        DELIVERY_DB:database,
        DATA_BUCKET:{
          async head(key:string){expect(key).toBe(expectedKey);return{size:100,httpEtag:"\"etag\"",writeHttpMetadata(){}};},
          async get(key:string,options?:{range:{offset:number;length:number}}){reads.push({key,options});const length=options?.range.length??100;return{body:new Blob([new Uint8Array(length)]).stream()};},
        },
      },
      executionCtx:{waitUntil(promise:Promise<unknown>){pending.push(promise);}},
    };
    return{c,reads,pending};
  }
  it("streams a single range from R2 with private response headers",async()=>{
    const value=context("GET","bytes=10-19");
    const response=await streamItem(value.c,"inline",true);
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 10-19/100");
    expect(response.headers.get("Content-Length")).toBe("10");
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(value.reads).toEqual([{key:"jobs/client/edited/photo.jpg",options:{range:{offset:10,length:10}}}]);
    expect((await response.arrayBuffer()).byteLength).toBe(10);
    await Promise.all(value.pending);
  });
  it("answers HEAD without reading the object body and rejects invalid ranges",async()=>{
    const head=context("HEAD");
    const headResponse=await streamItem(head.c,"inline",true);
    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get("Content-Length")).toBe("100");
    expect(head.reads).toHaveLength(0);
    const invalid=context("GET","bytes=100-200");
    const invalidResponse=await streamItem(invalid.c,"inline",true);
    expect(invalidResponse.status).toBe(416);
    expect(invalidResponse.headers.get("Content-Range")).toBe("bytes */100");
    expect(invalid.reads).toHaveLength(0);
  });
  it("revalidates a privately cached original without reading R2 again",async()=>{
    const value=context("GET",undefined,"W/\"etag\"");
    const response=await streamItem(value.c,"inline",true);
    expect(response.status).toBe(304);
    expect(response.headers.get("ETag")).toBe("\"etag\"");
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(response.headers.get("Content-Length")).toBeNull();
    expect(value.reads).toHaveLength(0);
  });
  it("returns the complete current object when If-Range is stale",async()=>{
    const value=context("GET","bytes=10-19",undefined,"\"old-etag\"");
    const response=await streamItem(value.c,"inline",true);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Range")).toBeNull();
    expect(response.headers.get("Content-Length")).toBe("100");
    expect(value.reads).toEqual([{key:"jobs/client/edited/photo.jpg",options:undefined}]);
    expect((await response.arrayBuffer()).byteLength).toBe(100);
    await Promise.all(value.pending);
  });
  it("streams the original PDF inline with ranges and rejects non-PDF identities",async()=>{
    const value=context("GET","bytes=20-39",undefined,undefined,"edited/brochure.pdf");
    const response=await streamItem(value.c,"inline",true,"pdf");
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toBe('inline; filename="brochure.pdf"');
    expect(response.headers.get("ETag")).toBe("\"etag\"");
    expect(response.headers.get("Content-Range")).toBe("bytes 20-39/100");
    expect(value.reads).toEqual([{key:"jobs/client/edited/brochure.pdf",options:{range:{offset:20,length:20}}}]);
    await expect(streamItem(context("GET").c,"inline",true,"pdf")).rejects.toMatchObject({status:415});
    await Promise.all(value.pending);
  });
});

describe("R2 download tickets",()=>{
  it("creates a short-lived SigV4 URL without accepting a raw client key",async()=>{
    const ticket=await presignR2Get({endpoint:"https://account.r2.cloudflarestorage.com",bucket:"client-data",accessKeyId:"access",secretAccessKey:"s".repeat(40),expiresInSeconds:120,downloadName:"Client photo.jpg"},"jobs/client/photo.jpg",new Date("2026-07-23T12:34:56.000Z"));
    const url=new URL(ticket.url);
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(url.searchParams.get("X-Amz-Content-Sha256")).toBe("UNSIGNED-PAYLOAD");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("response-content-disposition")).toContain('filename="Client photo.jpg"');
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(ticket.expiresAt).toBe("2026-07-23T12:36:56.000Z");
  });
});
