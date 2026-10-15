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
    await expect(loadOperationsFinancial(authority,request)).resolves.toEqual([{...doc,scopeKey:`${authority}:${grantId}:1`}]);
    expect(calls).toEqual([[`/api/client/v2/operations/home/${authority}/financial`,expect.objectContaining({omitWorkspace:true})]]);
  });
  it("rejects unsafe links, malformed currency, and invalid authorities",async()=>{
    for(const changed of [{...doc,actionUrl:"javascript:alert(1)"},{...doc,currency:"usd"}])
      await expect(loadOperationsFinancial(authority,async<T>()=>({resourceMode:"operations_financial",collections:[{grantId,revision:1,documents:[changed]}]}) as T))
        .rejects.toMatchObject({status:503});
    await expect(loadOperationsFinancial("not-an-id",vi.fn())).rejects.toMatchObject({status:403});
  });
});
