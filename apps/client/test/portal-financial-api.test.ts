import {describe,expect,it,vi} from "vitest";
import {loadOperationsFinancial} from "../src/client/portal-api";
const authority="10000000-0000-4000-8000-000000000001";
const grantId="20000000-0000-4000-8000-000000000002";
const doc={publicId:"doc-1",kind:"invoice",status:"unpaid",currency:"USD",total:"10.00",amountPaid:"0.00",balanceDue:"10.00",
  documentUrl:"https://pa.example.test/?page=public-doc&token=abcdefghijklmnop",actionUrl:"https://pa.example.test/?page=stripe-checkout&token=abcdefghijklmnop"};
describe("financial portal response boundary",()=>{
  it("accepts the exact bounded document response",async()=>{
    const calls:Array<[string,unknown]>=[];
    const request=async<T>(url:string,init?:unknown)=>{calls.push([url,init]);return {resourceMode:"operations_financial",collections:[{grantId,revision:1,documents:[doc]}]} as T;};
    await expect(loadOperationsFinancial(authority,request)).resolves.toEqual([{...doc,issueDate:null,dueDate:null,scopeKey:`${authority}:${grantId}:1`}]);
    expect(calls).toEqual([[`/api/client/v2/operations/home/${authority}/financial`,expect.objectContaining({omitWorkspace:true})]]);
  });
  it("preserves valid dates and the authoritative PA overdue status",async()=>{
    const dated={...doc,status:"overdue",issueDate:"2026-02-28",dueDate:"2026-03-30"};
    await expect(loadOperationsFinancial(authority,async<T>()=>({resourceMode:"operations_financial",collections:[{grantId,revision:1,documents:[dated]}]}) as T))
      .resolves.toEqual([{...dated,scopeKey:`${authority}:${grantId}:1`}]);
  });
  it("rejects unsafe links, malformed currency, and invalid authorities",async()=>{
    for(const changed of [{...doc,actionUrl:"javascript:alert(1)"},{...doc,currency:"usd"}])
      await expect(loadOperationsFinancial(authority,async<T>()=>({resourceMode:"operations_financial",collections:[{grantId,revision:1,documents:[changed]}]}) as T))
        .rejects.toMatchObject({status:503});
    await expect(loadOperationsFinancial("not-an-id",vi.fn())).rejects.toMatchObject({status:403});
  });
  it.each([
    {...doc,issueDate:"2026-02-30",dueDate:"2026-03-30"},
    {...doc,issueDate:"2026-02-28"},
    {...doc,issueDate:"2026-02-28T00:00:00Z",dueDate:"2026-03-30"},
  ])("rejects invalid or partial dates: %o",async changed=>{
    await expect(loadOperationsFinancial(authority,async<T>()=>({resourceMode:"operations_financial",collections:[{grantId,revision:1,documents:[changed]}]}) as T))
      .rejects.toMatchObject({status:503});
  });
});
