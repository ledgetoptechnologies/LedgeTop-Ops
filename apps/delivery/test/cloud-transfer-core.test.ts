import { describe, expect, it } from "vitest";
import { classifyCloudFailure, friendlyCloudFailure } from "../src/worker/cloud-transfer/errors";
import { decryptCloudSecret, decryptWithRotation, encryptCloudSecret } from "../src/worker/cloud-transfer/grants";
import type { CloudTransferEnv } from "../src/worker/cloud-transfer/types";
import { activatePendingGoogleJob, getGooglePickerAuthorization, validGoogleFolderId } from "../src/worker/cloud-transfer/repository";

describe("cloud transfer safe errors",()=>{
 it("maps provider failures without exposing raw provider details",()=>{
  expect(classifyCloudFailure(new Error("request 429 bearer secret-token")).code).toBe("provider-rate-limited");
  expect(classifyCloudFailure(new Error("ETag precondition failed")).code).toBe("source-changed");
  expect(classifyCloudFailure(new Error("unexpected token abc123"))).toEqual(friendlyCloudFailure("transfer-failed"));
 });
});

describe("cloud transfer secret encryption",()=>{
 const current="current-cloud-transfer-secret-material-at-least-32";
 const previous="previous-cloud-transfer-secret-material-at-least-32";
 it("round trips JSON and binds ciphertext to its entity purpose",async()=>{
  const encrypted=await encryptCloudSecret({accessToken:"not-logged"},current,"authorization:auth-1:dropbox");
  await expect(decryptCloudSecret(encrypted.ciphertext,encrypted.iv,current,"authorization:auth-1:dropbox")).resolves.toEqual({accessToken:"not-logged"});
  await expect(decryptCloudSecret(encrypted.ciphertext,encrypted.iv,current,"authorization:auth-2:dropbox")).rejects.toThrow("authorization-expired");
 });
 it("supports a bounded previous-key rotation window",async()=>{
  const encrypted=await encryptCloudSecret({accessToken:"old"},previous,"authorization:auth-1:google");
  const env={CLOUD_TRANSFER_TOKEN_SECRET:current,CLOUD_TRANSFER_KEY_ID:"v2",CLOUD_TRANSFER_PREVIOUS_TOKEN_SECRET:previous,CLOUD_TRANSFER_PREVIOUS_KEY_ID:"v1"} as CloudTransferEnv;
  await expect(decryptWithRotation({ciphertext:encrypted.ciphertext,iv:encrypted.iv,keyId:"v1"},env,"authorization:auth-1:google")).resolves.toEqual({accessToken:"old"});
  await expect(decryptWithRotation({ciphertext:encrypted.ciphertext,iv:encrypted.iv,keyId:"unknown"},env,"authorization:auth-1:google")).rejects.toThrow("authorization-expired");
 });
});

describe("Google Picker repository authorization",()=>{
 it("validates opaque Drive folder identifiers without accepting paths or URLs",()=>{
  expect(validGoogleFolderId("1AbC_def-ghi")).toBe(true);
  expect(validGoogleFolderId("root")).toBe(true);
  expect(validGoogleFolderId("../folder")).toBe(false);
  expect(validGoogleFolderId("https://drive.google.com/folder")).toBe(false);
 });
 it("binds token lookup and destination activation to authorization, share, and version",async()=>{
  const calls:Array<{sql:string;binds:unknown[]}>=[];let firstCount=0;
  const job={id:"job-1",share_id:"share-1",share_version:7,authorization_id:"auth-1",provider:"google",selection_json:'{"all":true}',destination_json:'{"pendingPicker":true}',conflict_mode:"autorename",status:"queued",file_count:0,processed_files:0,succeeded_files:0,failed_files:0,total_bytes:0,processed_bytes:0,cancel_requested_at:null,error_code:null,error_message:null,expires_at:"2099-01-01"};
  const session={prepare:(sql:string)=>{const call={sql,binds:[] as unknown[]};calls.push(call);return{bind:(...values:unknown[])=>{call.binds=values;return{
   first:async()=>{firstCount+=1;return firstCount===1?{id:"auth-1",credential_ciphertext:"cipher",credential_iv:"iv",key_id:"v1"}:job;},
   run:async()=>({meta:{changes:1}}),
  };}};}};
  const env={DELIVERY_DB:{withSession:()=>session}} as unknown as CloudTransferEnv;
  await expect(getGooglePickerAuthorization(env,"auth-1","share-1",7)).resolves.toMatchObject({id:"auth-1"});
  await expect(activatePendingGoogleJob(env,{authorizationId:"auth-1",shareId:"share-1",shareVersion:7,folderId:"folder_123"})).resolves.toMatchObject({id:"job-1",destination_json:'{"folderId":"folder_123"}'});
  expect(calls[0]?.binds).toEqual(["auth-1","share-1",7]);
  expect(calls[1]?.binds).toEqual(["auth-1","share-1",7]);
  expect(calls[2]?.binds).toEqual(['{"folderId":"folder_123"}',"job-1"]);
  expect(calls[1]?.sql).toContain("pendingPicker");
  expect(calls[2]?.sql).toContain("pendingPicker");
 });
 it("rejects invalid destinations before touching D1",async()=>{
  let touched=false;const env={DELIVERY_DB:{withSession:()=>({prepare:()=>{touched=true;throw new Error("unexpected");}})}} as unknown as CloudTransferEnv;
  await expect(activatePendingGoogleJob(env,{authorizationId:"auth",shareId:"share",shareVersion:1,folderId:"../bad"})).resolves.toBeNull();
  expect(touched).toBe(false);
 });
});
