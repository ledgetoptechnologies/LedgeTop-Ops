import test from "node:test";
import assert from "node:assert/strict";
import { applyReviewedBusinessAreaAuthorityPhase } from "./staging-project-business-area-authority-binding-runner.mjs";

const packet={schemaVersion:1,trustedApplyOnly:true};
test("runner delegates only through isolated staging binding callback",async()=>{
 const calls=[];
 const result=await applyReviewedBusinessAreaAuthorityPhase("reviewed.json",packet,"revoke",{
  withBinding:async(path,callback,dependencies)=>{calls.push({path,dependencies});return callback({db:{kind:"D1"},target:{kind:"staging"}});},
  applyPhase:async(db,value,phase,options)=>{calls.push({db,value,phase,options});return {replayed:false,phase};},root:"reviewed-root"});
 assert.deepEqual(result,{replayed:false,phase:"revoke"});
 assert.equal(calls[0].path,"reviewed.json");assert.equal(calls[1].value,packet);assert.equal(calls[1].phase,"revoke");assert.deepEqual(calls[1].options,{target:{kind:"staging"},root:"reviewed-root"});
});
test("runner rejects uncompiled packets and invalid phases before binding",async()=>{
 let opened=false,withBinding=async()=>{opened=true;};
 await assert.rejects(applyReviewedBusinessAreaAuthorityPhase("reviewed.json",{schemaVersion:1},"provision",{withBinding}),/reviewed compiled pair required/);
 await assert.rejects(applyReviewedBusinessAreaAuthorityPhase("reviewed.json",packet,"other",{withBinding}),/phase/);
 assert.equal(opened,false);
});
