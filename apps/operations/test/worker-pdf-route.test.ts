import { beforeEach,describe,expect,it,vi } from "vitest";
import { HTTPException } from "hono/http-exception";

const mocks=vi.hoisted(()=>({
  authenticateStaff:vi.fn(),
  isAdministrator:vi.fn(),
  authorizeItem:vi.fn(),
}));

vi.mock("cloudflare:workers",()=>({WorkflowEntrypoint:class{}}));
vi.mock("../src/worker/auth",()=>({authenticateStaff:mocks.authenticateStaff}));
vi.mock("../src/worker/acl",async importOriginal=>({
  ...await importOriginal<typeof import("../src/worker/acl")>(),
  isAdministrator:mocks.isAdministrator,
}));
vi.mock("../src/worker/delivery",async importOriginal=>({
  ...await importOriginal<typeof import("../src/worker/delivery")>(),
  authorizeItem:mocks.authorizeItem,
}));

import worker from "../src/worker/index";

const principal={id:"staff-1",email:"staff@example.com",displayName:"Staff",accessSubject:"access-1",projectAlphaUserId:null};
const executionCtx={waitUntil(){},passThroughOnException(){}} as unknown as ExecutionContext;

function environment(missing=false){
  return{
    ENVIRONMENT:"development",
    EXPECTED_HOST:"ops.example",
    INCOMING_EXPECTED_HOST:"incoming.example",
    DATA_BUCKET:{
      async head(){return missing?null:{size:8,httpEtag:'"pdf-etag"'};},
      async get(_key:string,options?:{range:{length:number}}){
        return{body:new Blob([new Uint8Array(options?.range.length??8)]).stream()};
      },
    },
  } as any;
}

describe("Operations PDF Worker route",()=>{
  beforeEach(()=>{
    mocks.authenticateStaff.mockReset().mockResolvedValue(principal);
    mocks.isAdministrator.mockReset().mockResolvedValue(false);
    mocks.authorizeItem.mockReset().mockImplementation(async(_env:unknown,_principal:unknown,itemRef:string)=>itemRef==="pdf-ref"?"Jobs/client/document.pdf":"Jobs/client/photo.jpg");
  });

  it("streams the authenticated original PDF with same-origin framing",async()=>{
    const response=await worker.fetch(new Request("https://ops.example/api/delivery/items/pdf-ref/pdf"),environment(),executionCtx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toBe('inline; filename="document.pdf"');
    expect(response.headers.get("ETag")).toBe('"pdf-etag"');
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'self'");
  });

  it("preserves range responses and rejects missing, unauthorized, and non-PDF requests",async()=>{
    const partial=await worker.fetch(new Request("https://ops.example/api/delivery/items/pdf-ref/pdf",{headers:{Range:"bytes=2-5"}}),environment(),executionCtx);
    expect(partial.status).toBe(206);
    expect(partial.headers.get("Content-Range")).toBe("bytes 2-5/8");

    expect((await worker.fetch(new Request("https://ops.example/api/delivery/items/pdf-ref/pdf"),environment(true),executionCtx)).status).toBe(404);
    expect((await worker.fetch(new Request("https://ops.example/api/delivery/items/image-ref/pdf"),environment(),executionCtx)).status).toBe(415);

    mocks.authenticateStaff.mockRejectedValueOnce(new HTTPException(401,{message:"Authentication required"}));
    expect((await worker.fetch(new Request("https://ops.example/api/delivery/items/pdf-ref/pdf"),environment(),executionCtx)).status).toBe(401);
  });

  it("keeps ordinary Operations responses unframeable",async()=>{
    const response=await worker.fetch(new Request("https://ops.example/health"),environment(),executionCtx);
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });
});
