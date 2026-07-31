import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { snapshot } from "../workflow";
import { classifyCloudFailure } from "./errors";
import { decryptCloudSecret, decryptWithRotation, encryptCloudSecret } from "./grants";
import { cloudDb, cloudJobCancelled, finalizeCloudJob, getCloudJob, listCloudItems, markCloudItemFailure, markCloudItemResult, markCloudItemRunning, replaceCloudItems } from "./repository";
import { createCloudProviderAdapter } from "./providers";
import { refreshDropboxToken, refreshGoogleToken } from "./oauth";
import type { CloudCredential, CloudTransferEnv, CloudTransferItem, CloudTransferJob, TransferSource } from "./types";

async function loadCredential(env:CloudTransferEnv,job:CloudTransferJob):Promise<CloudCredential>{
 const row=await cloudDb(env).prepare("SELECT credential_ciphertext,credential_iv,key_id,expires_at,revoked_at FROM cloud_transfer_authorizations WHERE id=? AND share_id=? AND share_version=? AND provider=?").bind(job.authorization_id,job.share_id,job.share_version,job.provider).first<{credential_ciphertext:string;credential_iv:string;key_id:string;expires_at:string;revoked_at:string|null}>();
 if(!row||row.revoked_at||!row.credential_ciphertext||Date.parse(row.expires_at)<=Date.now())throw new Error("authorization-expired");
 let credential=await decryptWithRotation<CloudCredential>({ciphertext:row.credential_ciphertext,iv:row.credential_iv,keyId:row.key_id},env,`authorization:${job.authorization_id}:${job.provider}`);
 if(credential.expiresAt&&Date.parse(credential.expiresAt)<=Date.now()+120000){
  if(!credential.refreshToken)throw new Error("authorization-expired");
  const refreshed=job.provider==="dropbox"?await refreshDropboxToken({clientId:env.DROPBOX_CLIENT_ID!,clientSecret:env.DROPBOX_CLIENT_SECRET!,refreshToken:credential.refreshToken}):await refreshGoogleToken({clientId:env.GOOGLE_CLIENT_ID!,clientSecret:env.GOOGLE_CLIENT_SECRET!,refreshToken:credential.refreshToken});
  credential={...credential,...refreshed,refreshToken:refreshed.refreshToken||credential.refreshToken};
  const encrypted=await encryptCloudSecret(credential,env.CLOUD_TRANSFER_TOKEN_SECRET,`authorization:${job.authorization_id}:${job.provider}`);
  await cloudDb(env).prepare("UPDATE cloud_transfer_authorizations SET credential_ciphertext=?,credential_iv=?,key_id=?,token_expires_at=?,last_used_at=datetime('now') WHERE id=? AND revoked_at IS NULL").bind(encrypted.ciphertext,encrypted.iv,env.CLOUD_TRANSFER_KEY_ID||"v1",credential.expiresAt||null,job.authorization_id).run();
 }
 return credential;
}
async function loadUploadState<T>(env:CloudTransferEnv,job:CloudTransferJob,item:CloudTransferItem):Promise<{state:T;uploadedBytes:number}|null>{
 if(!item.upload_state_ciphertext||!item.upload_state_iv)return null;const purpose=`upload-state:${item.id}:${job.provider}`;
 try{return{state:await decryptCloudSecret<T>(item.upload_state_ciphertext,item.upload_state_iv,env.CLOUD_TRANSFER_TOKEN_SECRET,purpose),uploadedBytes:item.uploaded_bytes};}
 catch{if(!env.CLOUD_TRANSFER_PREVIOUS_TOKEN_SECRET)return null;try{return{state:await decryptCloudSecret<T>(item.upload_state_ciphertext,item.upload_state_iv,env.CLOUD_TRANSFER_PREVIOUS_TOKEN_SECRET,purpose),uploadedBytes:item.uploaded_bytes};}catch{return null;}}
}
async function shareActive(env:CloudTransferEnv,job:CloudTransferJob):Promise<boolean>{return Boolean(await cloudDb(env).prepare("SELECT s.id FROM shares s JOIN projects p ON p.id=s.project_id WHERE s.id=? AND s.share_version=? AND s.revoked_at IS NULL AND p.active=1 AND (s.expires_at IS NULL OR datetime(s.expires_at)>datetime('now'))").bind(job.share_id,job.share_version).first());}
export async function snapshotCloudTransfer(env:CloudTransferEnv,job:CloudTransferJob):Promise<TransferSource[]>{
 const value=await snapshot(env,{id:job.id,share_id:job.share_id,share_version:job.share_version,request_json:job.selection_json,manifest_key:"",archive_key:""});
 return value.sources.map(source=>({physicalKey:source.physicalKey,relativePath:source.name,destinationPath:source.name,size:source.size,etag:source.etag}));
}
export async function runCloudTransferJob(env:CloudTransferEnv,jobId:string,step:Pick<WorkflowStep,"do"|"sleep">):Promise<void>{
 const initial=await getCloudJob(env,jobId);if(!initial)throw new Error("job-not-found");
 try{
  if(initial.status==="queued"){const sources=await step.do("snapshot-selection",async()=>snapshotCloudTransfer(env,initial));await step.do("persist-selection",async()=>{await replaceCloudItems(env,initial,sources);return{count:sources.length};});}
  const job=await getCloudJob(env,jobId);if(!job||!["running","cancelling"].includes(job.status))return;
  const adapter=createCloudProviderAdapter(job.provider,env);const destination=JSON.parse(job.destination_json) as unknown;
  for(const item of await listCloudItems(env,job.id)){
   if(!["queued","retrying"].includes(item.status))continue;
   if(await cloudJobCancelled(env,job.id)||!(await shareActive(env,job))){await cloudDb(env).prepare("UPDATE cloud_transfer_jobs SET status='cancelling',cancel_requested_at=COALESCE(cancel_requested_at,datetime('now')) WHERE id=?").bind(job.id).run();break;}
   let current=item;
   for(let attempt=current.attempts;attempt<4;attempt+=1){
    const outcome=await step.do(`transfer-${item.ordinal}-${attempt}`,async()=>{
     await markCloudItemRunning(env,item.id);current=(await cloudDb(env).prepare("SELECT * FROM cloud_transfer_items WHERE id=?").bind(item.id).first<typeof item>())!;
     try{const credential=await loadCredential(env,job);const result=await adapter.transfer({env,job,item:current,credential,destination,conflictMode:job.conflict_mode,signalCancelled:()=>cloudJobCancelled(env,job.id),loadUploadState:()=>loadUploadState<unknown>(env,job,current),saveUploadState:async(state,bytes)=>{const encrypted=await encryptCloudSecret(state,env.CLOUD_TRANSFER_TOKEN_SECRET,`upload-state:${item.id}:${job.provider}`);await cloudDb(env).prepare("UPDATE cloud_transfer_items SET upload_state_ciphertext=?,upload_state_iv=?,uploaded_bytes=?,updated_at=datetime('now') WHERE id=?").bind(encrypted.ciphertext,encrypted.iv,bytes,item.id).run();}});await markCloudItemResult(env,current,result);return{terminal:true};}
     catch(error){const failure=classifyCloudFailure(error);await markCloudItemFailure(env,current,failure);console.error(JSON.stringify({event:"cloud-transfer.item-failed",jobId,itemId:item.id,provider:job.provider,code:failure.code,error:error instanceof Error?error.message:String(error)}));return{terminal:!failure.retryable};}
    });
    if(outcome.terminal)break;
    await step.sleep(`retry-wait-${item.ordinal}-${attempt}`,`${Math.min(300,5*2**attempt)} seconds`);
    current=(await cloudDb(env).prepare("SELECT * FROM cloud_transfer_items WHERE id=?").bind(item.id).first<typeof item>())!;
   }
  }
  await step.do("finalize-job",async()=>{await finalizeCloudJob(env,job.id);return{finalized:true};});
 }catch(error){const failure=classifyCloudFailure(error);console.error(JSON.stringify({event:"cloud-transfer.workflow-failed",jobId,code:failure.code,error:error instanceof Error?error.message:String(error)}));await cloudDb(env).prepare("UPDATE cloud_transfer_jobs SET status='failed',error_code=?,error_message=?,completed_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status IN ('queued','running')").bind(failure.code,failure.message,jobId).run();throw error;}
}
export class CloudTransferWorkflow extends WorkflowEntrypoint<CloudTransferEnv>{async run(event:Readonly<WorkflowEvent<{jobId:string}>>,step:WorkflowStep):Promise<void>{await runCloudTransferJob(this.env,event.payload.jobId,step);}}
