import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { PRIMARY_CATALOG_SOURCE } from "@ltds/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  readServiceAssignmentPolicy,
  serviceAssignmentPolicyProofStillCurrent,
} from "../src/worker/client-portal/service-assignment-policy";
import {
  listServiceCatalogPageForSource,
} from "../src/worker/client-portal/service-catalog-page";
import {
  createServiceRequestDraft,
  saveServiceRequestDraft,
  submitServiceRequestDraft,
} from "../src/worker/client-portal/request-v2";
import type { ClientPortalSession, ClientServiceRequestDraftInput } from "../src/worker/client-portal/types";
import { effectiveWorkspaceRequestMutationGuardSql, readEffectiveWorkspaceRequestProof } from "../src/worker/client-portal/workspace-v2";
import type { Env } from "../src/worker/types";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const sourceId = "project-alpha:primary";
const workspaceId = "policy-workspace";
const session: ClientPortalSession = {
  accountId: "policy-account",
  identityId: "policy-identity",
  workspaceId,
  principalIssuer: "https://issuer.test",
  principalSubject: "policy-subject",
  principalEmail: "policy@example.test",
  displayName: "Policy client",
  role: "manager",
  canViewBilling: false,
};

describe("exact-target service-assignment request policy", { timeout: 60_000 }, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;
  let databaseIndex = 0;

  beforeAll(() => {
    runtime = new Miniflare({
      compatibilityDate: "2026-08-06",
      modules: true,
      script: "export default {fetch(){return new Response('ok')}}",
      d1Databases: Object.fromEntries(Array.from({ length: 8 }, (_, index) =>
        [`POLICY_DB_${index}`, `service-assignment-policy-${index}`])),
    });
  });

  afterAll(async () => runtime.dispose());

  beforeEach(async () => {
    db = await runtime.getD1Database(`POLICY_DB_${databaseIndex++}`) as unknown as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"));
      if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
    }
    await seedPolicyContext();
    env = {
      DELIVERY_DB: db,
      CLIENT_PORTAL_REQUEST_V2_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true",
      CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true",
      PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED: "true",
      CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED: "true",
    } as Env;
  }, 60_000);

  async function seedPolicyContext() {
    await db.batch([
      db.prepare(`INSERT INTO client_accounts
        (id,display_name,status,project_alpha_organization_id,project_alpha_source_id)
        VALUES ('policy-account','Policy client','active','pa-org-policy',?)`).bind(sourceId),
      db.prepare(`INSERT INTO client_identity_links(id,account_id,issuer,subject,email)
        VALUES ('policy-identity','policy-account','https://issuer.test','policy-subject','policy@example.test')`),
      db.prepare(`INSERT INTO client_account_members(account_id,identity_id,role)
        VALUES ('policy-account','policy-identity','manager')`),
      db.prepare(`INSERT INTO projects
        (id,client_name,project_name,r2_prefix,project_alpha_source_id,project_alpha_project_id)
        VALUES ('project-a','Policy client','Project A','clients/policy/a/',?,'pa-project-a'),
          ('project-b','Policy client','Project B','clients/policy/b/',?,'pa-project-b')`).bind(sourceId, sourceId),
      db.prepare(`INSERT INTO client_project_grants(account_id,project_id,can_request_service)
        VALUES ('policy-account','project-a',1),('policy-account','project-b',1)`),
      db.prepare(`INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id)
        VALUES (?,?,?)`).bind(workspaceId, sourceId, "pa-policy-workspace"),
      db.prepare(`INSERT INTO portal_v2_workspaces
        (id,root_type,pa_organization_public_id,legacy_account_id,display_name,status,project_alpha_source_id)
        VALUES (?,'organization','pa-org-policy','policy-account','Policy client','active',?)`).bind(workspaceId, sourceId),
      db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status)
        VALUES ('portal-policy-identity','https://issuer.test','policy-subject','policy@example.test','active')`),
      db.prepare(`INSERT INTO portal_v2_workspace_memberships
        (id,workspace_id,identity_id,source_type,status,source_version)
        VALUES ('policy-membership',?,'portal-policy-identity','project_alpha','active','membership-v1')`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_generations
        (id,workspace_id,source_generation,source_sequence,status,complete,activated_at)
        VALUES ('directory-1',?,'directory-generation-1',1,'active',1,datetime('now'))`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,display_name,source_version,active)
        VALUES (?,'directory-1','organization','pa-org-policy','Policy client','directory-v1',1),
          (?,'directory-1','project','pa-project-a','Project A','directory-v1',1),
          (?,'directory-1','project','pa-project-b','Project B','directory-v1',1)`)
        .bind(workspaceId, workspaceId, workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_generation_contracts
        (generation_id,workspace_id,schema_version) VALUES ('directory-1',?,3)`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_project_lifecycle
        (workspace_id,generation_id,project_public_id,lifecycle_status,source_version)
        VALUES (?,'directory-1','pa-project-a','active','directory-v1'),
          (?,'directory-1','pa-project-b','active','directory-v1')`).bind(workspaceId, workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_relations
        (workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version,active)
        VALUES (?,'directory-1','contains-a','contains','organization','pa-org-policy','project','pa-project-a','directory-v1',1),
          (?,'directory-1','contains-b','contains','organization','pa-org-policy','project','pa-project-b','directory-v1',1)`)
        .bind(workspaceId, workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence)
        VALUES (?,'directory-1',1)`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,source_version,status)
        VALUES ('policy-view',?,'portal-policy-identity','workspace.view','allow','workspace',?,'project_alpha','entitlement-v1','active'),
          ('policy-request-root',?,'portal-policy-identity','request.create','allow','workspace',?,'project_alpha','entitlement-v1','active'),
          ('policy-request-project-a',?,'portal-policy-identity','request.create','allow','project','pa-project-a','project_alpha','entitlement-v1','active'),
          ('policy-request-project-b',?,'portal-policy-identity','request.create','allow','project','pa-project-b','project_alpha','entitlement-v1','active')`)
        .bind(workspaceId, workspaceId, workspaceId, workspaceId, workspaceId, workspaceId),
      db.prepare(`INSERT INTO pa_service_catalog_generations
        (id,source_id,source_generation,source_sequence,snapshot_hash,page_count,item_count,status,complete)
        VALUES ('catalog-generation',?,'catalog-v1',1,?,1,3,'active',1)`).bind(sourceId, "c".repeat(64)),
      db.prepare(`UPDATE pa_service_catalog_checkpoint
        SET active_generation_id='catalog-generation',source_generation='catalog-v1',source_sequence=1
        WHERE source_id=?`).bind(sourceId),
      db.prepare(`INSERT INTO pa_service_catalog_items
        (source_id,public_id,source_version,name,category,display_order,source_updated_at,source_generation,source_sequence)
        VALUES (?,'root-service','service-v1','Root service','Mapping',1,datetime('now'),'catalog-v1',1),
          (?,'project-service','service-v1','Project service','Mapping',2,datetime('now'),'catalog-v1',1),
          (?,'project-service-2','service-v1','Second project service','Mapping',3,datetime('now'),'catalog-v1',1)`)
        .bind(sourceId, sourceId, sourceId),
      db.prepare(`INSERT INTO pa_service_assignment_receiver_grants
        (source_id,capability,contract_version,state,created_by)
        VALUES (?,'portal.service-assignments.publish',1,'active','test')`).bind(sourceId),
      db.prepare(`INSERT INTO pa_service_assignment_receiver_workspaces(source_id,workspace_id,state,created_by)
        VALUES (?,?,'active','test')`).bind(sourceId, workspaceId),
      db.prepare(`INSERT INTO pa_service_assignment_generations
        (id,source_id,source_generation,source_sequence,snapshot_hash,page_count,item_count,status,complete)
        VALUES ('assignment-generation',?,'assignments-v1',1,?,1,3,'active',1)`)
        .bind(sourceId, "a".repeat(64)),
      db.prepare(`INSERT INTO pa_service_assignments
        (source_id,assignment_public_id,source_version,subject_type,subject_public_id,service_public_id,
          service_source_version,active,source_updated_at,source_generation,source_sequence)
        VALUES (?,'assignment-root','assignment-v1','organization','pa-org-policy','root-service','service-v1',1,datetime('now'),'assignments-v1',1),
          (?,'assignment-project','assignment-v1','project','pa-project-a','project-service','service-v1',1,datetime('now'),'assignments-v1',1),
          (?,'assignment-project-2','assignment-v1','project','pa-project-a','project-service-2','service-v1',1,datetime('now'),'assignments-v1',1)`)
        .bind(sourceId, sourceId, sourceId),
      db.prepare(`INSERT INTO pa_service_assignment_checkpoints
        (source_id,active_generation_id,source_generation,source_sequence)
        VALUES (?,'assignment-generation','assignments-v1',1)`).bind(sourceId),
    ]);
  }

  it("is default-off and refuses retained facts whenever any receiver prerequisite is off", async () => {
    expect(await readServiceAssignmentPolicy({ ...env,
      CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED: "false" }, session, null))
      .toEqual({ state: "disabled", proof: null, assignedServiceCount: null });

    for (const missing of [
      "PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED",
      "CLIENT_PORTAL_REQUEST_V2_ENABLED",
      "CLIENT_PORTAL_HIERARCHY_V2_ENABLED",
      "CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED",
    ] as const) {
      expect(await readServiceAssignmentPolicy({ ...env, [missing]: "false" }, session, null))
        .toEqual({ state: "unavailable", proof: null, assignedServiceCount: null });
    }
  });

  it("uses only the exact root or exact project assignment without inheritance", async () => {
    const root = await readServiceAssignmentPolicy(env, session, null);
    expect(root).toMatchObject({ state: "ready", assignedServiceCount: 1,
      proof: { subjectType: "organization", subjectPublicId: "pa-org-policy", localProjectId: null } });
    const project = await readServiceAssignmentPolicy(env, session, "project-a");
    expect(project).toMatchObject({ state: "ready", assignedServiceCount: 2,
      proof: { subjectType: "project", subjectPublicId: "pa-project-a", localProjectId: "project-a" } });
    expect(await readServiceAssignmentPolicy(env, session, "project-b"))
      .toMatchObject({ state: "no_services_assigned", assignedServiceCount: 0,
        proof: { subjectPublicId: "pa-project-b" } });

    expect((await listServiceCatalogPageForSource(env, PRIMARY_CATALOG_SOURCE,
      { projectId: null }, session)).services.map(service => service.publicId)).toEqual(["root-service"]);
    expect((await listServiceCatalogPageForSource(env, PRIMARY_CATALOG_SOURCE,
      { projectId: "project-a" }, session)).services.map(service => service.publicId))
      .toEqual(["project-service", "project-service-2"]);
    expect((await listServiceCatalogPageForSource(env, PRIMARY_CATALOG_SOURCE,
      { projectId: "project-b" }, session)).services).toEqual([]);
  });

  it("binds continuation to the original actor and exact project", async () => {
    const first = await listServiceCatalogPageForSource(env, PRIMARY_CATALOG_SOURCE,
      { projectId: "project-a", limit: 1 }, session);
    expect(first.nextCursor).not.toBeNull();
    expect((await listServiceCatalogPageForSource(env, PRIMARY_CATALOG_SOURCE,
      { projectId: "project-a", limit: 1, cursor: first.nextCursor! }, session)).services)
      .toHaveLength(1);

    await expect(listServiceCatalogPageForSource(env, PRIMARY_CATALOG_SOURCE,
      { projectId: "project-a", limit: 1, cursor: first.nextCursor! },
      { ...session, identityId: "different-identity" })).rejects
      .toMatchObject({ status: 409, code: "catalog_changed" });
    await expect(listServiceCatalogPageForSource(env, PRIMARY_CATALOG_SOURCE,
      { projectId: "project-b", limit: 1, cursor: first.nextCursor! }, session)).rejects
      .toMatchObject({ status: 409, code: "catalog_changed" });
  });

  it("invalidates proofs on enrollment, directory mapping, or policy rollback", async () => {
    const decision = await readServiceAssignmentPolicy(env, session, "project-a");
    expect(decision.state).toBe("ready");
    if (decision.state !== "ready") throw new Error("policy fixture unavailable");
    expect(await serviceAssignmentPolicyProofStillCurrent(env, decision.proof)).toBe(true);

    await db.prepare(`UPDATE pa_service_assignment_receiver_workspaces SET state='suspended'
      WHERE source_id=? AND workspace_id=?`).bind(sourceId, workspaceId).run();
    expect(await serviceAssignmentPolicyProofStillCurrent(env, decision.proof)).toBe(false);
    await db.prepare(`UPDATE pa_service_assignment_receiver_workspaces SET state='active'
      WHERE source_id=? AND workspace_id=?`).bind(sourceId, workspaceId).run();
    expect(await serviceAssignmentPolicyProofStillCurrent(env,
      { ...decision.proof, localProjectId: "project-b" })).toBe(false);
    await db.batch([
      db.prepare(`INSERT INTO portal_v2_directory_generations
        (id,workspace_id,source_generation,source_sequence,status,complete,activated_at)
        VALUES ('directory-2',?,'directory-generation-2',2,'active',1,datetime('now'))`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,display_name,source_version,active)
        VALUES (?,'directory-2','organization','pa-org-policy','Policy client','directory-v2',1),
          (?,'directory-2','project','pa-project-a','Project A','directory-v2',1),
          (?,'directory-2','project','pa-project-b','Project B','directory-v2',1)`)
        .bind(workspaceId, workspaceId, workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_generation_contracts
        (generation_id,workspace_id,schema_version) VALUES ('directory-2',?,3)`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_relations
        (workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version,active)
        VALUES (?,'directory-2','contains-a-v2','contains','organization','pa-org-policy','project','pa-project-a','directory-v2',1),
          (?,'directory-2','contains-b-v2','contains','organization','pa-org-policy','project','pa-project-b','directory-v2',1)`)
        .bind(workspaceId, workspaceId),
      db.prepare(`UPDATE portal_v2_directory_checkpoints
        SET active_generation_id='directory-2',source_sequence=2 WHERE workspace_id=?`).bind(workspaceId),
    ]);
    expect(await serviceAssignmentPolicyProofStillCurrent(env, decision.proof)).toBe(false);
    expect(await serviceAssignmentPolicyProofStillCurrent({ ...env,
      PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED: "false" }, decision.proof)).toBe(false);
  });

  it("reports a checkpoint race as unavailable rather than as no assigned services", async () => {
    let interleaved = false;
    const deliveryDatabase = new Proxy(db, {
      get(target, property) {
        if (property !== "withSession") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (constraint?: D1SessionBookmark | D1SessionConstraint) => {
          const current = target.withSession(constraint);
          return new Proxy(current, {
            get(sessionTarget, sessionProperty) {
              if (sessionProperty !== "prepare") {
                const value = Reflect.get(sessionTarget, sessionProperty, sessionTarget);
                return typeof value === "function" ? value.bind(sessionTarget) : value;
              }
              return (sql: string) => {
                const statement = sessionTarget.prepare(sql);
                if (!sql.includes("COUNT(DISTINCT catalog.public_id)")) return statement;
                return new Proxy(statement, {
                  get(statementTarget, statementProperty) {
                    if (statementProperty !== "bind") {
                      const value = Reflect.get(statementTarget, statementProperty, statementTarget);
                      return typeof value === "function" ? value.bind(statementTarget) : value;
                    }
                    return (...bindings: unknown[]) => {
                      const bound = statementTarget.bind(...bindings);
                      return new Proxy(bound, {
                        get(boundTarget, boundProperty) {
                          if (boundProperty !== "first") {
                            const value = Reflect.get(boundTarget, boundProperty, boundTarget);
                            return typeof value === "function" ? value.bind(boundTarget) : value;
                          }
                          return async <T>(column?: string) => {
                            const result = column === undefined
                              ? await boundTarget.first<T>()
                              : await boundTarget.first<T>(column);
                            if (!interleaved) {
                              interleaved = true;
                              await db.prepare(`UPDATE pa_service_assignment_receiver_workspaces SET state='suspended'
                                WHERE source_id=? AND workspace_id=?`).bind(sourceId, workspaceId).run();
                            }
                            return result;
                          };
                        },
                      });
                    };
                  },
                });
              };
            },
          });
        };
      },
    });
    expect(await readServiceAssignmentPolicy({ ...env, DELIVERY_DB: deliveryDatabase }, session, "project-a"))
      .toEqual({ state: "unavailable", proof: null, assignedServiceCount: null });
    expect(interleaved).toBe(true);
  });

  it("persists an exact proof and atomically rolls back an enrollment race", async () => {
    const input: ClientServiceRequestDraftInput = {
      projectId: "project-a",
      requestType: "service",
      title: "Exact project request",
      details: "Request details",
      location: null,
      preferredStartAt: null,
      deliverables: null,
      siteContactName: null,
      siteContactEmail: null,
      siteContactPhone: null,
      desiredCompletionAt: null,
      latitude: null,
      longitude: null,
      areaGeoJson: null,
      poiPoints: [],
      services: [{ publicId: "project-service", sourceVersion: "service-v1", answers: {} }],
    };
    const requestAuthority = await readEffectiveWorkspaceRequestProof(env, {
      issuer: session.principalIssuer!, subject: session.principalSubject!, email: session.principalEmail!,
    }, workspaceId, "project-a");
    expect(requestAuthority).toMatchObject({ projectAllowed: true,
      mutationProof: { workspaceId, localProjectId: "project-a", projectPublicId: "pa-project-a" } });
    const requestGuard = effectiveWorkspaceRequestMutationGuardSql(requestAuthority!.mutationProof);
    expect(await db.prepare(`SELECT ${requestGuard.sql} allowed`).bind(...requestGuard.bindings).first<number>("allowed")).toBe(1);
    const created = await createServiceRequestDraft(env, session, input, "policy-create-key-0001");
    expect(created?.kind).toBe("created");
    const stored = await db.prepare(`SELECT service_assignment_policy_json proof
      FROM client_service_request_drafts WHERE create_idempotency_key='policy-create-key-0001'`)
      .first<string>("proof");
    expect(JSON.parse(stored!)).toMatchObject({
      sourceId, workspaceId, localProjectId: "project-a", subjectType: "project",
      subjectPublicId: "pa-project-a", directoryGenerationId: "directory-1",
    });
    await expect(db.prepare(`UPDATE client_service_request_drafts
      SET service_assignment_policy_json=json_remove(service_assignment_policy_json,'$.workspaceId')
      WHERE create_idempotency_key='policy-create-key-0001'`).run()).rejects.toThrow();
    await expect(db.prepare(`UPDATE client_service_request_drafts
      SET service_assignment_policy_json=json_set(service_assignment_policy_json,'$.localProjectId',NULL)
      WHERE create_idempotency_key='policy-create-key-0001'`).run()).rejects.toThrow();
    if (!created || !("draft" in created)) throw new Error("expected created draft");
    const saved = await saveServiceRequestDraft(env, session, created.draft.id, created.draft.version,
      { ...input, title: "Updated exact project request" }, "policy-save-key-0001");
    expect(saved?.kind).toBe("updated");
    if (!saved || !("draft" in saved)) throw new Error("expected updated draft");
    const submitted = await submitServiceRequestDraft(env, session, saved.draft.id, saved.draft.version,
      "policy-submit-key-0001");
    expect(submitted?.kind).toBe("submitted");
    expect(await db.prepare(`SELECT count(*) count FROM client_service_requests
      WHERE service_assignment_policy_json IS NOT NULL`).first<number>("count")).toBe(1);

    let pending = true;
    const wrapped = new Proxy(db, {
      get(target, property) {
        if (property === "withSession") return () => wrapped;
        if (property === "batch") return async (statements: D1PreparedStatement[]) => {
          if (pending) {
            pending = false;
            await db.prepare(`UPDATE pa_service_assignment_receiver_workspaces SET state='suspended'
              WHERE source_id=? AND workspace_id=?`).bind(sourceId, workspaceId).run();
          }
          return target.batch(statements);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const raced = await createServiceRequestDraft({ ...env, DELIVERY_DB: wrapped }, session, input,
      "policy-create-key-raced");
    expect(raced).toEqual({ kind: "service_assignments_changed", servicePublicIds: ["project-service"] });
    expect(await db.prepare(`SELECT count(*) count FROM client_service_request_drafts
      WHERE create_idempotency_key='policy-create-key-raced'`).first<number>("count")).toBe(0);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("atomically rejects workspace suspension, identity denial, and request.create revocation races", async () => {
    const input: ClientServiceRequestDraftInput = {
      projectId: "project-a", requestType: "service", title: "Authority race request", details: "Request details",
      location: null, preferredStartAt: null, deliverables: null, siteContactName: null, siteContactEmail: null,
      siteContactPhone: null, desiredCompletionAt: null, latitude: null, longitude: null, areaGeoJson: null,
      poiPoints: [], services: [{ publicId: "project-service", sourceVersion: "service-v1", answers: {} }],
    };
    function databaseWithOneInterleave(action: () => Promise<unknown>): D1Database {
      let pending = true;
      let wrapped: D1Database;
      wrapped = new Proxy(db, {
        get(target, property) {
          if (property === "withSession") return () => wrapped;
          if (property === "batch") return async (statements: D1PreparedStatement[]) => {
            if (pending) { pending = false; await action(); }
            return target.batch(statements);
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return wrapped;
    }

    const suspended = await createServiceRequestDraft({ ...env, DELIVERY_DB: databaseWithOneInterleave(() =>
      db.prepare(`UPDATE portal_v2_workspaces SET status='suspended' WHERE id=?`).bind(workspaceId).run()) },
    session, input, "authority-race-create");
    expect(suspended).toEqual({ kind: "service_assignments_changed", servicePublicIds: ["project-service"] });
    expect(await db.prepare(`SELECT COUNT(*) count FROM client_service_request_drafts
      WHERE create_idempotency_key='authority-race-create'`).first<number>("count")).toBe(0);
    await db.prepare(`UPDATE portal_v2_workspaces SET status='active' WHERE id=?`).bind(workspaceId).run();

    const created = await createServiceRequestDraft(env, session, input, "authority-race-seed");
    if (!created || !("draft" in created)) throw new Error("expected authority race draft");
    const denied = await saveServiceRequestDraft({ ...env, DELIVERY_DB: databaseWithOneInterleave(() =>
      db.prepare(`INSERT INTO portal_v2_identity_denials
        (id,identity_id,workspace_id,scope_type,scope_public_id,reason_code,created_by_actor_type,created_by_actor_id)
        VALUES ('authority-race-deny','portal-policy-identity',?,'project','pa-project-a','test_race','system','test')`)
        .bind(workspaceId).run()) }, session, created.draft.id, created.draft.version,
    { ...input, title: "Denied while saving" }, "authority-race-save");
    expect(denied).toEqual({ kind: "conflict" });
    expect((await db.prepare(`SELECT version FROM client_service_request_drafts WHERE id=?`)
      .bind(created.draft.id).first<number>("version"))).toBe(created.draft.version);
    await db.prepare(`UPDATE portal_v2_identity_denials SET status='revoked',revoked_at=datetime('now'),
      revoked_by_actor_type='system',revoked_by_actor_id='test' WHERE id='authority-race-deny'`).run();

    const revoked = await submitServiceRequestDraft({ ...env, DELIVERY_DB: databaseWithOneInterleave(() =>
      db.prepare(`UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now')
        WHERE id IN ('policy-request-project-a','policy-request-root')`).run()) }, session, created.draft.id, created.draft.version,
    "authority-race-submit");
    expect(revoked).toEqual({ kind: "conflict" });
    expect(await db.prepare(`SELECT COUNT(*) count FROM client_service_requests
      WHERE id=(SELECT submitted_request_id FROM client_service_request_drafts WHERE id=?)`)
      .bind(created.draft.id).first<number>("count")).toBe(0);
    expect(await db.prepare(`SELECT state FROM client_service_request_drafts WHERE id=?`)
      .bind(created.draft.id).first<string>("state")).toBe("draft");
  });

  it("rejects expired caller windows instead of treating them as an empty assignment set", async () => {
    const evaluatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const expiresAt = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(await readServiceAssignmentPolicy(env, session, "project-a", { evaluatedAt, expiresAt }))
      .toEqual({ state: "unavailable", proof: null, assignedServiceCount: null });
  });
});
