import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("preserves native content framing and fails incomplete, oversized or cancelled employee streams", async () => {
  const entry = `import {readEmployeeGateway} from "../src/worker/employee-read-transport";
    const sha="a".repeat(64), gatewayId="11111111-1111-4111-8111-111111111111";
    export default {async fetch(request) {
      const mode=new URL(request.url).pathname.slice(1), inspect=new URL(request.url).searchParams.has("inspect");
      let audited=0,cancelled=0,sent=false,upstreamSignal;
      const controller=new AbortController();
      const size=mode==="zero"?0:mode==="range"?2:3;
      const bytes=(mode==="cancel"||mode==="abort")?[1]:mode==="short"?[1,2]:mode==="long"?[1,2,3,4]:Array.from({length:size},(_,i)=>i+1);
      const proof={gatewayId,rootId:"22222222-2222-4222-8222-222222222222",rootGeneration:1,rootFingerprint:"b".repeat(64),staffId:"staff:synthetic",accessSubject:"access|synthetic",admissionVersion:1,profileVersion:1,grantId:"33333333-3333-4333-8333-333333333333",grantGeneration:1,verifiedUntil:new Date(Date.now()+3600000).toISOString()};
      const response=await readEmployeeGateway(proof,{operation:"content",path:"map.bin",expectedSha256:sha,range:mode==="range"?{start:1,end:2}:null,snapshotId:"55555555-5555-4555-8555-555555555555"},
        {origin:"https://owned.invalid",gatewayId,keyId:"synthetic",key:new Uint8Array(32).fill(49)},
        {recheck:async()=>mode!=="denied",auditContentStart:async()=>{audited++},fetch:async(_url,init)=>{
          upstreamSignal=init.signal;
          return new Response(new ReadableStream({pull(c){if(sent){if(mode==="cancel"){return new Promise(r=>setTimeout(()=>{c.enqueue(new Uint8Array([2]));r()},10))}if(mode!=="abort")c.close()}else{sent=true;c.enqueue(new Uint8Array(bytes))}},cancel(){cancelled++}},{highWaterMark:0}),
            {status:mode==="range"?206:200,headers:{"Content-Type":"application/octet-stream","Content-Length":String(size),ETag:'"'+sha+'"',...(mode==="range"?{"Content-Range":"bytes 1-2/4"}:{})}})
        }},controller.signal);
      if(mode==="generic") return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2,3]));c.close()}}),{headers:{"Content-Type":"application/octet-stream","Content-Length":"3"}});
      if(inspect){let interrupted=false;try{if(mode==="cancel"||mode==="abort"){const r=response.body.getReader();await r.read();if(mode==="abort"){controller.abort();try{await r.read()}catch{interrupted=true}}else await r.cancel();await new Promise(r=>setTimeout(r,30))}else await response.arrayBuffer()}catch{interrupted=true}return Response.json({interrupted,audited,cancelled,aborted:upstreamSignal?.aborted??false})}
      return response;
    }};`;
  const result = await build({ stdin: { contents: entry, resolveDir: resolve("test"), sourcefile: "employee-fixed-framing.ts", loader: "ts" },
    bundle: true, format: "esm", platform: "browser", write: false, logLevel: "silent" });
  const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: result.outputFiles[0]!.text,
    outboundService: () => { throw Error("No network in framing test"); } });
  try {
    const origin = await runtime.ready;
    for (const [mode, length, status] of [["full",3,200],["range",2,206],["zero",0,200]] as const) {
      const response = await fetch(new URL(mode, origin));
      expect(response.status).toBe(status); expect(response.headers.get("content-length")).toBe(String(length));
      expect(response.headers.get("etag")).toBe('"'+"a".repeat(64)+'"');
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(Array.from({length},(_,i)=>i+1));
      if(mode==="range")expect(response.headers.get("content-range")).toBe("bytes 1-2/4");
    }
    const generic=await fetch(new URL("generic",origin));expect(generic.headers.get("content-length")).toBeNull();await generic.arrayBuffer();
    for(const mode of ["short","long"]){const r=await fetch(new URL(mode+"?inspect",origin));expect(await r.json()).toMatchObject({interrupted:true,audited:1});}
    const cancel=await fetch(new URL("cancel?inspect",origin));expect(await cancel.json()).toMatchObject({audited:1,cancelled:1,aborted:true});
    const abort=await fetch(new URL("abort?inspect",origin));expect(await abort.json()).toMatchObject({interrupted:true,audited:1,cancelled:1,aborted:true});
    const denied=await fetch(new URL("denied",origin));expect(denied.status).toBe(403);
  } finally { await runtime.dispose(); }
});

