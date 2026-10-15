/** Closed private wire for one explicitly selected native billing entity.
 * Parsing proves shape and internal relationships only. It grants nothing:
 * consumers must verify current recipient, publication, entity ownership,
 * actor authority and deny state before applying or reading financial data. */
export const OPERATIONS_PORTAL_NATIVE_BILLING_AUTHORITY_PROTOCOL =
  "operations-portal-native-billing-authority" as const;
export const OPERATIONS_PORTAL_NATIVE_BILLING_AUTHORITY_VERSION = 1 as const;
export const OPERATIONS_PORTAL_NATIVE_BILLING_AUTHORITY_MAX_BYTES = 32_768;

export type OperationsPortalNativeBillingEntityKind = "organization" | "client" | "project";
export type OperationsPortalNativeBillingAuthorityAction = "billing.grant" | "billing.revoke";
export type OperationsPortalNativeBillingAuthorityCommand = Readonly<{
  protocol: typeof OPERATIONS_PORTAL_NATIVE_BILLING_AUTHORITY_PROTOCOL;
  protocolVersion: typeof OPERATIONS_PORTAL_NATIVE_BILLING_AUTHORITY_VERSION;
  action: OperationsPortalNativeBillingAuthorityAction;
  operationId: string;
  authority: Readonly<{ grantId: string; expectedRevision: string; resultingRevision: string }>;
  workspace: Readonly<{ targetId: string; targetRevision: string; clientAuthorityId: string; workspaceId: string;
    rootKind: "organization" | "standalone_client"; rootRecordId: string }>;
  recipient: Readonly<{ recipientBindingId: string; enrollmentIntentId: string; targetClientRecordId: string;
    issuer: string; subject: string; ownershipEpoch: string; grantRevision: string;
    grantOperationId: string; requestFingerprint: string }>;
  publication: Readonly<{ operationId: string; publicationId: string; revision: string; sourceSequence: string;
    snapshotId: string; snapshotSha256: string; requestFingerprint: string }>;
  entity: Readonly<{ kind: OperationsPortalNativeBillingEntityKind; nativeId: string }>;
  actorProof: Readonly<{ staffId: string; verifiedAccessSubject: string; admissionVersion: string;
    profileVersion: string; grantGeneration: string; verifiedUntil: string }>;
  /** Null means this one explicit entity grant has no time expiry. It never
   * means every entity, inherited access, or wildcard scope. */
  expiresAt: string | null;
  observedAt: string;
}>;

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH=/^[0-9a-f]{64}$/u,INTEGER=/^(?:0|[1-9][0-9]{0,15})$/u,MAX_INTEGER="9007199254740991";
const encoder=new TextEncoder();
type UnknownRecord=Record<string,unknown>;

function exact(value:unknown,keys:readonly string[]):UnknownRecord|null{
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)return null;
  const names=Reflect.ownKeys(value);if(names.length!==keys.length||names.some(key=>typeof key!=="string"||!keys.includes(key)))return null;
  const result:UnknownRecord={};for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor?.enumerable||!("value" in descriptor))return null;result[key]=descriptor.value;}return result;
}
function uuid(value:unknown):value is string{return typeof value==="string"&&UUID.test(value)}
function hash(value:unknown):value is string{return typeof value==="string"&&HASH.test(value)}
function integer(value:unknown,positive=true):value is string{return typeof value==="string"&&INTEGER.test(value)
  &&(!positive||value!=="0")&&(value.length<MAX_INTEGER.length||value.length===MAX_INTEGER.length&&value<=MAX_INTEGER)}
function text(value:unknown,maximum=191):value is string{
  if(typeof value!=="string"||!value||value!==value.trim()||Array.from(value).length>maximum||/\p{C}/u.test(value))return false;
  const bytes=encoder.encode(value);try{return bytes.byteLength<=maximum*4&&new TextDecoder("utf-8",{fatal:true}).decode(bytes)===value}catch{return false}
}
function instant(value:unknown):value is string{if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))return false;
  const parsed=Date.parse(value);return Number.isFinite(parsed)&&new Date(parsed).toISOString()===value}
function issuer(value:unknown):value is string{if(typeof value!=="string"||value.length>512)return false;try{const url=new URL(value);
  return url.protocol==="https:"&&url.origin===value&&!url.port&&!url.username&&!url.password
    &&url.hostname.endsWith(".cloudflareaccess.com")&&url.hostname!==".cloudflareaccess.com"}catch{return false}}

