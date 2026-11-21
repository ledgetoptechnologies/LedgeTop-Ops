import {describe,expect,it,vi} from "vitest";
import {Hono} from "hono";

const mock=vi.hoisted(()=>({hasPermission:vi.fn(),authorize:vi.fn()}));
vi.mock("../src/worker/acl",()=>({hasPermission:mock.hasPermission}));
vi.mock("../src/worker/delivery",()=>({
  authorizeDeliveryFolderPrefix:mock.authorize,
  decodeRef:(value:string)=>value==="folder-ref"?"Jobs/Clients/Example":value,
  normalizePrefix:(value:string)=>`${value.replace(/\/$/,"")}/`,
}));

import {registerClientDeliveryRecipientRoutes} from "../src/worker/client-delivery-recipients";
import type {Env,StaffPrincipal} from "../src/worker/types";

const principal={id:"capability-staff",email:"staff@example.test",displayName:"Staff",accessSubject:"staff-subject"} as StaffPrincipal;
function database():D1Database{return{
  withSession(){return this;},
  prepare(sql:string){return{bind(){return{all:async()=>({results:sql.includes("FROM project_folders")?[{division_id:"division-A"}]:[]})};}};},
} as unknown as D1Database;}
function appFor(options:{capability?:()=>Promise<string>;creation?:string}={}){
  const app=new Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>();
  app.use("*",async(c,next)=>{c.set("principal",principal);c.set("administrator",false);await next();});
  registerClientDeliveryRecipientRoutes(app);
  const env={OPS_DB:database(),DATA_BUCKET:{list:async()=>({objects:[{key:"Jobs/Clients/Example/file.pdf"}],delimitedPrefixes:[]})},
    CLIENT_PORTAL_AUTHORITY_V2:options.capability?{readDirectFolderSharingCapability:options.capability}:{},
    AUTHENTICATED_DELIVERY_CREATION_ENABLED:options.creation} as unknown as Env;
  return {app,env};
}
const request=(app:Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>,env:Env,query="folderRef=folder-ref")=>
  app.request(`https://ops.test/api/delivery/client-recipients/capability?${query}`,{},env);

describe("client recipient sharing capability",()=>{
  it("returns direct-native status with actual scoped create and revoke permissions",async()=>{
    mock.authorize.mockResolvedValue(undefined);
    mock.hasPermission.mockImplementation(async(_env:unknown,_principal:unknown,permission:string,context?:{divisionId:string})=>
      permission==="delivery.share.revoke"&&context?.divisionId==="division-A");
    const {app,env}=appFor({creation:"true",capability:async()=>JSON.stringify({protocolVersion:1,enabled:true})});
    const response=await request(app,env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({protocolVersion:1,enabled:true,canCreate:false,canRevoke:true});
    expect(mock.hasPermission).toHaveBeenCalledWith(env,principal,"delivery.share.create",{divisionId:"division-A"});
    expect(mock.hasPermission).toHaveBeenCalledWith(env,principal,"delivery.share.revoke",{divisionId:"division-A"});
  });

  it("keeps creation configuration independent from revoke capability",async()=>{
    mock.authorize.mockResolvedValue(undefined);
    mock.hasPermission.mockImplementation(async(_env:unknown,_principal:unknown,permission:string)=>permission==="delivery.share.create");
    const {app,env}=appFor({creation:"false",capability:async()=>JSON.stringify({protocolVersion:1,enabled:true})});
    const response=await request(app,env);
    expect(await response.json()).toEqual({protocolVersion:1,enabled:true,canCreate:false,canRevoke:false});
  });

  it("reports explicit or missing private capability as disabled and fails closed on malformed capability",async()=>{
    mock.authorize.mockResolvedValue(undefined);mock.hasPermission.mockResolvedValue(true);
    const disabled=appFor({capability:async()=>JSON.stringify({protocolVersion:1,enabled:false})});
    expect(await (await request(disabled.app,disabled.env)).json()).toEqual({protocolVersion:1,enabled:false,canCreate:false,canRevoke:false});
    const missing=appFor();
    expect(await (await request(missing.app,missing.env)).json()).toEqual({protocolVersion:1,enabled:false,canCreate:false,canRevoke:false});
    const malformed=appFor({capability:async()=>JSON.stringify({protocolVersion:1,enabled:true,extra:true})});
    expect((await request(malformed.app,malformed.env)).status).toBe(503);
    const failed=appFor({capability:async()=>{throw new Error("rpc failure");}});
    expect((await request(failed.app,failed.env)).status).toBe(503);
  });

  it("requires one strict folderRef query and the existing folder-view gate",async()=>{
    mock.authorize.mockResolvedValue(undefined);mock.hasPermission.mockResolvedValue(true);
    const {app,env}=appFor({capability:async()=>JSON.stringify({protocolVersion:1,enabled:true})});
    expect((await request(app,env,"folderRef=folder-ref&extra=x")).status).toBe(400);
    expect((await request(app,env,"folderRef=folder-ref&folderRef=folder-ref")).status).toBe(400);
    mock.hasPermission.mockResolvedValue(false);
    expect((await request(app,env)).status).toBe(403);
  });
});
