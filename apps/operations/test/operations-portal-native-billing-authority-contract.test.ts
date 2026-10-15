import { describe,expect,it } from "vitest";
import { canonicalOperationsPortalNativeBillingAuthorityCommand,parseOperationsPortalNativeBillingAuthorityCommand,
  sha256OperationsPortalNativeBillingAuthorityCommand } from
  "../../../packages/shared/src/operations-portal-native-billing-authority";

const id=(n:number)=>`${String(n).padStart(8,"0")}-0000-4000-8000-000000000000`;
const fixture=(kind:"organization"|"client"|"project"="organization")=>({
  protocol:"operations-portal-native-billing-authority",protocolVersion:1,action:"billing.grant",operationId:id(1),
  authority:{grantId:id(2),expectedRevision:"0",resultingRevision:"1"},
  workspace:{targetId:id(3),targetRevision:"4",clientAuthorityId:id(4),workspaceId:"workspace-one",
    rootKind:"organization",rootRecordId:"organization-one"},
  recipient:{recipientBindingId:id(5),enrollmentIntentId:id(6),targetClientRecordId:"client-one",
    issuer:"https://example.cloudflareaccess.com",subject:"access-subject",ownershipEpoch:"2",grantRevision:"3",
    grantOperationId:id(7),requestFingerprint:"a".repeat(64)},
  publication:{operationId:id(8),publicationId:id(9),revision:"5",sourceSequence:"6",snapshotId:id(10),
    snapshotSha256:"b".repeat(64),requestFingerprint:"c".repeat(64)},
  entity:{kind,nativeId:kind==="organization"?"organization-one":kind==="client"?"client-one":"ops/project-one"},
  actorProof:{staffId:"owner",verifiedAccessSubject:"access|owner",admissionVersion:"1",profileVersion:"2",
    grantGeneration:"3",verifiedUntil:"2030-01-01T01:00:00.000Z"},
  expiresAt:"2030-01-10T00:00:00.000Z",observedAt:"2030-01-01T00:00:00.000Z",
});

describe("closed Ops-native billing authority protocol",()=>{
  it.each(["organization","client","project"] as const)("parses one explicit %s entity without inference",async kind=>{
    const raw=fixture(kind),parsed=parseOperationsPortalNativeBillingAuthorityCommand(raw);
    expect(parsed?.entity).toEqual(raw.entity);expect(Object.isFrozen(parsed?.entity)).toBe(true);
    const canonical=canonicalOperationsPortalNativeBillingAuthorityCommand(raw);
    expect(canonicalOperationsPortalNativeBillingAuthorityCommand(Object.fromEntries(Object.entries(raw).reverse()))).toBe(canonical);
    expect(await sha256OperationsPortalNativeBillingAuthorityCommand(raw)).toMatch(/^[0-9a-f]{64}$/);
    raw.entity.nativeId="mutated";expect(parsed?.entity.nativeId).not.toBe("mutated");
  });

  it("allows only exact workspace organization and exact recipient client scopes",()=>{
    expect(parseOperationsPortalNativeBillingAuthorityCommand({...fixture("organization"),entity:{kind:"organization",nativeId:"other"}})).toBeNull();
    expect(parseOperationsPortalNativeBillingAuthorityCommand({...fixture("organization"),workspace:{...fixture().workspace,rootKind:"standalone_client"}})).toBeNull();
    expect(parseOperationsPortalNativeBillingAuthorityCommand({...fixture("client"),entity:{kind:"client",nativeId:"other"}})).toBeNull();
    const standalone=fixture("client");standalone.workspace.rootKind="standalone_client";standalone.workspace.rootRecordId="client-one";
    expect(parseOperationsPortalNativeBillingAuthorityCommand(standalone)?.entity.kind).toBe("client");
    // Project ownership is deliberately a consumer-side current-state proof.
    expect(parseOperationsPortalNativeBillingAuthorityCommand(fixture("project"))?.entity.nativeId).toBe("ops/project-one");
  });

  it("binds monotonic revision and fingerprints with explicit durable or future expiry",()=>{
    const revoke={...fixture(),action:"billing.revoke",authority:{grantId:id(2),expectedRevision:"1",resultingRevision:"2"},expiresAt:null};
    expect(parseOperationsPortalNativeBillingAuthorityCommand(revoke)?.action).toBe("billing.revoke");
    expect(parseOperationsPortalNativeBillingAuthorityCommand({...fixture(),expiresAt:null})?.expiresAt).toBeNull();
    expect(parseOperationsPortalNativeBillingAuthorityCommand({...fixture(),expiresAt:"2040-01-01T00:00:00.000Z"})?.expiresAt)
      .toBe("2040-01-01T00:00:00.000Z");
    for(const invalid of [
      {...fixture(),authority:{...fixture().authority,resultingRevision:"2"}},
      {...fixture(),recipient:{...fixture().recipient,requestFingerprint:"A".repeat(64)}},
      {...fixture(),publication:{...fixture().publication,requestFingerprint:"c".repeat(63)}},
      {...fixture(),expiresAt:"2029-12-31T23:59:59.999Z"},
      {...fixture(),expiresAt:"2030-01-02T00:00:00Z"},
      {...revoke,expiresAt:"2030-01-02T00:00:00.000Z"},
    ])expect(parseOperationsPortalNativeBillingAuthorityCommand(invalid)).toBeNull();
  });

  it.each([
    (x:ReturnType<typeof fixture>)=>({...x,protocol:"operations-portal-native-authority"}),
    (x:ReturnType<typeof fixture>)=>({...x,protocolVersion:3}),
    (x:ReturnType<typeof fixture>)=>({...x,entity:null}),
    (x:ReturnType<typeof fixture>)=>({...x,entity:{kind:"all",nativeId:"*"}}),
    (x:ReturnType<typeof fixture>)=>({...x,email:"not-authority@example.test"}),
    (x:ReturnType<typeof fixture>)=>({...x,recipient:{...x.recipient,name:"Not authority"}}),
    (x:ReturnType<typeof fixture>)=>({...x,actorProof:{...x.actorProof,verifiedUntil:x.observedAt}}),
    (x:ReturnType<typeof fixture>)=>({...x,entity:{...x.entity,nativeId:"bad\u0000id"}}),
  ])("rejects malformed or broadened command %#",change=>expect(parseOperationsPortalNativeBillingAuthorityCommand(change(fixture()))).toBeNull());

  it("does not invoke getters or proxies and enforces the serialized byte cap",()=>{
    let reads=0;const getter=fixture();Object.defineProperty(getter.entity,"nativeId",{enumerable:true,get(){reads++;throw Error("no")}});
    expect(parseOperationsPortalNativeBillingAuthorityCommand(getter)).toBeNull();expect(reads).toBe(0);
    expect(parseOperationsPortalNativeBillingAuthorityCommand(new Proxy({}, {ownKeys(){throw Error("no")}}))).toBeNull();
    const oversized=fixture("project");oversized.entity.nativeId="x".repeat(192);
    expect(parseOperationsPortalNativeBillingAuthorityCommand(oversized)).toBeNull();
  });
});
