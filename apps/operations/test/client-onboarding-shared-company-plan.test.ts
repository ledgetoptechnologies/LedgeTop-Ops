import {describe,expect,it} from "vitest";
import {parseSharedCompanySelection} from "../src/worker/client-onboarding-shared-company-plan";
const valid={kind:"shared_existing",groupId:"11111111-1111-4111-8111-111111111111",expectedVersion:3,
 members:[{recordId:"company:a",expectedVersion:2},{recordId:"company:b",expectedVersion:4}]};
describe("reviewed shared-company selection",()=>{
 it("requires the complete sorted exact group/member version choice",()=>{
  expect(parseSharedCompanySelection(valid)).toEqual(valid);
  expect(parseSharedCompanySelection({...valid,members:[valid.members[0]]})).toEqual({...valid,members:[valid.members[0]]});
 });
 it.each([null,{},[],{...valid,email:"guessed@example.test"},{...valid,expectedVersion:0},
  {...valid,members:[]},{...valid,members:[...valid.members,...valid.members]},
  {...valid,members:[valid.members[1],valid.members[0]]},{...valid,members:[valid.members[0],valid.members[0]]},
  {...valid,members:[{recordId:"company:a",expectedVersion:2,sourceId:"browser-destination"}]},
  {...valid,members:[{recordId:"company:a",expectedVersion:2.5}]},
  {...valid,groupId:"not-a-canonical-group"}])("rejects inferred, ambiguous or incomplete shape %#",value=>{
   expect(parseSharedCompanySelection(value)).toBeNull();
 });
});
