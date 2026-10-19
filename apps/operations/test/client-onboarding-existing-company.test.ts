import {describe,expect,it} from "vitest";
import {parseClientOnboardingOrganizationSelection} from "../src/worker/client-onboarding-existing-company";
describe("exact reviewed onboarding company selection",()=>{
  it("requires an explicit new choice or exact versioned canonical company",()=>{
    expect(parseClientOnboardingOrganizationSelection({kind:"new"})).toEqual({kind:"new"});
    const choice={kind:"existing",recordId:"native-org:exact",expectedVersion:4};
    expect(parseClientOnboardingOrganizationSelection(choice)).toEqual(choice);
  });
  it.each([undefined,null,[],{}, {kind:"new",name:"guessed company"},
    {kind:"existing",recordId:"native-org:exact"}, {kind:"existing",recordId:"native-org:exact",expectedVersion:0},
    {kind:"existing",recordId:"native-org:exact",expectedVersion:1.5},
    {kind:"existing",recordId:"native-org:exact",expectedVersion:1,email:"inferred@example.test"},
    {kind:"existing",recordId:"bad\u0000id",expectedVersion:1},
    {kind:"existing",recordId:"",expectedVersion:1},
    {kind:"existing",recordId:"x".repeat(192),expectedVersion:1}])("rejects ambiguous or inferred selection %#",value=>{
      expect(parseClientOnboardingOrganizationSelection(value)).toBeNull();
  });
});
