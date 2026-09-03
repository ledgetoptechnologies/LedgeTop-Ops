import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { provisionPortalSourceAuthority, setPortalSourceAuthorityState } from "../../client/src/worker/project-alpha-portal-authority";
import {
  authorizeAuthenticatedDeliveryGrant,
  listAuthorizedAuthenticatedDeliveryPrefixes,
  readNativeAuthenticatedDeliveryGrants,
} from "../../client/src/worker/client-portal/authenticated-delivery-grants";
import { resolveNativePortalWorkspaceReadContext } from "../../client/src/worker/client-portal/workspace-v2";
import {
  createAuthenticatedDeliveryGrant,
  previewAuthenticatedDeliveryGrant,
  revokeAuthenticatedDeliveryGrant,
} from "../src/worker/authenticated-delivery-grants";
import {
  authorizeAuthenticatedDeliveryChangeBatch,
  controlAuthenticatedDeliveryChangeBatch,
  recordAuthenticatedDeliveryObjectChange,
  saveAuthenticatedDeliveryNotificationPolicy,
} from "../src/worker/authenticated-delivery-change-notifications";
import { encodeRef } from "../src/worker/delivery";
import {
  createNativeDeliveryGrant,
  previewNativeDeliveryGrant,
  revokeNativeDeliveryGrant,
} from "../src/worker/native-delivery-bindings";
import {
  createPrimaryWorkspaceBinding,
  searchPrimaryWorkspaceBindingTargets,
  suspendPrimaryWorkspaceBindingsForFolderReassignment,
} from "../src/worker/primary-delivery-workspace-bindings";
import {
  registerProjectAlphaConnector,
  setProjectAlphaConnectorState,
  type ProjectAlphaConnectorEnvironment,
} from "../src/worker/project-alpha-connectors";
import type { Env, StaffPrincipal } from "../src/worker/types";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));

