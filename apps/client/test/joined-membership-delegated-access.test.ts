import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import {
  acceptPortalWorkspaceInvitation,
  authorizePortalWorkspaceCapability,
} from "../src/worker/client-portal/workspace-v2";
import {
  changeWorkspacePeerAdministrator,
  createWorkspaceInvitation,
  suspendWorkspaceMember,
} from "../src/worker/client-portal/workspace-memberships";
import {
  authorizeClientDelegatedPublicShare,
  authorizeClientShareDelegation,
  revokeClientDelegatedShare,
  verifyAndRecordClientDelegatedShareSignerResult,
} from "../src/worker/client-portal/delegated-shares";
import {
  prepareProjectAccessTerms,
  projectAccessTermsSql,
  readProjectAccessTerms,
} from "../src/worker/client-portal/project-access-terms";
import { reconcileProjectAccessAuthorityExpiries } from "../src/worker/client-portal/project-access-authority-history";
import type { Env } from "../src/worker/types";
import type { ClientDelegatedShareSignerRequestV1 } from "@ltds/shared";

const issuer = "https://access.example.test";
const sourceId = "project-alpha:primary";
const workspaceId = "joined-access-workspace";
const rootId = "joined-access-root";
const projectOne = "joined-access-project-one";
const projectTwo = "joined-access-project-two";
const generationId = "joined-access-generation";
const managerId = "joined-access-manager";
const guestId = "joined-access-guest";
const recoveryId = "joined-access-recovery";
const projectedManagerId = "joined-pa-valid-manager";
const manager = { issuer, subject: "joined-manager", email: "manager@example.test" };
const guest = { issuer, subject: "joined-guest", email: "guest@example.test" };
const recovery = { issuer, subject: "joined-recovery", email: "recovery@example.test" };
const projectedManager = { issuer, subject: "joined-pa-valid-manager", email: "pa-valid@example.test" };

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

