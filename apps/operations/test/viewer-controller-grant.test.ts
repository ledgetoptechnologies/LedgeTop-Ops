import {Hono} from "hono";
import {beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({create:vi.fn()}));
vi.mock("../src/worker/acl",()=>({sqlScope:async()=>({global:true,deniedGlobal:false})}));
vi.mock("../src/worker/viewer-units",()=>({resolveViewerUnits:async()=>"imperial",defaultViewerUnits:()=>"imperial"}));
vi.mock("../src/worker/viewer-integration",()=>({viewerIntegrationEnabled:()=>true,viewerPublicSharesEnabled:()=>false,
 viewerServiceClient:()=>({createAdminGrant:mocks.create})}));
import {registerViewerProcessingRoutes} from "../src/worker/viewer-processing";
import type {Env} from "../src/worker/types";

describe("initial Viewer controller grant",()=>{
 const old="https://ops.ledgetopdroneservices.com",current="https://ops.ledgetop.app";
 const env={ENVIRONMENT:"production",EXPECTED_HOST:"ops.ledgetop.app",OPERATIONS_ORIGINS:`${current},${old}`,
  VIEWER_PROCESSING_ENABLED:"true",VIEWER_BASE_URL:"https://viewer.ledgetopdroneservices.com"} as Env;
 function app(){const value=new Hono<any>();value.use("*",async(c,next)=>{c.set("principal",{id:"controlled-staff",
  accessExpiresAt:Math.floor(Date.now()/1000)+1800});await next();});registerViewerProcessingRoutes(value);return value;}
 function request(origin:string){return new Request(origin+"/api/viewer/admin-grant",{method:"POST",
  headers:{Origin:"https://viewer.ledgetopdroneservices.com","Idempotency-Key":crypto.randomUUID()}});}
 beforeEach(()=>{vi.clearAllMocks();mocks.create.mockResolvedValue({grant:"a".repeat(43)});});
 it.each([old,current])("signs the admitted actual URL %s rather than canonical default or Origin header",async origin=>{
  const response=await app().fetch(request(origin),env);expect(response.status).toBe(201);
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({controllerOrigin:origin,subject:"ops:controlled-staff"}));
  expect(mocks.create.mock.calls[0]![0].targetSessionId).toBeUndefined();
 });
 it.each(["https://portal.ledgetop.app","https://ops.ledgetop.app.evil.example"])("rejects non-staff URL %s before minting",async origin=>{
  expect((await app().fetch(request(origin),env)).status).toBe(403);expect(mocks.create).not.toHaveBeenCalled();
 });
});
