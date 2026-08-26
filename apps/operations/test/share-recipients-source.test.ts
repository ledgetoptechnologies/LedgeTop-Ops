import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCatalogSourceContext, PRIMARY_CATALOG_SOURCE } from "@ltds/shared";
import { projectAlphaDeliveryPrincipalGuard, resolveProjectAlphaDeliveryPrincipal, type ShareAudienceSnapshot } from "../src/worker/share-recipients";
import type { Env } from "../src/worker/types";

const secondary = createCatalogSourceContext("project-alpha:secondary");
const prefix = "jobs/shared/project/", principalId = "same-principal", version = "principal-v1";
const directory = new URL("../../client/migrations/", import.meta.url);
const migrations = readdirSync(directory).filter(name => /^\d+_.+\.sql$/.test(name)).sort()
  .map(name => readFileSync(new URL(name, directory), "utf8"));

// Production SQL and all real migrations execute in SQLite. The adapter only
// supplies D1's async call shape; it does not choose authorization results.
function asD1(db: DatabaseSync): D1Database {
  const adapter = {
    withSession: () => adapter,
    prepare(sql: string) {
      let bindings: SQLInputValue[] = [];
      const statement = {
        bind(...values: SQLInputValue[]) { bindings = values; return statement; },
        async all() { return { results: db.prepare(sql).all(...bindings) }; },
      };
      return statement;
    },
  };
  return adapter as unknown as D1Database;
}