function parse(value:unknown):OperationsPortalNativeBillingAuthorityCommand|null{
  const command=exact(value,["protocol","protocolVersion","action","operationId","authority","workspace","recipient",
    "publication","entity","actorProof","expiresAt","observedAt"]);
  if(!command||command.protocol!==OPERATIONS_PORTAL_NATIVE_BILLING_AUTHORITY_PROTOCOL
    ||command.protocolVersion!==OPERATIONS_PORTAL_NATIVE_BILLING_AUTHORITY_VERSION
    ||command.action!=="billing.grant"&&command.action!=="billing.revoke"||!uuid(command.operationId)||!instant(command.observedAt))return null;
  const authority=exact(command.authority,["grantId","expectedRevision","resultingRevision"]);
  const workspace=exact(command.workspace,["targetId","targetRevision","clientAuthorityId","workspaceId","rootKind","rootRecordId"]);
  const recipient=exact(command.recipient,["recipientBindingId","enrollmentIntentId","targetClientRecordId","issuer","subject",
    "ownershipEpoch","grantRevision","grantOperationId","requestFingerprint"]);
  const publication=exact(command.publication,["operationId","publicationId","revision","sourceSequence","snapshotId","snapshotSha256","requestFingerprint"]);
  const entity=exact(command.entity,["kind","nativeId"]);
  const actor=exact(command.actorProof,["staffId","verifiedAccessSubject","admissionVersion","profileVersion","grantGeneration","verifiedUntil"]);
  if(!authority||!uuid(authority.grantId)||!integer(authority.expectedRevision,false)||!integer(authority.resultingRevision)
    ||BigInt(authority.resultingRevision)!==BigInt(authority.expectedRevision)+1n
    ||!workspace||!uuid(workspace.targetId)||!integer(workspace.targetRevision)||!uuid(workspace.clientAuthorityId)
    ||!text(workspace.workspaceId,200)||!text(workspace.rootRecordId)
    ||workspace.rootKind!=="organization"&&workspace.rootKind!=="standalone_client"
    ||!recipient||!uuid(recipient.recipientBindingId)||!uuid(recipient.enrollmentIntentId)||!text(recipient.targetClientRecordId)
    ||!issuer(recipient.issuer)||!text(recipient.subject,512)||!integer(recipient.ownershipEpoch)||!integer(recipient.grantRevision)
    ||!uuid(recipient.grantOperationId)||!hash(recipient.requestFingerprint)
    ||!publication||!uuid(publication.operationId)||!uuid(publication.publicationId)||!integer(publication.revision)
    ||!integer(publication.sourceSequence)||!uuid(publication.snapshotId)||!hash(publication.snapshotSha256)||!hash(publication.requestFingerprint)
    ||!entity||entity.kind!=="organization"&&entity.kind!=="client"&&entity.kind!=="project"||!text(entity.nativeId)
    ||entity.kind==="organization"&&(workspace.rootKind!=="organization"||entity.nativeId!==workspace.rootRecordId)
    ||entity.kind==="client"&&entity.nativeId!==recipient.targetClientRecordId
    ||!actor||!text(actor.staffId)||!text(actor.verifiedAccessSubject,764)||!integer(actor.admissionVersion)
    ||!integer(actor.profileVersion)||!integer(actor.grantGeneration)||!instant(actor.verifiedUntil)
    ||actor.verifiedUntil<=command.observedAt)return null;
  const grant=command.action==="billing.grant";
  if(grant?(command.expiresAt!==null&&(!instant(command.expiresAt)||command.expiresAt<=command.observedAt))
    :command.expiresAt!==null)return null;
  const result:OperationsPortalNativeBillingAuthorityCommand=Object.freeze({
    protocol:OPERATIONS_PORTAL_NATIVE_BILLING_AUTHORITY_PROTOCOL,protocolVersion:1,action:command.action,
    operationId:command.operationId,
    authority:Object.freeze({grantId:authority.grantId,expectedRevision:authority.expectedRevision,resultingRevision:authority.resultingRevision}),
    workspace:Object.freeze({targetId:workspace.targetId,targetRevision:workspace.targetRevision,clientAuthorityId:workspace.clientAuthorityId,
      workspaceId:workspace.workspaceId,rootKind:workspace.rootKind,rootRecordId:workspace.rootRecordId}),
    recipient:Object.freeze({recipientBindingId:recipient.recipientBindingId,enrollmentIntentId:recipient.enrollmentIntentId,
      targetClientRecordId:recipient.targetClientRecordId,issuer:recipient.issuer,subject:recipient.subject,
      ownershipEpoch:recipient.ownershipEpoch,grantRevision:recipient.grantRevision,grantOperationId:recipient.grantOperationId,
      requestFingerprint:recipient.requestFingerprint}),
    publication:Object.freeze({operationId:publication.operationId,publicationId:publication.publicationId,revision:publication.revision,
      sourceSequence:publication.sourceSequence,snapshotId:publication.snapshotId,snapshotSha256:publication.snapshotSha256,
      requestFingerprint:publication.requestFingerprint}),entity:Object.freeze({kind:entity.kind,nativeId:entity.nativeId}),
    actorProof:Object.freeze({staffId:actor.staffId,verifiedAccessSubject:actor.verifiedAccessSubject,
      admissionVersion:actor.admissionVersion,profileVersion:actor.profileVersion,grantGeneration:actor.grantGeneration,
      verifiedUntil:actor.verifiedUntil}),expiresAt:command.expiresAt as string|null,observedAt:command.observedAt,
  });
  return encoder.encode(JSON.stringify(result)).byteLength<=OPERATIONS_PORTAL_NATIVE_BILLING_AUTHORITY_MAX_BYTES?result:null;
}

export function parseOperationsPortalNativeBillingAuthorityCommand(value:unknown):OperationsPortalNativeBillingAuthorityCommand|null{
  try{return parse(value)}catch{return null}
}
export function canonicalOperationsPortalNativeBillingAuthorityCommand(value:unknown):string{
  const command=parseOperationsPortalNativeBillingAuthorityCommand(value);
  if(!command)throw new Error("operations_portal_native_billing_authority_invalid");return JSON.stringify(command);
}
export async function sha256OperationsPortalNativeBillingAuthorityCommand(value:unknown):Promise<string>{
  const bytes=encoder.encode(canonicalOperationsPortalNativeBillingAuthorityCommand(value));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(byte=>byte.toString(16).padStart(2,"0")).join("");
}
