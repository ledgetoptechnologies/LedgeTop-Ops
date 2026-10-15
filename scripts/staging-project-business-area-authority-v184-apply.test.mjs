import assert from "node:assert/strict";
import test from "node:test";
import {applyProjectBusinessAreaAuthorityV184,reconcileProjectBusinessAreaAuthorityV184,
  applyReviewedProjectBusinessAreaAuthorityV184} from "./staging-project-business-area-authority-v184-apply.mjs";
import {STAGING_TARGET} from "./staging-onboarding-native-only-authority-packet.mjs";

const noDatabase={prepare(){assert.fail("invalid authority must not query a database")},batch(){assert.fail("invalid authority must not batch")}};
test("apply and reconcile reject absent or production targets before database access",async()=>{
  for(const fn of [applyProjectBusinessAreaAuthorityV184,reconcileProjectBusinessAreaAuthorityV184]){
    for(const target of [undefined,{...STAGING_TARGET,environment:"production"},{...STAGING_TARGET,databaseId:"other"}]){
      await assert.rejects(fn(noDatabase,{},"provision",{target}),/trusted staging binding/);
    }
  }
});
test("apply and reconcile reject invalid phases and malformed artifacts before database access",async()=>{
  for(const fn of [applyProjectBusinessAreaAuthorityV184,reconcileProjectBusinessAreaAuthorityV184]){
    await assert.rejects(fn(noDatabase,{},"delete",{target:STAGING_TARGET}),/phase required/);
    await assert.rejects(fn(noDatabase,{input:{},trustedApplyOnly:true},"provision",{target:STAGING_TARGET}));
  }
});
test("reviewed binding entry point still rejects malformed artifacts inside trusted staging context",async()=>{
  let opened=0,disposed=0;
  await assert.rejects(applyReviewedProjectBusinessAreaAuthorityV184("local-test-config",{input:{}},"provision",{
    readConfig:()=>({configPath:"local-test-config",configSha256:"test-only",config:{},target:STAGING_TARGET}),
    getPlatformProxy:async()=>{opened++;return {env:{OPS_DB:noDatabase},dispose:async()=>{disposed++}}},
  }));
  assert.equal(opened,1);
  assert.equal(disposed,1);
});