describe("source-pinned PA delivery recipient and transaction guard", () => {
  let db: DatabaseSync, env: Env;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    for (const sql of migrations) { db.exec("BEGIN"); db.exec(sql); db.exec("COMMIT"); }
    env = { DELIVERY_DB: asD1(db), CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED: "true" } as Env;
    seed("primary", PRIMARY_CATALOG_SOURCE.sourceId);
    seed("secondary", secondary.sourceId);
  });
  afterEach(() => db?.close());

  function seed(name: string, sourceId: string, folder = prefix) {
    const workspace = `workspace-${name}`, generation = `generation-${name}`;
    db.prepare("INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id) VALUES(?,?,?)")
      .run(workspace, sourceId, workspace);
    db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,project_alpha_source_id)
      VALUES(?,'organization',?,?,?)`).run(workspace, `org-${name}`, name, sourceId);
    db.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete)
      VALUES(?,?,'source-generation',1,'active',1)`).run(generation, workspace);
    db.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)`)
      .run(workspace, generation);
    db.prepare(`INSERT INTO portal_v2_directory_entities
      (workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version)
      VALUES(?,?,'project','same-project',NULL,'Project','binding-v1')`).run(workspace, generation);
    db.prepare(`INSERT INTO portal_v2_folder_bindings
      (id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version)
      VALUES(?,?,'project','same-project',?,'project_alpha','binding-v1')`).run(`binding-${name}`, workspace, folder);
    db.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,email_hint,display_name,source_version,status)
      VALUES(?,?,?,?,'principal-v1','active')`).run(workspace, principalId, `${name}@example.test`, name);
  }

  function linked(name = "primary", id = `identity-${name}`) {
    db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES(?,'https://issuer.test',?,?)")
      .run(id, id, `${name}@example.test`);
    db.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type)
      VALUES(?,?,?,'project_alpha')`).run(`membership-${id}`, `workspace-${name}`, id);
    db.prepare("UPDATE pa_portal_principals SET identity_id=? WHERE workspace_id=? AND public_id=?")
      .run(id, `workspace-${name}`, principalId);
  }

  function guard(audience: ShareAudienceSnapshot, source = PRIMARY_CATALOG_SOURCE, requestPrefix = prefix, allowUnclaimed = true) {
    return projectAlphaDeliveryPrincipalGuard({ audience, principalSourceVersion: version,
      bindingSourceVersion: "binding-v1", prefix: requestPrefix, allowUnclaimed, source });
  }
  function permits(value: ReturnType<typeof projectAlphaDeliveryPrincipalGuard>) {
    return db.prepare(`SELECT CASE WHEN (${value.sql}) THEN 1 ELSE 0 END permitted`).get(...value.bindings)?.permitted;
  }

  it.each(["unclaimed", "linked"])("keeps overlapping %s principals and prefixes inside the selected source", async mode => {
    if (mode === "linked") { linked(); linked("secondary"); }
    const primary = await resolveProjectAlphaDeliveryPrincipal(env, prefix, principalId, version);
    const other = await resolveProjectAlphaDeliveryPrincipal(env, prefix, principalId, version, secondary);
    expect(primary).toMatchObject({ workspaceId: "workspace-primary", recipients: [{ email: "primary@example.test" }] });
    expect(other).toMatchObject({ workspaceId: "workspace-secondary", recipients: [{ email: "secondary@example.test" }] });
    expect(permits(guard(primary))).toBe(1);
    expect(permits(guard(other, secondary))).toBe(1);
    expect(permits(guard(primary, secondary))).toBe(0);
    expect(permits(guard(other))).toBe(0);
  });

  it("applies the source filter before longest-prefix ordering and LIMIT", async () => {
    seed("primary-child-one", PRIMARY_CATALOG_SOURCE.sourceId, `${prefix}nested/`);
    seed("primary-child-two", PRIMARY_CATALOG_SOURCE.sourceId, `${prefix}nested/`);
    const path = `${prefix}nested/`;
    await expect(resolveProjectAlphaDeliveryPrincipal(env, path, principalId, version)).rejects.toMatchObject({ status: 409 });
    const selected = await resolveProjectAlphaDeliveryPrincipal(env, path, principalId, version, secondary);
    expect(selected.workspaceId).toBe("workspace-secondary");
    expect(permits(guard(selected, secondary))).toBe(1);
  });

  it("never falls back to another source when its selected source is absent or suspended", async () => {
    db.exec("UPDATE portal_v2_workspaces SET status='suspended' WHERE id='workspace-primary'");
    await expect(resolveProjectAlphaDeliveryPrincipal(env, prefix, principalId, version)).rejects.toMatchObject({ status: 409 });
    await expect(resolveProjectAlphaDeliveryPrincipal(env, prefix, principalId, version, createCatalogSourceContext("project-alpha:missing")))
      .rejects.toMatchObject({ status: 409 });
    expect((await resolveProjectAlphaDeliveryPrincipal(env, prefix, principalId, version, secondary)).workspaceId).toBe("workspace-secondary");
  });

  it.each(["", "project-alpha:SECONDARY", "project-alpha:primary ", "project-alpha:primary' OR 1=1--"])(
    "rejects malformed source %j before any D1 lookup", async sourceId => {
      const lookup = vi.spyOn(env.DELIVERY_DB, "withSession");
      await expect(resolveProjectAlphaDeliveryPrincipal(env, prefix, principalId, version, { sourceId })).rejects.toThrow("catalog-source-invalid");
      expect(lookup).not.toHaveBeenCalled();
    });

  it.each([
    ["workspace suspension", "UPDATE portal_v2_workspaces SET status='suspended' WHERE id='workspace-primary'"],
    ["binding revision", "UPDATE portal_v2_folder_bindings SET source_version='binding-v2' WHERE id='binding-primary'"],
    ["binding prefix", "UPDATE portal_v2_folder_bindings SET r2_prefix='jobs/shared/' WHERE id='binding-primary'"],
    ["binding revocation", "UPDATE portal_v2_folder_bindings SET revoked_at=datetime('now') WHERE id='binding-primary'"],
    ["incomplete generation", "UPDATE portal_v2_directory_generations SET complete=0 WHERE id='generation-primary'"],
    ["inactive owner", "UPDATE portal_v2_directory_entities SET active=0 WHERE workspace_id='workspace-primary'"],
    ["owner revision", "UPDATE portal_v2_directory_entities SET source_version='binding-v2' WHERE workspace_id='workspace-primary'"],
    ["principal revision", "UPDATE pa_portal_principals SET source_version='principal-v2' WHERE workspace_id='workspace-primary'"],
    ["principal suspension", "UPDATE pa_portal_principals SET status='suspended' WHERE workspace_id='workspace-primary'"],
    ["recipient email", "UPDATE pa_portal_principals SET email_hint='changed@example.test' WHERE workspace_id='workspace-primary'"],
  ])("invalidates a selected recipient after %s changes", async (_label, sql) => {
    const proof = guard(await resolveProjectAlphaDeliveryPrincipal(env, prefix, principalId, version));
    expect(permits(proof)).toBe(1);
    db.exec(sql);
    expect(permits(proof)).toBe(0);
  });

  it("invalidates selection when an equally specific primary binding appears after the read", async () => {
    const selected = await resolveProjectAlphaDeliveryPrincipal(env, prefix, principalId, version);
    const proof = guard(selected);
    seed("competing", PRIMARY_CATALOG_SOURCE.sourceId);
    expect(permits(proof)).toBe(0);
  });

  it("shares unclaimed policy and blocks without authorizing by the saved snapshot", async () => {
    const selected = await resolveProjectAlphaDeliveryPrincipal(env, prefix, principalId, version);
    expect(permits(guard(selected, PRIMARY_CATALOG_SOURCE, prefix, false))).toBe(0);
    await expect(resolveProjectAlphaDeliveryPrincipal({ ...env, CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED: "false" }, prefix, principalId, version))
      .rejects.toMatchObject({ status: 409 });
    db.exec(`INSERT INTO portal_v2_identity_eligibility_blocks
      (id,match_type,normalized_email,reason_code,created_by_actor_type,created_by_actor_id)
      VALUES('block','email','primary@example.test','test','system','test')`);
    expect(permits(guard(selected))).toBe(0);
    await expect(resolveProjectAlphaDeliveryPrincipal(env, prefix, principalId, version)).rejects.toMatchObject({ status: 409 });
  });

  it.each(["membership", "identity", "denial", "subject block"])("rechecks linked %s authority at transaction time", async kind => {
    linked();
    const selected = await resolveProjectAlphaDeliveryPrincipal(env, prefix, principalId, version);
    if (kind === "membership") db.exec("UPDATE portal_v2_workspace_memberships SET revoked_at=datetime('now') WHERE workspace_id='workspace-primary'");
    if (kind === "identity") db.exec("UPDATE portal_v2_identities SET status='suspended' WHERE id='identity-primary'");
    if (kind === "denial") db.exec(`INSERT INTO portal_v2_identity_denials
      (id,identity_id,scope_type,reason_code,created_by_actor_type,created_by_actor_id)
      VALUES('deny','identity-primary','global','test','system','test')`);
    if (kind === "subject block") db.exec(`INSERT INTO portal_v2_identity_eligibility_blocks
      (id,match_type,issuer,subject,reason_code,created_by_actor_type,created_by_actor_id)
      VALUES('block','issuer_subject','https://issuer.test','identity-primary','test','system','test')`);
    expect(permits(guard(selected))).toBe(0);
    await expect(resolveProjectAlphaDeliveryPrincipal(env, prefix, principalId, version)).rejects.toMatchObject({ status: 409 });
  });

  it("rejects ambiguous eligible identities even when they have the same recipient email", async () => {
    linked();
    const selected = await resolveProjectAlphaDeliveryPrincipal(env, prefix, principalId, version);
    db.exec(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email)
      VALUES('identity-other','https://issuer.test','other','primary@example.test');
      INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type)
      VALUES('membership-other','workspace-primary','identity-other','project_alpha');
      INSERT INTO portal_v2_identity_eligibility_bindings
      (identity_id,workspace_id,principal_public_id,principal_source_version,verified_email)
      VALUES('identity-other','workspace-primary','same-principal','principal-v1','primary@example.test');`);
    expect(permits(guard(selected))).toBe(0);
    await expect(resolveProjectAlphaDeliveryPrincipal(env, prefix, principalId, version)).rejects.toMatchObject({ status: 409 });
  });

  it("can be embedded as a receipt-first transaction guard without partial writes", async () => {
    const proof = guard(await resolveProjectAlphaDeliveryPrincipal(env, prefix, principalId, version));
    db.exec("CREATE TABLE receipt_test(id TEXT PRIMARY KEY,allowed INTEGER NOT NULL CHECK(allowed=1)); CREATE TABLE grant_test(id TEXT PRIMARY KEY)");
    db.exec("UPDATE pa_portal_principals SET status='suspended' WHERE workspace_id='workspace-primary'");
    db.exec("BEGIN");
    expect(() => {
      db.prepare(`INSERT INTO receipt_test(id,allowed) SELECT 'receipt',CASE WHEN (${proof.sql}) THEN 1 ELSE 0 END`).run(...proof.bindings);
      db.exec("INSERT INTO grant_test VALUES('grant')");
    }).toThrow(/CHECK constraint failed/);
    db.exec("ROLLBACK");
    expect(db.prepare("SELECT count(*) n FROM receipt_test").get()?.n).toBe(0);
    expect(db.prepare("SELECT count(*) n FROM grant_test").get()?.n).toBe(0);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