const PRIMARY = "project-alpha:primary";
const SECONDARY = "project-alpha:j5-secondary";
const ISSUER = "https://access.example.test";
const staff: StaffPrincipal = {
  id: "j5-staff",
  email: "staff@example.test",
  displayName: "J5 operator",
  accessSubject: "j5-staff-subject",
  projectAlphaUserId: null,
};
const publicId = (value: number) => value.toString(16).padStart(32, "0");
const publicKey = (value: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(value)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let runtime: Miniflare;
let ops: D1Database;
let delivery: D1Database;
let env: Env;

async function migrate(database: D1Database, directory: URL): Promise<void> {
  for (const name of readdirSync(directory).filter(value => /^\d{4}_.*\.sql$/.test(value)).sort()) {
    const statements = splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"));
    await database.batch(statements.map(sql => database.prepare(sql)));
  }
}

function failReceiptBatch(database: D1Database): D1Database {
  const sql = new WeakMap<object, string>();
  let proxy: D1Database;
  const wrap = (statement: D1PreparedStatement, text: string): D1PreparedStatement => {
    const value = new Proxy(statement, { get(target, key) {
      if (key === "bind") return (...bindings: unknown[]) => wrap(target.bind(...bindings), text);
      const member = target[key as keyof D1PreparedStatement];
      return typeof member === "function" ? member.bind(target) : member;
    } });
    sql.set(value, text);
    return value;
  };
  proxy = new Proxy(database, { get(target, key) {
    if (key === "withSession") return () => proxy;
    if (key === "prepare") return (text: string) => wrap(target.prepare(text), text);
    if (key === "batch") return async (statements: D1PreparedStatement[]) => {
      if (statements.some(statement => (sql.get(statement) ?? "").includes("INSERT INTO portal_primary_staff_bindings")))
        throw new Error("simulated-receipt-write-loss");
      return target.batch(statements);
    };
    const member = target[key as keyof D1Database];
    return typeof member === "function" ? member.bind(target) : member;
  } });
  return proxy;
}

describe("J5 joined native delivery and notifications", { timeout: 90_000, concurrent: false }, () => {
  beforeAll(async () => {
    runtime = new Miniflare({
      modules: true,
      compatibilityDate: "2026-07-22",
      script: "export default {fetch(){return new Response('j5')}}",
      d1Databases: ["OPS_DB", "DELIVERY_DB"],
    });
    ops = await runtime.getD1Database("OPS_DB") as D1Database;
    delivery = await runtime.getD1Database("DELIVERY_DB") as D1Database;
    await migrate(ops, new URL("../migrations/", import.meta.url));
    await migrate(delivery, new URL("../../client/migrations/", import.meta.url));

    const primaryCredential = {
      snapshotApiKey: "primary-snapshot-key",
      eventCurrent: { keyId: "primary-key", algorithm: "ed25519", value: publicKey(1) },
    };
    const secondaryCredential = {
      snapshotApiKey: "secondary-snapshot-key",
      eventCurrent: { keyId: "secondary-key", algorithm: "ed25519", value: publicKey(2) },
      portalCurrent: { keyId: "secondary-portal-key", value: "secondary-portal-secret-at-least-thirty-two-bytes" },
    };
    const configured: Partial<Env> & ProjectAlphaConnectorEnvironment = {
      OPS_DB: ops,
      DELIVERY_DB: delivery,
      PROJECT_ALPHA_BASE_URL: "https://primary.example.test/",
      PROJECT_ALPHA_API_KEY: primaryCredential.snapshotApiKey,
      APPLICATION_KEY: "ltds_ops",
      PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY: publicKey(1),
      PROJECT_ALPHA_CONNECTOR_CREDENTIALS: JSON.stringify({ version: 1, sets: { primary: primaryCredential, secondary: secondaryCredential } }),
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true",
      AUTHENTICATED_DELIVERY_GRANTS_ENABLED: "true",
      AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED: "true",
      CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true",
      PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED: "true",
      DELIVERY_BASE_URL: "https://portal.example.test",
      PUBLIC_BASE_URL: "https://operations.example.test",
      OPERATIONS_SESSION_SECRET: "fixture-session-secret-at-least-32-bytes",
    };
    env = configured as Env;

    const revision = (credentialRef: string) => ({
      credentialRef,
      snapshotBasePath: "/",
      accessIssuer: ISSUER,
      accessAudience: "audience",
      accessSubject: "subject",
    });
    await registerProjectAlphaConnector(env, {
      sourceId: PRIMARY,
      producerBindingId: "primary-producer",
      snapshotOrigin: "https://primary.example.test",
      applicationKey: "ltds_ops",
      profile: "primary_legacy",
      displayName: "Primary",
      revision: revision("primary"),
    }, staff.id);
    await setProjectAlphaConnectorState(env, PRIMARY, { expectedVersion: 1, state: "active" }, staff.id);
    await registerProjectAlphaConnector(env, {
      sourceId: SECONDARY,
      producerBindingId: "secondary-producer",
      snapshotOrigin: "https://secondary.example.test",
      applicationKey: "ltds_ops",
      profile: "business_data",
      displayName: "Secondary",
      revision: revision("secondary"),
    }, staff.id);
    await setProjectAlphaConnectorState(env, SECONDARY, { expectedVersion: 1, state: "active", readVisible: true }, staff.id);
    const connector = {
      sourceId: SECONDARY,
      producerBindingId: "secondary-producer",
      snapshotOrigin: "https://secondary.example.test",
      snapshotBasePath: "/",
      applicationKey: "ltds_ops",
      profile: "business_data" as const,
      revision: 1,
      version: 2,
      state: "active" as const,
    };
    const authority = await provisionPortalSourceAuthority(env, connector, {
      credentialRef: "secondary",
      accessIssuer: ISSUER,
      accessAudience: "audience",
      accessSubject: "subject",
    }, null, staff.id);
    await setPortalSourceAuthorityState(env, connector, authority.version, "active", staff.id);

    await ops.batch([
      ops.prepare("INSERT INTO pa_connector_portal_sources(source_id,created_by) VALUES(?,?)").bind(SECONDARY, staff.id),
      ops.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,'active')")
        .bind(staff.id, staff.email, staff.displayName, staff.accessSubject),
      ops.prepare("INSERT INTO divisions(id,name,code,active) VALUES('j5-division','J5 division','J5',1)"),
      ops.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES('j5-admin',?,'role-admin','global','global')")
        .bind(staff.id),
      ops.prepare("INSERT INTO pa_projects(id,name,payload_json,last_sync_id,active) VALUES('secondary-folder-owner','Secondary storage','{}','j5',1)"),
      ops.prepare("INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by) VALUES('secondary-folder-owner','j5-division','J5/Secondary/','manual',?)")
        .bind(staff.id),
    ]);
    for (const permission of ["projects.view", "delivery.browse", "delivery.share.create", "delivery.share.revoke", "delivery.share.audit"])
      await ops.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by)
        VALUES(?,?,?,'allow','global','global',?)`).bind(`j5-${permission}`, staff.id, permission, staff.id).run();
  }, 90_000);

  afterAll(async () => runtime?.dispose());

  it("joins exact primary and secondary grants, portal reads, batching, controls, fail-closed fences, and public-link independence", async () => {
    const rootPublic = publicId(5001), projectPublic = publicId(5002);
    // The primary connector deliberately keeps its local key equal to the
    // authoritative public ID; secondary connectors retain explicit mappings.
    const rootLocal = rootPublic, projectLocal = projectPublic;
    const workspace = "j5-primary-workspace", generation = "j5-primary-generation";
    const folder = "J5/Primary/Project/Deliverables/";
    const sharedEmail = "same-recipient@example.test";

    await ops.batch([
      ops.prepare("INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id) VALUES(?,'organization',?,?)")
        .bind(PRIMARY, rootPublic, rootLocal),
      ops.prepare("INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id) VALUES(?,'project',?,?)")
        .bind(PRIMARY, projectPublic, projectLocal),
      ops.prepare("INSERT INTO pa_organizations(id,name,active,payload_json,last_sync_id,projection_source_id) VALUES(?,? ,1,?,'j5',?)")
        .bind(rootLocal, "J5 Primary", JSON.stringify({ public_id: rootPublic }), PRIMARY),
      ops.prepare(`INSERT INTO pa_projects(id,organization_id,name,active,payload_json,last_sync_id,projection_source_id)
        VALUES(?,?,?,1,?,'j5',?)`).bind(projectLocal, rootLocal, "J5 Project", JSON.stringify({ public_id: projectPublic }), PRIMARY),
      ops.prepare("INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by) VALUES(?,'j5-division','J5/Primary/Project/','manual',?)")
        .bind(projectLocal, staff.id),
    ]);
    await delivery.batch([
      delivery.prepare("INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id) VALUES(?,?,?)")
        .bind(workspace, PRIMARY, "j5-primary-external"),
      delivery.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id)
        VALUES(?,'organization',?,'J5 Primary Workspace','active',?)`).bind(workspace, rootPublic, PRIMARY),
      delivery.prepare(`INSERT INTO pa_portal_projection_generations
        (id,workspace_id,source_generation,source_sequence,snapshot_hash,page_count,record_count,workspace_root_type,
         workspace_root_public_id,workspace_display_name,workspace_source_version,workspace_active,status,complete,projection_source_id)
        VALUES(?,?,'j5-source-generation',1,?,1,4,'organization',?,'J5 Primary Workspace','workspace-v1',1,'active',1,?)`)
        .bind("j5-primary-snapshot", workspace, "a".repeat(64), rootPublic, PRIMARY),
      delivery.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete)
        VALUES(?,?,'j5-source-generation',1,'active',1)`).bind(generation, workspace),
      delivery.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active)
        VALUES(?,?,'organization',?,NULL,'J5 Primary','root-v1',1)`).bind(workspace, generation, rootPublic),
      delivery.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active)
        VALUES(?,?,'project',?,?,'J5 Project','project-v1',1)`).bind(workspace, generation, projectPublic, rootPublic),
      delivery.prepare("INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version) VALUES(?,?,3)")
        .bind(generation, workspace),
      delivery.prepare(`INSERT INTO portal_v2_directory_relations
        (workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version,active)
        VALUES(?,?,'j5-primary-project-parent','contains','organization',?,'project',?,'relation-v1',1)`)
        .bind(workspace, generation, rootPublic, projectPublic),
      delivery.prepare("INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)")
        .bind(workspace, generation),
      delivery.prepare(`INSERT INTO pa_portal_projection_checkpoints(workspace_id,source_generation,source_sequence,snapshot_generation_id)
        VALUES(?,'j5-source-generation',1,'j5-primary-snapshot')`).bind(workspace),
      delivery.prepare(`INSERT INTO pa_portal_projection_receipts
        (projection_source_id,delivery_id,workspace_id,delivery_kind,payload_hash,source_sequence,status)
        VALUES(?,'j5-primary-signed',?,'snapshot_activate',?,1,'completed')`).bind(PRIMARY, workspace, "b".repeat(64)),
      delivery.prepare("INSERT INTO portal_v2_project_lifecycle(workspace_id,generation_id,project_public_id,lifecycle_status,source_version) VALUES(?,?,?,'active','lifecycle-v1')")
        .bind(workspace, generation, projectPublic),
      delivery.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES('j5-person-a',?,'j5-subject-a',?,'active'),('j5-person-b',?,'j5-subject-b',?,'active')")
        .bind(ISSUER, sharedEmail, ISSUER, sharedEmail),
      delivery.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,source_version,status)
        VALUES('j5-member-a',?,'j5-person-a','project_alpha','person-a-v1','active'),
          ('j5-member-b',?,'j5-person-b','project_alpha','person-b-v1','active')`).bind(workspace, workspace),
      delivery.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status)
        VALUES(?,'j5-principal-a','j5-person-a',?,'Same Email Person','person-a-v1','active'),
          (?,'j5-principal-b','j5-person-b',?,'Same Email Group Member','person-b-v1','active')`)
        .bind(workspace, sharedEmail, workspace, sharedEmail),
      ...["j5-person-a", "j5-person-b"].flatMap((identity, index) => ["workspace.view", "directory.read", "delivery.view"].map(capability =>
        delivery.prepare(`INSERT INTO portal_v2_entitlements
          (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,source_version,status)
          VALUES(?,?,?,?,'allow',?,?, 'project_alpha',?,'active')`)
          .bind(`j5-${identity}-${capability}`, workspace, identity, capability,
            capability === "delivery.view" ? "project" : "workspace",
            capability === "delivery.view" ? projectPublic : workspace, `allow-${index}-v1`))),
      delivery.prepare("INSERT INTO projects(id,client_name,project_name,r2_prefix) VALUES('j5-public-project','Public client','Public project','J5/Public/')"),
      delivery.prepare("INSERT INTO shares(id,project_id,token_hash,label,created_by_type,created_by_id) VALUES('j5-public-share','j5-public-project','j5-public-hash','Canonical link','staff',?)")
        .bind(staff.id),
    ]);
    const publicShareBefore = await delivery.prepare("SELECT * FROM shares WHERE id='j5-public-share'").first();

    const targets = await searchPrimaryWorkspaceBindingTargets(env, staff, folder, "J5 Primary");
    expect(targets.targets).toHaveLength(1);
    expect(targets.targets[0]).toMatchObject({ workspaceId: workspace, ownerScopeType: "project", ownerPublicId: projectPublic });
    const bindingResult = await createPrimaryWorkspaceBinding(env, staff, folder, {
      folderRef: encodeRef(folder.slice(0, -1)),
      workspaceId: workspace,
      reasonCode: "joined_j5_link",
      expectedContextVersion: targets.targets[0]!.contextVersion,
    }, "joined-j5-binding-create");
    expect(bindingResult.binding).toMatchObject({ state: "active", workspaceId: workspace });
    const bindingId = bindingResult.binding!.bindingId;
    expect(await delivery.prepare("SELECT count(*) n FROM portal_v2_authenticated_delivery_grants").first<number>("n")).toBe(0);

    const operation = {
      folderBindingId: bindingId,
      audienceType: "principal" as const,
      audiencePublicId: "j5-principal-a",
      reasonCode: "joined_j5_delivery",
      expiresAt: null,
    };
    const preview = await previewAuthenticatedDeliveryGrant(env, staff, operation);
    expect(preview).toMatchObject({ workspaceId: workspace, audienceLabel: "Same Email Person", recipientCount: 1 });
    const created = await createAuthenticatedDeliveryGrant(env, staff, {
      ...operation,
      expectedContextVersion: preview.contextVersion,
    }, "joined-j5-grant-create");
    expect(created.grant).toMatchObject({ status: "active", recipientCount: 1 });
    expect((await delivery.prepare("SELECT identity_id FROM portal_v2_authenticated_delivery_grant_recipients WHERE grant_id=?")
      .bind(created.grant.id).all<{ identity_id: string }>()).results).toEqual([{ identity_id: "j5-person-a" }]);

    const clientA = { issuer: ISSUER, subject: "j5-subject-a", email: sharedEmail };
    const clientB = { issuer: ISSUER, subject: "j5-subject-b", email: sharedEmail };
    expect(await authorizeAuthenticatedDeliveryGrant(env, clientA, workspace, bindingId)).toBe(true);
    expect(await authorizeAuthenticatedDeliveryGrant(env, clientB, workspace, bindingId)).toBe(false);
    expect(await listAuthorizedAuthenticatedDeliveryPrefixes(env, clientA, workspace)).toContain(folder);

    await saveAuthenticatedDeliveryNotificationPolicy(env, staff.id, {
      grantId: created.grant.id,
      identityId: "j5-person-a",
      expectedPolicyVersion: null,
      accessNoticeEnabled: true,
      changeMode: "both",
      idempotencyKey: "joined-j5-notification-policy",
    });
    for (const [name, etag] of [["one.jpg", "etag-one"], ["two.jpg", "etag-two"]] as const) {
      const r2Key = `${folder}${name}`;
      await delivery.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind)
        VALUES(?,?,10,datetime('now'),'image/jpeg','image')`).bind(r2Key, etag).run();
      expect(await recordAuthenticatedDeliveryObjectChange(env, r2Key, true, etag, new Date().toISOString())).toBe(1);
    }
    let batch = await delivery.prepare("SELECT * FROM portal_authenticated_delivery_change_batches WHERE workspace_id=?")
      .bind(workspace).first<Record<string, unknown>>();
    expect(batch).toMatchObject({ status: "pending", added_count: 2, removed_count: 0 });
    expect(Date.parse(String(batch!.eligible_at)) - Date.parse(String(batch!.created_at))).toBeGreaterThanOrEqual(299_000);
    const sentNow = await controlAuthenticatedDeliveryChangeBatch(env, staff.id, {
      batchId: String(batch!.id),
      action: "send-now",
      expectedRevision: Number(batch!.revision),
      idempotencyKey: "joined-j5-send-now-control",
    });
    expect(sentNow.status).toBe("pending");
    const cancelled = await controlAuthenticatedDeliveryChangeBatch(env, staff.id, {
      batchId: String(batch!.id),
      action: "cancel",
      expectedRevision: sentNow.revision,
      idempotencyKey: "joined-j5-cancel-control",
    });
    expect(cancelled.status).toBe("cancelled");

    const leasedKey = `${folder}leased.jpg`;
    await delivery.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind)
      VALUES(?,'leased-etag',10,datetime('now'),'image/jpeg','image')`).bind(leasedKey).run();
    expect(await recordAuthenticatedDeliveryObjectChange(env, leasedKey, true, "leased-etag", new Date().toISOString())).toBe(1);
    batch = await delivery.prepare("SELECT * FROM portal_authenticated_delivery_change_batches WHERE workspace_id=? AND status='pending' ORDER BY created_at DESC,id DESC LIMIT 1")
      .bind(workspace).first<Record<string, unknown>>();
    await delivery.prepare(`UPDATE portal_authenticated_delivery_change_batches
      SET status='processing',revision=revision+1,attempt_count=1,lease_token='joined-j5-lease',lease_expires_at=datetime('now','+10 minutes') WHERE id=?`)
      .bind(batch!.id).run();
    const leased = await delivery.prepare("SELECT * FROM portal_authenticated_delivery_change_batches WHERE id=?")
      .bind(batch!.id).first<any>();
    const revoked = await revokeAuthenticatedDeliveryGrant(env, staff, created.grant.grantId, 1, "joined_j5_revoke", "joined-j5-grant-revoke");
    expect(revoked.grant.status).toBe("revoked");
    expect(await authorizeAuthenticatedDeliveryGrant(env, clientA, workspace, bindingId)).toBe(false);
    const suspended = await suspendPrimaryWorkspaceBindingsForFolderReassignment(env, staff, {
      opsProjectId: projectLocal,
      previousPrefix: "J5/Primary/Project/",
      nextPrefix: "J5/Primary/Moved/",
      previousDivisionId: "j5-division",
      nextDivisionId: "j5-division",
    });
    expect(suspended.bindingIds).toEqual([bindingId]);
    expect(await authorizeAuthenticatedDeliveryChangeBatch(env, leased)).toBeNull();

    const crashFolder = "J5/Primary/Project/Crash/";
    const crashTargets = await searchPrimaryWorkspaceBindingTargets(env, staff, crashFolder, "");
    await expect(createPrimaryWorkspaceBinding({ ...env, DELIVERY_DB: failReceiptBatch(delivery) }, staff, crashFolder, {
      folderRef: encodeRef(crashFolder.slice(0, -1)), workspaceId: workspace, reasonCode: "joined_j5_receipt_loss",
      expectedContextVersion: crashTargets.targets[0]!.contextVersion,
    }, "joined-j5-lost-receipt")).rejects.toThrow("simulated-receipt-write-loss");
    expect(await delivery.prepare("SELECT count(*) n FROM portal_v2_folder_bindings WHERE r2_prefix=?").bind(crashFolder).first<number>("n")).toBe(0);
    await expect(delivery.prepare("DELETE FROM portal_primary_staff_bindings WHERE binding_id=?").bind(bindingId).run()).rejects.toThrow(/immutable/i);

    const legacyBinding = "j5-unreceipted-legacy";
    await delivery.prepare(`INSERT INTO portal_v2_folder_bindings
      (id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version,status)
      VALUES(?,?,'project',?,'J5/Primary/Project/Legacy/','operations','project-v1','active')`)
      .bind(legacyBinding, workspace, projectPublic).run();
    await expect(delivery.batch([
      delivery.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants
        (id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,audience_type,
         audience_public_id,audience_source_version,reason_code,created_by_staff_id)
        VALUES('j5-legacy-grant','j5-legacy-grant',1,?,?,'project-v1','principal','j5-principal-a','person-a-v1','legacy',?)`)
        .bind(workspace, legacyBinding, staff.id),
      delivery.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_recipients
        (grant_id,workspace_id,principal_public_id,identity_id,principal_source_version)
        VALUES('j5-legacy-grant',?,'j5-principal-a','j5-person-a','person-a-v1')`).bind(workspace),
    ])).rejects.toThrow(/primary-staff-binding-required/);
    expect(await delivery.prepare("SELECT count(*) n FROM portal_v2_authenticated_delivery_grants WHERE id='j5-legacy-grant'")
      .first<number>("n")).toBe(0);
    expect(await authorizeAuthenticatedDeliveryGrant(env, clientA, workspace, legacyBinding)).toBe(false);
    await expect(previewAuthenticatedDeliveryGrant(env, staff, {
      ...operation,
      folderBindingId: legacyBinding,
    })).rejects.toMatchObject({ status: 409 });

    const secondaryRootPublic = publicId(6001), secondaryProjectPublic = publicId(6002);
    const secondaryWorkspace = "j5-secondary-workspace", secondaryGeneration = "j5-secondary-generation";
    const secondaryIdentity = "j5-secondary-identity", secondaryPrefix = "J5/Secondary/Delivery/";
    await ops.batch([
      ops.prepare("INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id) VALUES(?,'organization',?,'j5-secondary-root')")
        .bind(SECONDARY, secondaryRootPublic),
      ops.prepare("INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id) VALUES(?,'project',?,'j5-secondary-project')")
        .bind(SECONDARY, secondaryProjectPublic),
      ops.prepare("INSERT INTO pa_organizations(id,name,active,payload_json,last_sync_id,projection_source_id) VALUES('j5-secondary-root','Secondary root',1,?,'j5',?)")
        .bind(JSON.stringify({ public_id: secondaryRootPublic }), SECONDARY),
      ops.prepare(`INSERT INTO pa_projects(id,organization_id,name,active,payload_json,last_sync_id,projection_source_id)
        VALUES('j5-secondary-project','j5-secondary-root','Secondary project',1,?,'j5',?)`)
        .bind(JSON.stringify({ public_id: secondaryProjectPublic }), SECONDARY),
    ]);
    await delivery.batch([
      delivery.prepare("INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id) VALUES(?,?,?)")
        .bind(secondaryWorkspace, SECONDARY, "j5-secondary-external"),
      delivery.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id)
        VALUES(?,'organization',?,'J5 Secondary Workspace','active',?)`).bind(secondaryWorkspace, secondaryRootPublic, SECONDARY),
      delivery.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete)
        VALUES(?,?,?,1,'active',1)`).bind(secondaryGeneration, secondaryWorkspace, secondaryGeneration),
      delivery.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version)
        VALUES(?,?,'organization',?,NULL,'Secondary root','secondary-root-v1'),
          (?,?,'project',?,?,'Secondary project','secondary-project-v1')`)
        .bind(secondaryWorkspace, secondaryGeneration, secondaryRootPublic,
          secondaryWorkspace, secondaryGeneration, secondaryProjectPublic, secondaryRootPublic),
      delivery.prepare("INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version) VALUES(?,?,3)")
        .bind(secondaryGeneration, secondaryWorkspace),
      delivery.prepare(`INSERT INTO portal_v2_directory_relations
        (workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version,active)
        VALUES(?,?,'j5-secondary-project-parent','contains','organization',?,'project',?,'secondary-relation-v1',1)`)
        .bind(secondaryWorkspace, secondaryGeneration, secondaryRootPublic, secondaryProjectPublic),
      delivery.prepare(`INSERT INTO portal_v2_project_lifecycle
        (workspace_id,generation_id,project_public_id,lifecycle_status,source_version)
        VALUES(?,?,?,'active','secondary-lifecycle-v1')`)
        .bind(secondaryWorkspace, secondaryGeneration, secondaryProjectPublic),
      delivery.prepare("INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)")
        .bind(secondaryWorkspace, secondaryGeneration),
      delivery.prepare(`INSERT INTO pa_portal_projection_receipts
        (projection_source_id,delivery_id,workspace_id,delivery_kind,payload_hash,source_sequence,status)
        VALUES(?,'j5-secondary-signed',?,'snapshot_activate',?,1,'completed')`)
        .bind(SECONDARY, secondaryWorkspace, "c".repeat(64)),
      delivery.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES(?,?,'j5-secondary-subject','secondary@example.test','active')")
        .bind(secondaryIdentity, ISSUER),
      delivery.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,source_version,status)
        VALUES('j5-secondary-member',?,?,'project_alpha','secondary-person-v1','active')`).bind(secondaryWorkspace, secondaryIdentity),
      delivery.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status)
        VALUES(?,'j5-secondary-person',?,'secondary@example.test','Secondary person','secondary-person-v1','active')`)
        .bind(secondaryWorkspace, secondaryIdentity),
      ...["workspace.view", "delivery.view"].map(capability => delivery.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,entitlement_version,source_type,source_version,status,valid_from)
        VALUES(?,?,?,?,'allow','workspace',?,1,'project_alpha','secondary-allow-v1','active','2020-01-01T00:00:00Z')`)
        .bind(`j5-secondary-${capability}`, secondaryWorkspace, secondaryIdentity, capability, secondaryWorkspace)),
    ]);
    const secondaryOperation = {
      folderRef: encodeRef(secondaryPrefix.slice(0, -1)),
      sourceId: SECONDARY,
      workspaceId: secondaryWorkspace,
      projectId: "j5-secondary-project",
      principalPublicId: "j5-secondary-person",
      reasonCode: "joined_j5_secondary",
      expiresAt: null,
    };
    const secondaryPreview = await previewNativeDeliveryGrant(env, staff, secondaryOperation);
    const secondaryGrant = await createNativeDeliveryGrant(env, staff, {
      ...secondaryOperation,
      expectedContextVersion: secondaryPreview.contextVersion,
    }, "joined-j5-secondary-create");
    expect(secondaryGrant.grant).toMatchObject({ status: "active", sourceId: SECONDARY, workspaceId: secondaryWorkspace });
    const secondaryClient = { issuer: ISSUER, subject: "j5-secondary-subject", email: "secondary@example.test" };
    const secondaryContext = await resolveNativePortalWorkspaceReadContext(env, secondaryClient, secondaryWorkspace);
    expect(secondaryContext).not.toBeNull();
    expect(await readNativeAuthenticatedDeliveryGrants(env, secondaryClient, secondaryContext!))
      .toEqual(expect.arrayContaining([expect.objectContaining({ grant_id: secondaryGrant.grant.id, r2_prefix: secondaryPrefix })]));
    const secondaryRevoked = await revokeNativeDeliveryGrant(env, staff, secondaryGrant.grant.id, {
      folderRef: secondaryOperation.folderRef,
      expectedVersion: 1,
      reasonCode: "joined_j5_secondary_revoke",
    }, "joined-j5-secondary-revoke");
    expect(secondaryRevoked.grant.status).toBe("revoked");
    expect(await readNativeAuthenticatedDeliveryGrants(env, secondaryClient, secondaryContext!)).toEqual([]);

    expect(await delivery.prepare("SELECT * FROM shares WHERE id='j5-public-share'").first()).toEqual(publicShareBefore);
    expect((await delivery.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});
