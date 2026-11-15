import type { VerifiedClientPrincipal } from "./types";
import type { NativeOperationsRequestCapability } from "./operations-native-request-capability-read";

export interface OperationsNativePrincipalInquiryBinding {
  listNativePrincipalInquiries(requestJson:string):Promise<string>;
  submitNativePrincipalInquiry(requestJson:string):Promise<string>;
}
export type NativePrincipalInquiryProof=NativeOperationsRequestCapability;
export type OperationsPrincipalInquiry = Readonly<{id:string;kind:"website"|"drone"|"other";title:string;details:string;location:string|null;status:"received"|"under_review"|"declined"|"closed";createdAt:string}>;
export type OperationsPrincipalInquiryInput=Readonly<{kind:"website"|"drone"|"other";title:string;details:string;location:string|null;idempotencyKey:string}>;
const kinds=["website","drone","other"] as const;
function capability(value:NativeOperationsRequestCapability,principal:Pick<VerifiedClientPrincipal,"issuer"|"subject">){
 return {targetId:value.targetId,targetRevision:value.targetRevision,clientAuthorityId:value.clientAuthorityId,workspaceId:value.workspaceId,
  targetClientRecordId:value.targetClientRecordId,recipientBindingId:value.recipientBindingId,issuer:principal.issuer,subject:principal.subject,
  baseOperationId:value.baseOperationId,ownershipEpoch:value.ownershipEpoch,grantRevision:value.grantRevision,
  capabilityOperationId:value.capabilityOperationId,capabilityRevision:value.capabilityRevision,
  publicationOperationId:value.publicationOperationId,publicationRevision:value.publicationRevision,
  publicationSourceSequence:value.publicationSourceSequence,publicationSnapshotId:value.publicationSnapshotId,
  publicationSnapshotSha256:value.publicationSnapshotSha256,expiresAt:value.expiresAt};
}
export async function listNativePrincipalInquiries(binding:OperationsNativePrincipalInquiryBinding|undefined,
 principal:Pick<VerifiedClientPrincipal,"issuer"|"subject">,proofs:readonly NativePrincipalInquiryProof[]):Promise<readonly OperationsPrincipalInquiry[]|null>{
 if(!binding)return null;
 try{const raw=await binding.listNativePrincipalInquiries(JSON.stringify({protocolVersion:1,proofs:proofs.map(proof=>capability(proof,principal))}));
  if(raw.length>256*1024)return null;const result=JSON.parse(raw) as {ok?:unknown;inquiries?:unknown};
  if(result.ok!==true||!Array.isArray(result.inquiries)||result.inquiries.length>50)return null;
  const rows:OperationsPrincipalInquiry[]=[];
  for(const value of result.inquiries){if(!value||typeof value!=="object")return null;const row=value as Record<string,unknown>;
   if(typeof row.id!=="string"||typeof row.kind!=="string"||!kinds.includes(row.kind as typeof kinds[number])||typeof row.title!=="string"
     ||typeof row.details!=="string"||!(row.location===null||typeof row.location==="string")
     ||!(["received","under_review","declined","closed"] as const).includes(row.status as any)||typeof row.createdAt!=="string")return null;
   rows.push(row as unknown as OperationsPrincipalInquiry);}
  return rows;
 }catch{return null;}
}
export async function submitNativePrincipalInquiry(binding:OperationsNativePrincipalInquiryBinding|undefined,
 principal:Pick<VerifiedClientPrincipal,"issuer"|"subject">,proofs:readonly NativePrincipalInquiryProof[],input:OperationsPrincipalInquiryInput):Promise<
 {kind:"created"|"replayed";inquiry:OperationsPrincipalInquiry}|{kind:"conflict"}|{kind:"unavailable"}|null>{
 if(!binding)return null;
 try{const raw=await binding.submitNativePrincipalInquiry(JSON.stringify({protocolVersion:1,proofs:proofs.map(proof=>capability(proof,principal)),input}));
  if(raw.length>32*1024)return null;const result=JSON.parse(raw) as {ok?:unknown;code?:unknown;replayed?:unknown;inquiry?:unknown};
  if(result.ok!==true){if(result.code==="conflict")return{kind:"conflict"};return{kind:"unavailable"};}
  const row=result.inquiry as Record<string,unknown>|null;
  if(!row||typeof row.id!=="string"||typeof row.kind!=="string"||!kinds.includes(row.kind as typeof kinds[number])||typeof row.title!=="string"
   ||typeof row.details!=="string"||!(row.location===null||typeof row.location==="string")||typeof row.status!=="string"||typeof row.createdAt!=="string")return null;
  return {kind:result.replayed===true?"replayed":"created",inquiry:row as unknown as OperationsPrincipalInquiry};
 }catch{return null;}
}
