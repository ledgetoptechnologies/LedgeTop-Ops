import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { canonicalOperationsPortalNativeDeliveryAuthorityCommand as canonical, sha256OperationsPortalNativeDeliveryAuthorityCommand as fingerprint, type OperationsPortalNativeDeliveryAuthorityCommand } from "@ltds/shared/operations-portal-native-delivery-authority";
import { createOperationsNativeQueueRouter } from "../src/worker/client-portal/operations-native-queue-routes";
import { encodeOperationsNativeDeliveryHandle, type OperationsNativeDeliveryHandle } from "../src/worker/client-portal/operations-native-delivery-handles";
import type { Env } from "../src/worker/types";
const keys = vi.hoisted(()=>vi.fn());
vi.mock("jose",async()=>({...await vi.importActual<typeof import("jose")>("jose"),createRemoteJWKSet:keys}));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const principal = { issuer: 'https://synthetic.cloudflareaccess.com', subject: 'synthetic-recipient' };
function command(): OperationsPortalNativeDeliveryAuthorityCommand {
  return { protocol: 'operations-portal-native-delivery-authority', protocolVersion: 1, permissionSchemaVersion: 3,
    action: 'delivery.grant', operationId: id(1), authority: { authorityId: id(2), expectedRevision: '0', resultingRevision: '1' },
    target: { targetId: id(3), targetRevision: '1', clientAuthorityId: id(4), workspaceId: 'synthetic-workspace', rootKind: 'standalone_client', rootRecordId: 'synthetic-client' },
    recipient: { recipientBindingId: id(5), enrollmentIntentId: id(6), targetClientRecordId: 'synthetic-client', ...principal,
      homeOwnershipEpoch: '1', homeGrantRevision: '1', homeGrantOperationId: id(7), homeRequestFingerprint: 'a'.repeat(64) },
    publication: { operationId: id(8), publicationId: id(9), revision: '1', sourceSequence: '1', snapshotId: id(10), snapshotSha256: 'b'.repeat(64) },
    resource: { folderReservationId: id(11), folderReservationRevision: '1', clientFolderBindingId: 'synthetic-folder', externalProjectId: 'synthetic-project',
      projectVersion: '1', opsFolderProjectId: 'synthetic-physical-project', opsDivisionId: 'synthetic-division', selectedR2Prefix: 'synthetic/photos/',
      baseR2Prefix: 'synthetic/', baseMatchMethod: 'manual', baseConfirmedBy: 'synthetic-owner', baseConfirmedAt: new Date().toISOString() },
    features: ['folder.list', 'file.metadata', 'file.preview', 'file.download'], expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    reasonCode: 'synthetic-acceptance', observedAt: new Date().toISOString() };
}
function proof(value: OperationsPortalNativeDeliveryAuthorityCommand) {
  return { authorityId: value.authority.authorityId, authorityRevision: Number(value.authority.resultingRevision), recipientBindingId: value.recipient.recipientBindingId,
    enrollmentIntentId: value.recipient.enrollmentIntentId, issuer: value.recipient.issuer, subject: value.recipient.subject,
    targetId: value.target.targetId, targetRevision: Number(value.target.targetRevision), targetClientRecordId: value.recipient.targetClientRecordId,
    clientAuthorityId: value.target.clientAuthorityId, workspaceId: value.target.workspaceId, clientFolderBindingId: value.resource.clientFolderBindingId,
    folderReservationId: value.resource.folderReservationId, folderReservationRevision: Number(value.resource.folderReservationRevision), externalProjectId: value.resource.externalProjectId,
    projectVersion: Number(value.resource.projectVersion), publicationOperationId: value.publication.operationId, publicationId: value.publication.publicationId,
    publicationRevision: Number(value.publication.revision), publicationSourceSequence: Number(value.publication.sourceSequence), publicationSnapshotId: value.publication.snapshotId, publicationSnapshotSha256: value.publication.snapshotSha256,
    homeOwnershipEpoch: Number(value.recipient.homeOwnershipEpoch), homeGrantRevision: Number(value.recipient.homeGrantRevision), homeGrantOperationId: value.recipient.homeGrantOperationId,
    homeRequestFingerprint: value.recipient.homeRequestFingerprint, opsFolderProjectId: value.resource.opsFolderProjectId,
    opsDivisionId: value.resource.opsDivisionId, selectedR2Prefix: value.resource.selectedR2Prefix,
    expiresAt: value.expiresAt, features: value.features };
}
function handle(kind: 'folder' | 'file' = 'folder'): OperationsNativeDeliveryHandle {
  return { v: 1, kind, authorityId: id(2), authorityRevision: '1', recipientBindingId: id(5), enrollmentIntentId: id(6), targetClientRecordId: 'synthetic-client',
    issuer: principal.issuer, subject: principal.subject, targetId: id(3), targetRevision: '1', clientAuthorityId: id(4), workspaceId: 'synthetic-workspace',
    homeOwnershipEpoch: '1', homeGrantRevision: '1', homeGrantOperationId: id(7), homeRequestFingerprint: 'a'.repeat(64),
    publicationId: id(9), publicationOperationId: id(8), publicationRevision: '1', publicationSourceSequence: '1', snapshotId: id(10), snapshotSha256: 'b'.repeat(64),
    folderReservationId: id(11), folderReservationRevision: '1', clientFolderBindingId: 'synthetic-folder', externalProjectId: 'synthetic-project', projectVersion: '1',
    path: kind === 'file' ? 'photo.jpg' : '', ...(kind === 'file' ? { etag: 'synthetic-etag' } : {}), expires: Date.now() + 600_000 };
}
const origin="https://client-staging.ledgetopdroneservices.com", audience="synthetic-portal-queue-audience", prefix="/api/client/operations/data/queue";
describe("native portal durable queue with actual RS256 and exact canonical authority",()=>{
 let env:Env, token:string, pair:Awaited<ReturnType<typeof generateKeyPair>>, value:OperationsPortalNativeDeliveryAuthorityCommand;
 let row:{canonical_command_json:string;request_fingerprint:string}|null;
 const head=vi.fn(), get=vi.fn(), rpc=vi.fn(), index=vi.fn();
 const config={enabled:true,portalOrigin:origin,issuer:principal.issuer,audience,queueKey:new Uint8Array(32).fill(7)};
 beforeAll(async()=>{pair=await generateKeyPair("RS256",{extractable:true});const k=await exportJWK(pair.publicKey);k.kid="queue";keys.mockReturnValue(createLocalJWKSet({keys:[k]}));});
 async function refresh(){row={canonical_command_json:canonical(value),request_fingerprint:await fingerprint(value)};}
 async function jwt(subject=principal.subject,claims:Record<string,unknown>={}){return new SignJWT({type:"app",email:"synthetic@example.invalid",...claims}).setProtectedHeader({alg:"RS256",kid:"queue"}).setIssuer(principal.issuer).setSubject(subject).setAudience(audience).setExpirationTime("1h").sign(pair.privateKey);}
 beforeEach(async()=>{
  vi.clearAllMocks();value=command();await refresh();token=await jwt();
  head.mockResolvedValue({etag:"synthetic-etag",httpEtag:'"synthetic-etag"',size:42,version:"provider-one",checksums:{sha256:new Uint8Array(32).fill(10).buffer}});
  index.mockResolvedValue({r2_key:"synthetic/photos/photo.jpg",etag:"synthetic-etag",size:42,uploaded_at:new Date().toISOString(),content_type:"image/jpeg",media_kind:"image"});
  rpc.mockImplementation(async()=>JSON.stringify({ok:true,protocolVersion:1,authorization:proof(value)}));
  env={ENVIRONMENT:"staging",CLIENT_PORTAL_ORIGIN:origin,CLIENT_PORTAL_ENABLED:"true",CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED:"true",DELIVERY_SESSION_SECRET:"s".repeat(48),CLIENT_ACCESS_TEAM_DOMAIN:principal.issuer,CLIENT_ACCESS_AUD:audience,
   DELIVERY_DB:{withSession:()=>({prepare:(sql:string)=>({bind:()=>({first:()=>sql.includes("operations_portal_native_delivery_live_heads")?Promise.resolve(row):index()})})})},
   DATA_BUCKET:{head,get},OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER:{readNativeDeliveryAuthorization:rpc}} as unknown as Env;
 });
 const call=(path:string,extra:HeadersInit={},instance=createOperationsNativeQueueRouter(config))=>instance.fetch(new Request(origin+prefix+path,{headers:{"Cf-Access-Jwt-Assertion":token,...extra}}),env);
 async function select(){const selector=await encodeOperationsNativeDeliveryHandle(env,handle("file"));const r=await call("/reference?fileHandle="+selector);expect(r.status).toBe(200);return await r.json() as {schemaVersion:number;principalId:string;resourceRef:string;manifest:Record<string,unknown>};}
 it("derives person from signed Access, renews fresh byte handles and never reads source bytes",async()=>{
  const session=await call("/session");expect(session.status).toBe(200);const p=await session.json() as {principalId:string};expect(p.principalId).toMatch(/^odqp1_[a-f0-9]{64}$/u);
  const selected=await select();expect(selected.principalId).toBe(p.principalId);expect(selected.resourceRef).toMatch(/^odqr1_/u);expect(head).not.toHaveBeenCalled();expect(index).not.toHaveBeenCalled();expect(Object.keys(selected)).toEqual(["schemaVersion","principalId","resourceRef"]);
  const r=await call("/resolve?resourceRef="+selected.resourceRef);expect(r.status).toBe(200);const renewed=await r.json() as typeof selected;
  expect(renewed.manifest.logicalFileId).toMatch(/^ondf1_[a-f0-9]{64}$/u);expect(renewed.manifest.remoteVersion).toBe("provider-one");const second=await call("/resolve?resourceRef="+selected.resourceRef);expect(second.status).toBe(200);const next=await second.json() as typeof selected;expect(next.manifest.downloadPath).not.toBe(renewed.manifest.downloadPath);expect(next.manifest.logicalFileId).toBe(renewed.manifest.logicalFileId);
  expect(Object.keys(renewed)).toEqual(["schemaVersion","principalId","manifest"]);expect(Object.keys(renewed.manifest)).toHaveLength(9);expect(get).not.toHaveBeenCalled();
  expect(JSON.stringify(renewed)).not.toContain("synthetic/photos/");expect(JSON.stringify(selected.resourceRef)).not.toContain("photo.jpg");
 });
 it("publication refresh remains409 until an authoritative continuity transition is implemented",async()=>{
  const selected=await select();head.mockClear();index.mockClear();
  value={...value,publication:{...value.publication,revision:"2",sourceSequence:"2",snapshotId:id(90)}};await refresh();
  const r=await call("/resolve?resourceRef="+selected.resourceRef);expect(r.status).toBe(409);expect(head).not.toHaveBeenCalled();expect(index).not.toHaveBeenCalled();
 });
 it.each(["recipient","target","home","grant","root"])("cannot follow changed %s lifecycle",async kind=>{
  const selected=await select();head.mockClear();
  if(kind==="recipient")value={...value,recipient:{...value.recipient,recipientBindingId:id(91)}};
  if(kind==="target")value={...value,target:{...value.target,targetRevision:"2"}};
  if(kind==="home")value={...value,recipient:{...value.recipient,homeOwnershipEpoch:"2"}};
  if(kind==="grant")value={...value,authority:{...value.authority,expectedRevision:"1",resultingRevision:"2"}};
  if(kind==="root")value={...value,resource:{...value.resource,folderReservationRevision:"2"}};
  await refresh();expect((await call("/resolve?resourceRef="+selected.resourceRef)).status).toBe(409);expect(head).not.toHaveBeenCalled();
 });
 it("revocation during HEAD fails closed without a reference or manifest",async()=>{
  const selected=await select();head.mockImplementation(async()=>{row=null;return {etag:"synthetic-etag",httpEtag:'"synthetic-etag"',size:42,version:"v",checksums:{sha256:new Uint8Array(32).buffer}};});
  expect((await call("/resolve?resourceRef="+selected.resourceRef)).status).toBe(404);expect(get).not.toHaveBeenCalled();
 });
 it("other human and service identity cannot resolve a reference",async()=>{
  const selected=await select();head.mockClear();token=await jwt("different-person");expect((await call("/resolve?resourceRef="+selected.resourceRef)).status).toBe(409);
  token=await jwt(principal.subject,{service_token_id:"machine"});expect((await call("/session")).status).toBe(401);expect(head).not.toHaveBeenCalled();
 });
 it("rejects wrong origin, cross-site, mutations and duplicate query aliases",async()=>{
  expect((await call("/session",{Origin:"https://evil.example"})).status).toBe(403);
  expect((await call("/session",{"Sec-Fetch-Site":"cross-site"})).status).toBe(403);
  expect((await call("/resolve?resourceRef=x&%72esourceRef=y")).status).toBe(503);
  expect((await createOperationsNativeQueueRouter(config).fetch(new Request(origin+prefix+"/session",{method:"POST"}),env)).status).toBe(405);
 });
});
