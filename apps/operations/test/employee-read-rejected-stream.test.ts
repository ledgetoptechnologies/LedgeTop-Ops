import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";

// Authentication/authority are controlled seams here, not an admission test.
// Route, actual gateway byte guard, native fixed framing and handle codec run
// unmodified in Workerd. Each runtime handles exactly one isolated request.
async function exercise(mode: string, counterfactual = false, omitDiscard = false) {
  const worker = `import {createEmployeeReadRouter} from "../src/worker/employee-read-routes";
    import {employeeHandleContext,encodeEmployeeFileHandle} from "../src/worker/employee-read-handles";
    import {state,proof,config} from "rejection-state";
    export default {async fetch(){
      const expiresAt=Math.floor(Date.now()/1000)+300;
      state.mode=${JSON.stringify(mode)};state.expiry=expiresAt;
      const handle=await encodeEmployeeFileHandle(employeeHandleContext({opsOrigin:config.opsOrigin,issuer:config.access.issuer,audience:config.access.staffAudience,key:config.handleKey}),
        {v:1,proof,path:"map.bin",snapshotId:"55555555-5555-4555-8555-555555555555",sha256:"a".repeat(64),size:state.mode==="length"?4:3,expiresAt});
      const route=createEmployeeReadRouter(config,{database:{},fetch:async(_url,init)=>{
        state.signal=init.signal;let sent=false;
        return new Response(new ReadableStream({pull(c){if(!sent){sent=true;state.first++;c.enqueue(new Uint8Array([1]))}else{state.stalled=true;state.ready();return}},cancel(){state.cancelled++}}, {highWaterMark:0}),
          {status:state.mode==="range"?206:200,headers:{"Content-Type":"application/octet-stream","Content-Length":"3",ETag:'"'+"a".repeat(64)+'"',...(state.mode==="range"?{"Content-Range":"bytes 0-2/4"}:{})}})
      }});
      const request=new Request(config.opsOrigin+"/api/staff/files/downloads/"+handle,{headers:{"If-Match":'"'+"a".repeat(64)+'"',...(state.mode==="range"?{Range:"bytes=0-2"}:{})}});
      const response=await route.fetch(request);
      const body=await response.text();await new Promise(r=>setTimeout(r,5));
      return Response.json({status:response.status,body,first:state.first,stalled:state.stalled,cancelled:state.cancelled,aborted:state.signal?.aborted??false,audits:state.audits,abortBeforeDiscard:state.abortBeforeDiscard});
    }};`;
  const state = `let ready;const waiting=new Promise(r=>ready=r);
    export const state={mode:"",expiry:0,first:0,stalled:false,cancelled:0,audits:0,afterAudit:0,signal:null,abortBeforeDiscard:null,waiting,ready};
    export const proof={gatewayId:"11111111-1111-4111-8111-111111111111",rootId:"22222222-2222-4222-8222-222222222222",rootGeneration:1,rootFingerprint:"b".repeat(64),staffId:"staff:synthetic",accessSubject:"access|synthetic",admissionVersion:1,profileVersion:1,grantId:"33333333-3333-4333-8333-333333333333",grantGeneration:1,verifiedUntil:new Date(Date.now()+3600000).toISOString()};
    export const config={enabled:true,opsOrigin:"https://ops.example.test",access:{enabled:true,issuer:"https://synthetic.cloudflareaccess.com",staffAudience:"synthetic-staff-audience"},gateway:{origin:"https://owned.invalid",gatewayId:proof.gatewayId,keyId:"synthetic",key:new Uint8Array(32).fill(49)},handleKey:new Uint8Array(32).fill(50)};`;
  const modules: Record<string,string> = {
    "rejection-state": state,
    "native-staff-auth": `import{proof}from"rejection-state";export async function authenticateNativeStaffWithAdmissionVersion(){return {identity:{kind:"native",staffId:proof.staffId,verifiedAccessSubject:proof.accessSubject,email:"synthetic@example.invalid",displayName:"Synthetic",profileVersion:1},admissionVersion:1,verifiedUntil:proof.verifiedUntil}}`,
    "employee-read-authority": `import{state,proof}from"rejection-state";export async function resolveEmployeeReadAuthority(){return proof}export async function listEmployeeReadRoots(){return []}export async function recheckEmployeeReadAuthority(){if(state.audits&&++state.afterAudit>=2){await state.waiting;if(state.mode==="throw")throw Error("private diagnostic");if(state.mode==="expiry"){Date.now=()=>state.expiry*1000;return true}return false}return true}`,
    "employee-read-provisioning": `import{state}from"rejection-state";export async function recordEmployeeContentStart(){state.audits++}`,
    "employee-read-transport": `import{state}from"rejection-state";import{readEmployeeGateway as actual}from${JSON.stringify(resolve("src/worker/employee-read-transport.ts"))};export * from${JSON.stringify(resolve("src/worker/employee-read-transport.ts"))};export async function readEmployeeGateway(...args){const response=await actual(...args);await state.waiting;const original=response.body.cancel.bind(response.body);response.body.cancel=(...cancelArgs)=>{state.abortBeforeDiscard=args[4].aborted;return original(...cancelArgs)};return response}`,
  };
  let counterfactualApplied=false;
  const bundled = await build({ stdin: { contents: worker, resolveDir: resolve("test"), sourcefile: "route-rejection.ts", loader: "ts" },
    bundle: true, format: "esm", platform: "browser", write: false, logLevel: "silent", plugins: [{ name: "isolated-authority-fixtures", setup(b) {
      b.onResolve({filter:/^(?:rejection-state|\.\/native-staff-auth|\.\/employee-read-authority|\.\/employee-read-provisioning|\.\/employee-read-transport)$/},args=>({path:args.path.replace("./",""),namespace:"fixture"}));
      b.onLoad({filter:/.*/,namespace:"fixture"},args=>({contents:modules[args.path]!,loader:"ts",resolveDir:resolve("src/worker")}));
      if(counterfactual)b.onLoad({filter:/employee-read-routes\.ts$/},async args=>{const source=await readFile(args.path,"utf8");let contents=source.replace("        owned.abort();","        /* counterfactual: no route abort */");if(omitDiscard)contents=contents.replace("        if (response) await discard(response);","        /* historical throwing path did not discard */");counterfactualApplied=contents!==source;return{contents,loader:"ts",resolveDir:resolve("src/worker")}});
    }}] });
  expect(counterfactualApplied).toBe(counterfactual);
  const runtime = new Miniflare({ modules:true,compatibilityDate:"2026-08-06",script:bundled.outputFiles[0]!.text,
    outboundService:()=>{throw Error("No outbound network in rejected-download regression");} });
  try {
    const response=await runtime.dispatchFetch("https://local.invalid");
    return await response.json() as {status:number;body:string;first:number;stalled:boolean;cancelled:number;aborted:boolean;audits:number;abortBeforeDiscard:boolean|null};
  } finally {await runtime.dispose();}
}
it("explicitly aborts stalled content rejected at the final route checks, including throws",async()=>{
  for(const mode of ["denied","throw","expiry","length","range"]){
    const result=await exercise(mode);
    expect(result).toMatchObject({status:mode==="denied"||mode==="expiry"?403:503,first:1,stalled:true,cancelled:1,aborted:true,audits:1,abortBeforeDiscard:true});
    expect(JSON.parse(result.body)).toEqual({error:mode==="denied"||mode==="expiry"?"employee_read_denied":"employee_read_unavailable"});
    expect(result.body).not.toContain("private diagnostic");
  }
  // Native discard can also cancel a still-pending first write. The new
  // ownership guarantee is stronger: abort must occur BEFORE that discard.
  const withoutOwnedAbort=await exercise("denied",true);
  expect(withoutOwnedAbort).toMatchObject({status:403,first:1,stalled:true,abortBeforeDiscard:false});
  // Before this fix a throwing final recheck bypassed explicit discard too.
  const historicalThrow=await exercise("throw",true,true);
  expect(historicalThrow).toMatchObject({status:503,first:1,stalled:true,cancelled:0,aborted:false,abortBeforeDiscard:null});
});