describe("joined membership, delegated access, expiry, and audit lifecycle", () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default {fetch(){return new Response('ok')}}",
      d1Databases: { DELIVERY_DB: "joined-membership-delegated-access" } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"));
      if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
    }
    env = {
      DELIVERY_DB: db,
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true",
      CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED: "true",
      CLIENT_PORTAL_PEER_ADMIN_ENABLED: "true",
      CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true",
      CLIENT_DELEGATED_SHARES_ENABLED: "true",
      PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED: "true",
      PUBLIC_SHARE_ORIGIN: "https://delivery.example.test",
    } as Env;

    await db.batch([
      db.prepare(`INSERT INTO portal_v2_workspaces
        (id,root_type,pa_organization_public_id,project_alpha_source_id,display_name,status)
        VALUES(?,'organization',?,?,?,'active')`).bind(workspaceId, rootId, sourceId, "Joined access org"),
      db.prepare(`INSERT INTO portal_v2_directory_generations
        (id,workspace_id,source_generation,source_sequence,status,complete)
        VALUES(?,?,?,1,'active',1)`).bind(generationId, workspaceId, generationId),
      db.prepare(`INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version)
        VALUES(?,?,3)`).bind(generationId, workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,display_name,source_version)
        VALUES(?,?,'organization',?,?,'root-v1')`).bind(workspaceId, generationId, rootId, "Joined access org"),
      ...[projectOne, projectTwo].map((project, index) => db.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version)
        VALUES(?,?,'project',?,?,?,?)`).bind(workspaceId, generationId, project, rootId, `Project ${index + 1}`, `project-v${index + 1}`)),
      ...[projectOne, projectTwo].map((project, index) => db.prepare(`INSERT INTO portal_v2_directory_relations
        (workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version)
        VALUES(?,?,?,'contains','organization',?,'project',?,?)`).bind(workspaceId, generationId, `edge-${index + 1}`, rootId, project, `edge-v${index + 1}`)),
      ...[projectOne, projectTwo].map((project, index) => db.prepare(`INSERT INTO portal_v2_project_lifecycle
        (workspace_id,generation_id,project_public_id,lifecycle_status,source_version)
        VALUES(?,?,?,'active',?)`).bind(workspaceId, generationId, project, `lifecycle-v${index + 1}`)),
      db.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence)
        VALUES(?,?,1)`).bind(workspaceId, generationId),
      db.prepare(`INSERT INTO pa_portal_projection_receipts
        (projection_source_id,delivery_id,workspace_id,delivery_kind,payload_hash,source_sequence,status)
        VALUES(?,?,?,'snapshot_activate',?,1,'completed')`).bind(sourceId, "joined-access-signed", workspaceId, "a".repeat(64)),
      ...[[managerId, manager], [recoveryId, recovery]].map(([id, principal]) => db.prepare(`INSERT INTO portal_v2_identities
        (id,issuer,subject,verified_email) VALUES(?,?,?,?)`).bind(id, (principal as typeof manager).issuer,
          (principal as typeof manager).subject, (principal as typeof manager).email)),
      ...[[managerId, "manager"], [recoveryId, "recovery"]].map(([id, suffix]) => db.prepare(`INSERT INTO portal_v2_workspace_memberships
        (id,workspace_id,identity_id,source_type,status) VALUES(?,?,?,'operations','active')`)
        .bind(`membership-${suffix}`, workspaceId, id)),
      ...[managerId, recoveryId].flatMap((id, identityIndex) => ["workspace.view"].map(capability => db.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
        VALUES(?,?,?,?,'allow','workspace',?,'operations','active')`)
        .bind(`entitlement-${identityIndex}-${capability}`, workspaceId, id, capability, workspaceId))),
      db.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
        VALUES('joined-manager-admin',?,?,'member.manage','allow','workspace',?,'operations','active')`)
        .bind(workspaceId, managerId, workspaceId),
      ...[projectOne, projectTwo].map((project, index) => db.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
        VALUES(?,?,?,'delivery.view','allow','project',?,'operations','active')`)
        .bind(`joined-manager-delivery-${index + 1}`, workspaceId, managerId, project)),
    ]);
  }, 90_000);

  afterAll(async () => runtime.dispose());

  it("keeps membership, bearer links, project deadlines, notices, and audit independently bounded", async () => {
    const invitation = await createWorkspaceInvitation(env, manager, workspaceId, {
      email: guest.email,
      projectPublicId: projectOne,
      capabilities: ["delivery.view"],
      accessTerms: { kind: "collaborator", mode: "project_end", expiresAt: null },
    }, "joined-access-invite-0001");
    expect(invitation.outcome).toBe("created");
    if (invitation.outcome !== "created") throw new Error("joined invitation was not created");
    const payload = await db.prepare("SELECT payload_json FROM portal_v2_invitation_email_outbox WHERE invitation_id=?")
      .bind(invitation.invitation.id).first<string>("payload_json");
    expect(await acceptPortalWorkspaceInvitation(env, guest, (JSON.parse(payload!) as { token: string }).token)).toBe("accepted");
    expect(await acceptPortalWorkspaceInvitation(env, guest, (JSON.parse(payload!) as { token: string }).token)).toBe("replayed");
    const acceptedGuestId = await db.prepare("SELECT id FROM portal_v2_identities WHERE issuer=? AND subject=?")
      .bind(issuer, guest.subject).first<string>("id");
    expect(acceptedGuestId).toBeTruthy();

    // A customer term on the sibling project is ordinary history and must not
    // be affected by collaborator completion on project one.
    const customerTerms = await prepareProjectAccessTerms(db, {
      sourceId, workspaceId, projectPublicId: projectTwo,
    }, { kind: "customer", mode: "until_revoked", expiresAt: null }, { type: "staff", id: "joined-operator" });
    await customerTerms.statement.run();
    await db.prepare(`INSERT INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,entitlement_version,source_type,status,access_terms_id)
      VALUES('joined-customer-project-two',?,?,'delivery.view','allow','project',?,1,'operations','active',?)`)
      .bind(workspaceId, acceptedGuestId, projectTwo, customerTerms.id).run();

    // Recover administration through a second eligible named member. A stale
    // concurrent promotion request cannot create another authority version.
    expect(await changeWorkspacePeerAdministrator(env, manager, workspaceId, recoveryId,
      { manager: true, expectedVersion: 0 }, "joined-manager-promote-0001"))
      .toEqual({ outcome: "created", manager: true, version: 1 });
    const concurrent = await Promise.all([
      changeWorkspacePeerAdministrator(env, manager, workspaceId, recoveryId,
        { manager: false, expectedVersion: 1 }, "joined-manager-demote-0001"),
      changeWorkspacePeerAdministrator(env, manager, workspaceId, recoveryId,
        { manager: false, expectedVersion: 1 }, "joined-manager-demote-0002"),
    ]);
    expect(concurrent.filter(result => result.outcome === "created")).toHaveLength(1);
    expect(concurrent.filter(result => result.outcome === "changed")).toHaveLength(1);
    expect(await changeWorkspacePeerAdministrator(env, manager, workspaceId, recoveryId,
      { manager: true, expectedVersion: 2 }, "joined-manager-recover-0001"))
      .toEqual({ outcome: "created", manager: true, version: 3 });

    const staleActor = { issuer, subject: "joined-stale-principal", email: "stale@example.test" };
    await db.batch([
      db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email)
        VALUES('joined-stale-actor',?,?,?)`).bind(issuer, staleActor.subject, staleActor.email),
      db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email)
        VALUES('joined-denied-target',?,'joined-denied-target','denied-target@example.test')`).bind(issuer),
      db.prepare(`INSERT INTO portal_v2_workspace_memberships
        (id,workspace_id,identity_id,source_type,source_version,status)
        VALUES('joined-stale-membership',?,'joined-stale-actor','project_alpha','principal-v2','active')`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_workspace_memberships
        (id,workspace_id,identity_id,source_type,status)
        VALUES('joined-denied-target-membership',?,'joined-denied-target','operations','active')`).bind(workspaceId),
      db.prepare(`INSERT INTO pa_portal_principals
        (workspace_id,public_id,identity_id,email_hint,display_name,status,source_version)
        VALUES(?,'joined-stale-principal','joined-stale-actor',?,?,'active','principal-v1')`)
        .bind(workspaceId, staleActor.email, "Stale principal"),
      ...["workspace.view", "member.manage"].map(capability => db.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,source_version,status)
        VALUES(?,?,?,?,'allow','workspace',?,'project_alpha','principal-v2','active')`)
        .bind(`joined-stale-${capability}`, workspaceId, "joined-stale-actor", capability, workspaceId)),
      db.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
        VALUES('joined-denied-target-view',?,'joined-denied-target','workspace.view','allow','workspace',?,'operations','active')`)
        .bind(workspaceId, workspaceId),
    ]);
    expect(await changeWorkspacePeerAdministrator(env, staleActor, workspaceId, "joined-denied-target",
      { manager: true, expectedVersion: 0 }, "joined-stale-principal-denied"))
      .toEqual({ outcome: "denied" });
    expect(await db.prepare(`SELECT count(*) FROM portal_workspace_peer_admin_commands
      WHERE idempotency_key='joined-stale-principal-denied'`).first<number>("count(*)")).toBe(0);

    // Ordinary active peers do not enter the bounded replacement-manager
    // authority scan. This exceeds its fail-closed candidate ceiling while a
    // single plausible, exactly authorized recovery manager remains usable.
    await db.prepare(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<201)
      INSERT INTO portal_v2_identities(id,issuer,subject,verified_email)
      SELECT 'joined-viewer-'||printf('%03d',n),?,'joined-viewer-'||printf('%03d',n),
        'joined-viewer-'||printf('%03d',n)||'@example.test' FROM sequence`).bind(issuer).run();
    await db.prepare(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<201)
      INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status)
      SELECT 'joined-viewer-membership-'||printf('%03d',n),?,'joined-viewer-'||printf('%03d',n),'operations','active'
      FROM sequence`).bind(workspaceId).run();

    expect(await changeWorkspacePeerAdministrator(env, manager, workspaceId, managerId,
      { manager: false, expectedVersion: 1 }, "joined-manager-transfer-0001"))
      .toEqual({ outcome: "created", manager: false, version: 2 });
    expect(await changeWorkspacePeerAdministrator(env, recovery, workspaceId, recoveryId,
      { manager: false, expectedVersion: 3 }, "joined-last-manager-denial"))
      .toEqual({ outcome: "last_manager" });

    expect(await changeWorkspacePeerAdministrator(env, recovery, workspaceId, managerId,
      { manager: true, expectedVersion: 2 }, "joined-manager-restore-0001"))
      .toEqual({ outcome: "created", manager: true, version: 3 });
    await db.prepare(`UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now')
      WHERE workspace_id=? AND identity_id=? AND capability='member.manage' AND source_type='operations'
        AND status='active' AND revoked_at IS NULL`).bind(workspaceId, recoveryId).run();

    // PA-projected managers are valid replacements when membership, principal,
    // and entitlement source versions agree. The stale projection is a
    // plausible candidate but must fail the exact authority recheck.
    const staleProjectedManager = { issuer, subject: "joined-pa-stale-manager", email: "pa-stale@example.test" };
    await db.batch([
      db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES('joined-pa-stale-manager',?,?,?)`)
        .bind(staleProjectedManager.issuer, staleProjectedManager.subject, staleProjectedManager.email),
      db.prepare(`INSERT INTO portal_v2_workspace_memberships
        (id,workspace_id,identity_id,source_type,source_version,status)
        VALUES('joined-pa-stale-membership',?,'joined-pa-stale-manager','project_alpha','pa-stale-v2','active')`)
        .bind(workspaceId),
      db.prepare(`INSERT INTO pa_portal_principals
        (workspace_id,public_id,identity_id,email_hint,display_name,status,source_version)
        VALUES(?,'joined-pa-stale','joined-pa-stale-manager',?,?,'active','pa-stale-v1')`)
        .bind(workspaceId, staleProjectedManager.email, "Stale PA manager"),
      ...["workspace.view", "member.manage"].map(capability => db.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,source_version,status)
        VALUES(?,?,'joined-pa-stale-manager',?,'allow','workspace',?,'project_alpha','pa-stale-v2','active')`)
        .bind(`joined-pa-stale-${capability}`, workspaceId, capability, workspaceId)),
    ]);
    expect(await changeWorkspacePeerAdministrator(env, manager, workspaceId, managerId,
      { manager: false, expectedVersion: 3 }, "joined-stale-pa-replacement-denied"))
      .toEqual({ outcome: "last_manager" });
    expect(await db.prepare(`SELECT count(*) FROM portal_workspace_peer_admin_commands
      WHERE idempotency_key='joined-stale-pa-replacement-denied'`).first<number>("count(*)")).toBe(0);

    await db.batch([
      db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES(?,?,?,?)`)
        .bind(projectedManagerId, projectedManager.issuer, projectedManager.subject, projectedManager.email),
      db.prepare(`INSERT INTO portal_v2_workspace_memberships
        (id,workspace_id,identity_id,source_type,source_version,status)
        VALUES('joined-pa-valid-membership',?,?,'project_alpha','pa-valid-v1','active')`).bind(workspaceId, projectedManagerId),
      db.prepare(`INSERT INTO pa_portal_principals
        (workspace_id,public_id,identity_id,email_hint,display_name,status,source_version)
        VALUES(?,'joined-pa-valid',?,?,?,'active','pa-valid-v1')`)
        .bind(workspaceId, projectedManagerId, projectedManager.email, "Valid PA manager"),
      ...["workspace.view", "member.manage"].map(capability => db.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,source_version,status)
        VALUES(?,?,?,?,'allow','workspace',?,'project_alpha','pa-valid-v1','active')`)
        .bind(`joined-pa-valid-${capability}`, workspaceId, projectedManagerId, capability, workspaceId)),
    ]);
    expect(await changeWorkspacePeerAdministrator(env, manager, workspaceId, managerId,
      { manager: false, expectedVersion: 3 }, "joined-valid-pa-replacement"))
      .toEqual({ outcome: "created", manager: false, version: 4 });

    // Give the guest a bounded delegated-share policy. The signer row is
    // deliberately inserted as the private Operations signer would do, then
    // verified by the Client boundary before the creation event is recorded.
    const bindingId = "joined-folder-binding";
    const targetId = "joined-folder-target";
    const delegationId = "joined-share-delegation";
    const shareId = "joined-client-share";
    const publicId = "joinedpublicshare00001";
    const receiptId = "joined-signer-receipt";
    const bearerSecret = "b".repeat(43);
    const shareExpiresAt = new Date(Date.now() + 86_400_000).toISOString();
    await db.batch([
      db.prepare(`INSERT INTO portal_v2_folder_bindings
        (id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version,status)
        VALUES(?,?,'project',?,'joined/private/','operations','binding-v1','active')`)
        .bind(bindingId, workspaceId, projectOne),
      db.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,entitlement_version,source_type,status)
        VALUES('joined-share-create',?,?,'delegated_share.create','allow','folder',?,1,'operations','active')`)
        .bind(workspaceId, acceptedGuestId, bindingId),
      db.prepare(`INSERT INTO client_share_folder_targets
        (id,workspace_id,folder_binding_id,binding_source_version,relative_prefix,created_by_staff_id,status)
        VALUES(?,?,?,'binding-v1','deliverables/','joined-operator','active')`).bind(targetId, workspaceId, bindingId),
      db.prepare(`INSERT INTO client_share_delegations
        (id,workspace_id,identity_id,entitlement_id,entitlement_version,folder_binding_id,
         folder_binding_source_version,root_target_id,allow_exact_root,expires_at,created_by_staff_id,status)
        VALUES(?,?,?,'joined-share-create',1,?,'binding-v1',?,1,?,'joined-operator','active')`)
        .bind(delegationId, workspaceId, acceptedGuestId, bindingId, targetId, shareExpiresAt),
      db.prepare(`INSERT INTO client_delegated_shares
        (id,public_id,workspace_id,delegation_id,created_by_identity_id,folder_target_id,token_hash,
         share_version,label,expires_at,status,signer_receipt_id,idempotency_key,request_fingerprint)
        VALUES(?,?,?,?,?,?,?,1,'Joined delivery',?,'active',?,'joined-share-create-key',?)`)
        .bind(shareId, publicId, workspaceId, delegationId, acceptedGuestId, targetId,
          await sha256(bearerSecret), shareExpiresAt, receiptId, "c".repeat(43)),
    ]);
    const delegated = await authorizeClientShareDelegation(env, guest, workspaceId, delegationId, targetId);
    expect(delegated).not.toBeNull();
    const request: ClientDelegatedShareSignerRequestV1 = { protocolVersion: 1, workspaceId, delegationId,
      createdByIdentityId: acceptedGuestId!, folderTargetId: targetId,
      entitlementId: "joined-share-create", folderBindingId: bindingId,
      expectedDelegationVersion: 1, expectedEntitlementVersion: 1,
      expectedBindingSourceVersion: "binding-v1", label: "Joined delivery",
      expiresAt: shareExpiresAt, idempotencyKey: "joined-share-create-key" };
    const signerResult = { ok: true as const, protocolVersion: 1 as const, receiptId, replayed: false,
      share: { id: shareId, publicId, path: `/client-share/${publicId}`,
        shareUrl: `https://delivery.example.test/client-share/${publicId}#${bearerSecret}`,
        label: "Joined delivery", status: "active" as const, passwordProtected: false,
        expiresAt: shareExpiresAt, createdAt: new Date().toISOString() } };
    expect(await verifyAndRecordClientDelegatedShareSignerResult(env, delegated!, request, signerResult)).not.toBeNull();
    expect(await authorizeClientDelegatedPublicShare(env, publicId, 1)).not.toBeNull();
    expect(await revokeClientDelegatedShare(env, guest, workspaceId, shareId, "joined-share-revoke-0001")).toBe("revoked");
    expect(await revokeClientDelegatedShare(env, guest, workspaceId, shareId, "joined-share-revoke-0001")).toBe("replayed");
    expect(await authorizeClientDelegatedPublicShare(env, publicId, 2)).toBeNull();
    expect(await authorizePortalWorkspaceCapability(env, guest, workspaceId, "delivery.view",
      { scopeType: "project", publicId: projectOne })).toBe(true);

    // Completion latches once. Reopening neither renews the expired project nor
    // affects the sibling customer history or shared workspace membership.
    await db.prepare(`UPDATE portal_v2_project_lifecycle SET lifecycle_status='completed',
      completed_at=datetime('now'),source_version='completed-v1'
      WHERE workspace_id=? AND project_public_id=?`).bind(workspaceId, projectOne).run();
    const collaboratorTerms = await readProjectAccessTerms(db, invitation.invitation.accessTerms!.id);
    expect(collaboratorTerms?.completionPending).toBe(false);
    expect(collaboratorTerms?.effectiveExpiresAt).toBeTruthy();
    expect(await authorizePortalWorkspaceCapability(env, guest, workspaceId, "delivery.view",
      { scopeType: "project", publicId: projectOne })).toBe(true);
    expect(await authorizePortalWorkspaceCapability(env, guest, workspaceId, "delivery.view",
      { scopeType: "project", publicId: projectTwo })).toBe(true);
    const afterDeadline = Date.parse(collaboratorTerms!.effectiveExpiresAt!) + 1_000;
    expect(await reconcileProjectAccessAuthorityExpiries(db.withSession("first-primary"), afterDeadline, 100, true)).toBeGreaterThan(0);
    expect(await reconcileProjectAccessAuthorityExpiries(db.withSession("first-primary"), afterDeadline, 100, true)).toBe(0);
    expect(await db.prepare(`SELECT count(*) FROM portal_project_access_authority_events
      WHERE workspace_id=? AND project_public_id=? AND event_kind='access_expired'`)
      .bind(workspaceId, projectOne).first<number>("count(*)")).toBeGreaterThan(0);
    await db.prepare(`UPDATE portal_v2_project_lifecycle SET lifecycle_status='active',completed_at=NULL,
      source_version='reopened-v1' WHERE workspace_id=? AND project_public_id=?`).bind(workspaceId, projectOne).run();
    expect((await readProjectAccessTerms(db, invitation.invitation.accessTerms!.id))?.effectiveExpiresAt)
      .toBe(collaboratorTerms!.effectiveExpiresAt);
    expect(await db.prepare(`SELECT ${projectAccessTermsSql({termsId:'?1',workspaceId:'?2',projectId:'?3',legacyRetained:'0',now:'?4'})} allowed`)
      .bind(invitation.invitation.accessTerms!.id,workspaceId,projectOne,new Date(afterDeadline).toISOString())
      .first<number>('allowed')).toBe(0);
    expect(await db.prepare(`SELECT status FROM portal_v2_workspace_memberships
      WHERE workspace_id=? AND identity_id=?`).bind(workspaceId, acceptedGuestId).first("status")).toBe("active");

    // Stage the three durable notice/audit records that an enabled scheduler
    // emits across its reviewed windows; their immutable scope is inspected
    // together with membership and delegated-share audit provenance.
    for (const [index, eventType] of ["warning_7d", "warning_24h", "expired"].entries()) {
      const outboxId = `${index + 1}`.repeat(64);
      const auditId = `${index + 4}`.repeat(64);
      await db.batch([
        db.prepare(`INSERT INTO portal_project_access_notice_outbox
          (id,access_terms_id,workspace_id,source_id,project_public_id,identity_id,event_type,
           effective_expires_at,message_id_key,status)
          VALUES(?,?,?,?,?,?,?,?,?,'pending')`).bind(outboxId, invitation.invitation.accessTerms!.id,
            workspaceId, sourceId, projectOne, acceptedGuestId, eventType,
            collaboratorTerms!.effectiveExpiresAt, `joined-notice-${eventType}`),
        db.prepare(`INSERT INTO portal_project_access_notice_audit
          (id,outbox_id,workspace_id,project_public_id,identity_id,event_type,action,attempt_count)
          VALUES(?,?,?,?,?,?,'notice.staged',0)`).bind(auditId, outboxId, workspaceId,
            projectOne, acceptedGuestId, eventType),
      ]);
    }
    const audit = {
      membership: await db.prepare("SELECT action FROM portal_v2_membership_audit WHERE workspace_id=? ORDER BY created_at,id")
        .bind(workspaceId).all<{ action: string }>(),
      delegated: await db.prepare("SELECT event_type FROM client_delegated_share_events WHERE workspace_id=? ORDER BY created_at,id")
        .bind(workspaceId).all<{ event_type: string }>(),
      notices: await db.prepare("SELECT event_type,action FROM portal_project_access_notice_audit WHERE workspace_id=? ORDER BY event_type")
        .bind(workspaceId).all<{ event_type: string; action: string }>(),
    };
    expect(audit.membership.results.map(row => row.action)).toContain("invitation.accepted");
    expect(audit.delegated.results.map(row => row.event_type)).toEqual([
      "client_share.created", "client_share.revoked",
    ]);
    expect(audit.notices.results).toEqual([
      { event_type: "expired", action: "notice.staged" },
      { event_type: "warning_24h", action: "notice.staged" },
      { event_type: "warning_7d", action: "notice.staged" },
    ]);
    await expect(db.prepare("UPDATE portal_project_access_notice_audit SET action='notice.sent' WHERE id=?")
      .bind("4".repeat(64)).run()).rejects.toThrow(/immutable/);

    // Membership suspension is a separate authority action: it does not
    // rewrite the already revoked bearer or the sibling workspace/project.
    expect(await suspendWorkspaceMember(env, projectedManager, workspaceId, acceptedGuestId!)).toBe("suspended");
    expect(await db.prepare("SELECT status FROM client_delegated_shares WHERE id=?").bind(shareId).first("status")).toBe("revoked");
    expect(await db.prepare("SELECT count(*) FROM portal_project_access_terms WHERE workspace_id=? AND project_public_id=?")
      .bind(workspaceId, projectTwo).first<number>("count(*)")).toBe(1);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  }, 90_000);
});
