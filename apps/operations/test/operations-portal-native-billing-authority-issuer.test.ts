import { describe,expect,it } from "vitest";
import { runCanonicalPortalResourceAcceptance,type CanonicalPortalAcceptanceContext } from "./helpers/operations-native-portal-resource-acceptance-fixture";
import { manageOperationsPortalNativeBillingPermission } from "../src/worker/operations-portal-native-billing-permission-issuer";
import { reviewOperationsPortalNativeBillingCandidate,grantOperationsPortalNativeBillingAuthority,
  revokeOperationsPortalNativeBillingAuthority,readOperationsPortalNativeBillingAuthorityStatus,
  type NativeBillingSelection } from "../src/worker/operations-portal-native-billing-authority-issuer";

async function prove(context: CanonicalPortalAcceptanceContext) {
  const {operations:db,owner,id,workspace,recipient,externalProject}=context;
  const recipientBindingId=recipient.recipientBindingId!;
  const selected: NativeBillingSelection={targetId:workspace.targetId,recipientBindingId,
    entity:{kind:"project",nativeId:externalProject},expiresAt:null};
  // Owner role/directory authority alone is deliberately insufficient.
  await expect(reviewOperationsPortalNativeBillingCandidate(db,owner,selected)).rejects.toThrow("native_billing_authority_denied");
  const permissionGrantId=id();
  expect((await manageOperationsPortalNativeBillingPermission(db,owner,{operationId:id(),expectedGeneration:0,
    action:"issue",grantId:permissionGrantId,staffId:owner.identity.staffId,effect:"allow",scope:{kind:"resource",resourceId:workspace.rootRecordId}})).status).toBe("applied");
  const review=await reviewOperationsPortalNativeBillingCandidate(db,owner,selected);
  expect(review.grantId).toBeNull();expect(review.expectedRevision).toBe(0);
  expect(Object.keys(review).sort()).toEqual(["targetId","recipientBindingId","entity","expiresAt","grantId","expectedRevision","reviewFingerprint"].sort());
  const input={...selected,operationId:id(),grantId:id(),expectedRevision:review.expectedRevision,reviewFingerprint:review.reviewFingerprint};
  // Inject a test-only last-stage abort: every earlier command/outbox/receipt/finalization must roll back.
  await db.prepare(`CREATE TRIGGER billing_test_late_abort BEFORE INSERT ON operations_portal_native_billing_authority_heads
    BEGIN SELECT RAISE(ABORT,'test late guard'); END`).run();
  expect((await grantOperationsPortalNativeBillingAuthority(db,owner,input)).status).toBe("conflict");
  for(const table of ["operations_portal_native_billing_authority_commands","operations_portal_native_billing_authority_outbox",
    "operations_portal_native_billing_authority_receipts","operations_portal_native_billing_grant_finalizations"])
    expect(await db.prepare(`SELECT 1 FROM ${table} WHERE operation_id=?`).bind(input.operationId).first()).toBeNull();
  expect(await db.prepare("SELECT 1 FROM operations_portal_native_billing_authority_heads WHERE grant_id=?").bind(input.grantId).first()).toBeNull();
  await db.prepare("DROP TRIGGER billing_test_late_abort").run();
  const applied=await grantOperationsPortalNativeBillingAuthority(db,owner,input);
  expect(applied.status).toBe("applied");
  expect(await readOperationsPortalNativeBillingAuthorityStatus(db,owner,input.grantId)).toMatchObject({state:"active",live:true,revision:1});
  // A distinct native manager is not implicitly authorized by identity/role.
  const secondStaffId="issuer-second-manager",secondSubject="access|issuer-second-manager";
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,'active')")
      .bind(secondStaffId,"issuer-second@example.test","Second billing manager",secondSubject),
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)")
      .bind(secondStaffId,secondSubject,owner.identity.staffId),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)")
      .bind(secondStaffId,"issuer-second@example.test","Second billing manager"),
  ]);
  const secondManager={identity:{kind:"native" as const,staffId:secondStaffId,verifiedAccessSubject:secondSubject,
    email:"issuer-second@example.test",displayName:"Second billing manager",profileVersion:1},
    admissionVersion:1,verifiedUntil:new Date(Date.now()+7_200_000).toISOString()};
  expect(await revokeOperationsPortalNativeBillingAuthority(db,secondManager,{operationId:id(),grantId:input.grantId,expectedRevision:1}))
    .toEqual({status:"conflict",reason:"authority"});
  expect((await manageOperationsPortalNativeBillingPermission(db,owner,{operationId:id(),expectedGeneration:0,action:"issue",
    grantId:id(),staffId:secondStaffId,effect:"allow",scope:{kind:"resource",resourceId:workspace.rootRecordId}})).status).toBe("applied");
  expect(await db.prepare("SELECT state FROM operations_portal_native_billing_authority_outbox WHERE operation_id=?").bind(input.operationId).first("state")).toBe("acknowledged");
  const freshActor={...owner,verifiedUntil:new Date(Date.now()+7_200_000).toISOString()};
  expect((await grantOperationsPortalNativeBillingAuthority(db,freshActor,input)).status).toBe("replayed");
  expect(await grantOperationsPortalNativeBillingAuthority(db,owner,{...input,expiresAt:new Date(Date.now()+60_000).toISOString()})).toEqual({status:"conflict",reason:"request"});
  expect(await grantOperationsPortalNativeBillingAuthority(db,owner,{...input,operationId:id()})).toEqual({status:"conflict",reason:"revision"});
  expect(await grantOperationsPortalNativeBillingAuthority(db,owner,{...input,unexpected:true} as typeof input)).toEqual({status:"conflict",reason:"request"});
  await db.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").bind(owner.identity.staffId).run();
  expect(await grantOperationsPortalNativeBillingAuthority(db,owner,input)).toEqual({status:"conflict",reason:"authority"});
  await db.prepare("UPDATE staff_users SET status='active' WHERE id=?").bind(owner.identity.staffId).run();
  await expect(reviewOperationsPortalNativeBillingCandidate(db,owner,{...selected,entity:{kind:"project",nativeId:"other/project"}})).rejects.toThrow();
  await expect(reviewOperationsPortalNativeBillingCandidate(db,owner,{...selected,expiresAt:"2000-01-01T00:00:00.000Z"})).rejects.toThrow();
  const expiringSelection: NativeBillingSelection={...selected,entity:{kind:"client",nativeId:context.clientRecord},
    expiresAt:new Date(Date.now()+3_000).toISOString()};
  const expiringReview=await reviewOperationsPortalNativeBillingCandidate(db,owner,expiringSelection);
  const expiring={...expiringSelection,operationId:id(),grantId:id(),expectedRevision:0,reviewFingerprint:expiringReview.reviewFingerprint};
  expect((await grantOperationsPortalNativeBillingAuthority(db,owner,expiring)).status).toBe("applied");
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(expiringSelection.expiresAt!)-Date.now()+100)));
  expect((await readOperationsPortalNativeBillingAuthorityStatus(db,owner,expiring.grantId)).live).toBe(false);
  expect(await grantOperationsPortalNativeBillingAuthority(db,owner,expiring)).toEqual({status:"conflict",reason:"authority"});
  expect((await revokeOperationsPortalNativeBillingAuthority(db,owner,{operationId:id(),grantId:expiring.grantId,expectedRevision:1})).status).toBe("applied");
  // Exact generation/deny state changes invalidate the reviewed candidate and live visibility.
  const denyId=id();
  expect((await manageOperationsPortalNativeBillingPermission(db,owner,{operationId:id(),expectedGeneration:1,action:"issue",
    grantId:denyId,staffId:owner.identity.staffId,effect:"deny",scope:{kind:"resource",resourceId:workspace.rootRecordId}})).status).toBe("applied");
  expect(await grantOperationsPortalNativeBillingAuthority(db,owner,input)).toEqual({status:"conflict",reason:"authority"});
  expect(await db.prepare("SELECT 1 FROM operations_portal_native_billing_live_authority WHERE grant_id=?").bind(input.grantId).first()).toBeNull();
  expect((await manageOperationsPortalNativeBillingPermission(db,owner,{operationId:id(),expectedGeneration:2,action:"revoke",grantId:denyId})).status).toBe("applied");
  // Grant refresh uses the same grant ID and advances the current head atomically.
  const refresh=await reviewOperationsPortalNativeBillingCandidate(db,owner,selected);
  expect(refresh.grantId).toBe(input.grantId);expect(refresh.expectedRevision).toBe(1);
  const refreshed={...input,operationId:id(),expectedRevision:refresh.expectedRevision,reviewFingerprint:refresh.reviewFingerprint};
  expect((await grantOperationsPortalNativeBillingAuthority(db,owner,refreshed)).status).toBe("applied");
  const reviewedAgain=await reviewOperationsPortalNativeBillingCandidate(db,owner,selected);
  expect(await grantOperationsPortalNativeBillingAuthority(db,owner,{...refreshed,operationId:id(),expectedRevision:2,
    reviewFingerprint:"0".repeat(64)})).toEqual({status:"conflict",reason:"review"});
  expect(reviewedAgain.expectedRevision).toBe(2);
  // Canonical ownership/publication drift removes read authority but must not block cleanup.
  await context.advanceProject();
  expect((await readOperationsPortalNativeBillingAuthorityStatus(db,owner,input.grantId)).live).toBe(false);
  const revoke={operationId:id(),grantId:input.grantId,expectedRevision:2};
  // B's own dedicated scoped permission authorizes cleanup of A's original
  // grant even after lineage drift; original granting identity is not required.
  expect((await revokeOperationsPortalNativeBillingAuthority(db,secondManager,revoke)).status).toBe("applied");
  expect((await revokeOperationsPortalNativeBillingAuthority(db,{...secondManager,
    verifiedUntil:new Date(Date.now()+10_800_000).toISOString()},revoke)).status).toBe("replayed");
  expect(await revokeOperationsPortalNativeBillingAuthority(db,secondManager,{...revoke,expectedRevision:1})).toEqual({status:"conflict",reason:"request"});
  expect(await readOperationsPortalNativeBillingAuthorityStatus(db,owner,input.grantId)).toMatchObject({state:"revoked",live:false,revision:3});
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
}
describe("local atomic native billing issuer",{timeout:300_000},()=>{
  it("proves grant/replay/late rollback/deny/expiry/stale-lineage revoke against the complete schema",async()=>{
    await runCanonicalPortalResourceAcceptance(prove,{stopAfterReady:true});
  });
});
