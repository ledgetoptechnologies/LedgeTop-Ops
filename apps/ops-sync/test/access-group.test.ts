import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileAccessGroup } from "../src/access-group";

describe("Access rule-group reconciliation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("replaces include rules with sorted desired emails and preserves constraints", async () => {
    const all=vi.fn(async()=>({results:[{email:"owner@example.com"},{email:"user@example.com"}]}));
    const db={prepare:vi.fn(()=>({all}))} as unknown as D1Database;
    const calls: Array<{url:string;init?:RequestInit}> = [];
    vi.stubGlobal("fetch",vi.fn(async(url:string,init?:RequestInit)=>{
      calls.push({url,init});
      if(!init?.method)return Response.json({success:true,result:{id:"group",name:"LTDS Ops Users",exclude:[{geo:{country_code:"XX"}}],require:[]}});
      return Response.json({success:true,result:{id:"group",name:"LTDS Ops Users"}});
    }));
    const env={OPS_DB:db,CF_ACCOUNT_ID:"account",CF_ACCESS_GROUP_ID:"group",CF_ACCESS_GROUP_API_TOKEN:"token"};
    await expect(reconcileAccessGroup(env)).resolves.toEqual(["owner@example.com","user@example.com"]);
    const body=JSON.parse(String(calls[1]?.init?.body));
    expect(body.include).toEqual([{email:{email:"owner@example.com"}},{email:{email:"user@example.com"}}]);
    expect(body.exclude).toEqual([{geo:{country_code:"XX"}}]);
    expect(calls[1]?.init?.method).toBe("PUT");
  });

  it("recovers a stale group identifier through an exact configured group name", async () => {
    const all=vi.fn(async()=>({results:[{email:"user@example.com"}]}));
    const db={prepare:vi.fn(()=>({all}))} as unknown as D1Database;
    const calls: Array<{url:string;init?:RequestInit}> = [];
    vi.stubGlobal("fetch",vi.fn(async(url:string,init?:RequestInit)=>{
      calls.push({url,init});
      if(url.endsWith("/stale-group"))return Response.json({success:false,result:null,errors:[{code:1000,message:"invalid group id"}]},{status:400});
      if(url.includes("?per_page="))return Response.json({success:true,result:[{id:"current-group",name:"LTDS Ops Users",exclude:[],require:[]}]});
      return Response.json({success:true,result:{id:"current-group",name:"LTDS Ops Users"}});
    }));
    const env={OPS_DB:db,CF_ACCOUNT_ID:"account",CF_ACCESS_GROUP_ID:"stale-group",CF_ACCESS_GROUP_NAME:"LTDS Ops Users",CF_ACCESS_GROUP_API_TOKEN:"token"};
    await expect(reconcileAccessGroup(env)).resolves.toEqual(["user@example.com"]);
    expect(calls[2]?.url).toContain("/current-group");
    expect(calls[2]?.init?.method).toBe("PUT");
  });

  it("fails closed when the group-management token is not configured", async () => {
    const env={OPS_DB:{} as D1Database,CF_ACCOUNT_ID:"account",CF_ACCESS_GROUP_ID:"group",CF_ACCESS_GROUP_API_TOKEN:""};
    await expect(reconcileAccessGroup(env)).rejects.toThrow("access-group-configuration-invalid");
  });

  it("reports a failed group update so the event remains retryable", async () => {
    const db={prepare:vi.fn(()=>({all:vi.fn(async()=>({results:[{email:"user@example.com"}]}))}))} as unknown as D1Database;
    vi.stubGlobal("fetch",vi.fn(async(_url:string,init?:RequestInit)=>{
      if(!init?.method)return Response.json({success:true,result:{id:"group",name:"LTDS Ops Users",exclude:[],require:[]}});
      return Response.json({success:false,result:null,errors:[{message:"denied"}]},{status:403});
    }));
    const env={OPS_DB:db,CF_ACCOUNT_ID:"account",CF_ACCESS_GROUP_ID:"group",CF_ACCESS_GROUP_API_TOKEN:"token"};
    await expect(reconcileAccessGroup(env)).rejects.toThrow("access-group-update-403");
  });
});
