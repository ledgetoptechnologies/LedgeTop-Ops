import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveClientHubWorkspace, resolveClientHubWorkspaces, type ClientHubWorkspaceLookup } from "../src/worker/client-hub-workspace";
import type { Env } from "../src/worker/types";

const publicId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const lookup: ClientHubWorkspaceLookup = { key: "101", source_id: "project-alpha:primary", kind: "organization",
  business_id: "101", pa_public_id: publicId, workspace_id: null };

describe("explicit Client Hub workspace provenance", () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Pick<Env, "DELIVERY_DB">;
  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default { fetch(){return new Response('ok')} }", d1Databases: { DELIVERY_DB: "hub-workspace" } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    env = { DELIVERY_DB: db };
    await db.exec(`
      CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,root_type TEXT,display_name TEXT,status TEXT,
        legacy_account_id TEXT,pa_organization_public_id TEXT,pa_client_public_id TEXT,project_alpha_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE client_accounts(id TEXT PRIMARY KEY,status TEXT,project_alpha_organization_id TEXT,project_alpha_client_id TEXT,project_alpha_source_id TEXT);
      CREATE TABLE portal_v2_directory_generations(id TEXT PRIMARY KEY,workspace_id TEXT,source_generation TEXT,source_sequence INTEGER,status TEXT,complete INTEGER);
      CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT PRIMARY KEY,active_generation_id TEXT,source_sequence INTEGER);
      CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,parent_public_id TEXT,active INTEGER,source_version TEXT);
      CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT PRIMARY KEY,projection_source_id TEXT,source_workspace_id TEXT);
      CREATE TABLE pa_portal_source_authorities(source_id TEXT PRIMARY KEY,state TEXT,active_revision INTEGER);
      CREATE TABLE pa_portal_source_authority_revisions(source_id TEXT,revision INTEGER);
    `.replace(/\s*\n\s*/g, " "));
  });
  beforeEach(async () => {
    await db.batch(["portal_v2_directory_entities", "portal_v2_directory_checkpoints", "portal_v2_directory_generations",
      "portal_v2_workspaces", "client_accounts", "pa_portal_workspace_sources", "pa_portal_source_authority_revisions", "pa_portal_source_authorities"]
      .map(table => db.prepare(`DELETE FROM ${table}`)));
  });
  afterAll(async () => runtime.dispose());

  async function workspace(id: string, root: string, legacy = false, proven = true, source = "project-alpha:primary") {
    await db.prepare("INSERT INTO portal_v2_workspaces VALUES(?,'organization',?,'active',?,?,NULL,?)")
      .bind(id, id, legacy ? `account-${id}` : null, root, source).run();
    if (legacy) await db.prepare("INSERT INTO client_accounts VALUES(?,'active',?,NULL,'project-alpha:primary')").bind(`account-${id}`, root).run();
    if (!proven) return;
    await db.batch([
      db.prepare("INSERT INTO portal_v2_directory_generations VALUES(?,?,?,?, 'active',1)")
        .bind(`generation-${id}`, id, legacy ? "legacy-backfill" : "native-generation", legacy ? 0 : 1),
      db.prepare("INSERT INTO portal_v2_directory_checkpoints VALUES(?,?,?)").bind(id, `generation-${id}`, legacy ? 0 : 1),
      db.prepare("INSERT INTO portal_v2_directory_entities VALUES(?,?,'organization',?,NULL,1,?)")
        .bind(id, `generation-${id}`, root, legacy ? "legacy-backfill" : "source-version"),
    ]);
  }

  it("maps a numeric business ID only through its explicit source-issued native public ID", async () => {
    await workspace("native", publicId);
    await workspace("numeric-lookalike", "101");
    expect(await resolveClientHubWorkspace(env, lookup)).toMatchObject({ status: "mapped", workspace: { id: "native" } });
    expect(await resolveClientHubWorkspace(env, { ...lookup, pa_public_id: null })).toEqual({ status: "missing", workspace: null });
  });

  it("never borrows a secondary Delivery account's same-ID legacy bridge for the primary business root", async () => {
    await workspace("secondary", "101", true);
    await db.prepare("UPDATE client_accounts SET project_alpha_source_id='project-alpha:secondary' WHERE id='account-secondary'").run();
    expect(await resolveClientHubWorkspace(env, { ...lookup, pa_public_id: null })).toEqual({ status: "missing", workspace: null });
    expect(await resolveClientHubWorkspace(env, { ...lookup, business_id: null, workspace_id: "secondary" })).toEqual({ status: "missing", workspace: null });
  });

  it("ignores unbridged secondary native roots with identical public IDs", async () => {
    await workspace("secondary", publicId, false, true, "project-alpha:secondary");
    expect(await resolveClientHubWorkspace(env, lookup)).toEqual({ status: "missing", workspace: null });
    expect(await resolveClientHubWorkspace(env, { ...lookup, workspace_id: "secondary" })).toEqual({ status: "missing", workspace: null });
    await workspace("primary", publicId);
    expect(await resolveClientHubWorkspace(env, lookup)).toMatchObject({ status: "mapped", workspace: { id: "primary" } });
  });

  it("maps a secondary native workspace only with exact ownership and active source authority", async () => {
    const secondary = { ...lookup, source_id: "project-alpha:secondary" };
    await workspace("secondary", publicId, false, true, secondary.source_id);
    expect(await resolveClientHubWorkspace(env, secondary)).toEqual({ status: "missing", workspace: null });
    await db.prepare("INSERT INTO pa_portal_workspace_sources VALUES('secondary','project-alpha:secondary','source-workspace')").run();
    expect(await resolveClientHubWorkspace(env, secondary)).toEqual({ status: "missing", workspace: null });
    await db.batch([
      db.prepare("INSERT INTO pa_portal_source_authorities VALUES('project-alpha:secondary','active',1)"),
      db.prepare("INSERT INTO pa_portal_source_authority_revisions VALUES('project-alpha:secondary',1)"),
    ]);
    expect(await resolveClientHubWorkspace(env, secondary)).toMatchObject({ status: "mapped",
      workspace: { id: "secondary", project_alpha_source_id: "project-alpha:secondary", legacy_account_id: null } });
    await db.prepare("UPDATE pa_portal_source_authorities SET state='suspended'").run();
    expect(await resolveClientHubWorkspace(env, secondary)).toEqual({ status: "missing", workspace: null });
  });

  it("never crosses sources when public IDs collide or accepts a secondary legacy bridge", async () => {
    await workspace("primary", publicId);
    await workspace("secondary", publicId, false, true, "project-alpha:secondary");
    await db.batch([
      db.prepare("INSERT INTO pa_portal_workspace_sources VALUES('secondary','project-alpha:secondary','source-workspace')"),
      db.prepare("INSERT INTO pa_portal_source_authorities VALUES('project-alpha:secondary','active',1)"),
      db.prepare("INSERT INTO pa_portal_source_authority_revisions VALUES('project-alpha:secondary',1)"),
    ]);
    expect(await resolveClientHubWorkspace(env, lookup)).toMatchObject({ workspace: { id: "primary" } });
    expect(await resolveClientHubWorkspace(env, { ...lookup, source_id: "project-alpha:secondary" }))
      .toMatchObject({ workspace: { id: "secondary" } });
    await db.prepare("UPDATE portal_v2_workspaces SET legacy_account_id='account-secondary' WHERE id='secondary'").run();
    await db.prepare("INSERT INTO client_accounts VALUES('account-secondary','active','101',NULL,'project-alpha:secondary')").run();
    expect(await resolveClientHubWorkspace(env, { ...lookup, source_id: "project-alpha:secondary" }))
      .toEqual({ status: "missing", workspace: null });
  });

  it("recognizes a legacy workspace only with its current account bridge and selected legacy proof", async () => {
    await workspace("legacy", "101", true);
    expect(await resolveClientHubWorkspace(env, { ...lookup, pa_public_id: null })).toMatchObject({ status: "mapped", workspace: { id: "legacy" } });
    await db.prepare("UPDATE client_accounts SET project_alpha_organization_id='202'").run();
    expect(await resolveClientHubWorkspace(env, lookup)).toEqual({ status: "missing", workspace: null });
  });

  it("reports pending without hydrating an unproven exact candidate", async () => {
    await workspace("legacy", "101", true, false);
    expect(await resolveClientHubWorkspace(env, lookup)).toEqual({ status: "pending", workspace: null });
    expect(await resolveClientHubWorkspace(env, { ...lookup, business_id: null, workspace_id: "legacy" })).toEqual({ status: "pending", workspace: null });
  });

  it("does not accept a stale or incomplete generation checkpoint", async () => {
    await workspace("native", publicId);
    await db.prepare("UPDATE portal_v2_directory_generations SET complete=0").run();
    expect(await resolveClientHubWorkspace(env, lookup)).toEqual({ status: "pending", workspace: null });
    await db.prepare("UPDATE portal_v2_directory_generations SET complete=1,source_sequence=2").run();
    expect(await resolveClientHubWorkspace(env, lookup)).toEqual({ status: "pending", workspace: null });
  });

  it("fails closed when native and legacy workspaces both claim the business root", async () => {
    await workspace("native", publicId);
    await workspace("legacy", "101", true);
    expect(await resolveClientHubWorkspace(env, lookup)).toEqual({ status: "conflict", workspace: null });
  });

  it("does not interpret legacy internal IDs as a different business's public ID", async () => {
    await workspace("legacy", publicId, true);
    expect(await resolveClientHubWorkspace(env, lookup)).toEqual({ status: "pending", workspace: null });
    expect(await resolveClientHubWorkspace(env, { ...lookup, business_id: publicId, pa_public_id: null }))
      .toMatchObject({ status: "mapped", workspace: { id: "legacy" } });
  });

  it("resolves exact portal namespace IDs independently and keeps batch input roots separate", async () => {
    await workspace("portal-only", publicId);
    const result = await resolveClientHubWorkspaces(env, [
      { ...lookup, key: "portal", business_id: null, pa_public_id: null, workspace_id: "portal-only" },
      { ...lookup, key: "unrelated", business_id: "202", pa_public_id: null },
    ]);
    expect(result.get("portal")).toMatchObject({ status: "mapped", workspace: { id: "portal-only" } });
    expect(result.get("unrelated")).toEqual({ status: "missing", workspace: null });
    await db.prepare("UPDATE portal_v2_workspaces SET status='closed'").run();
    expect(await resolveClientHubWorkspace(env, { ...lookup, business_id: null, workspace_id: "portal-only" }))
      .toEqual({ status: "missing", workspace: null });
  });
});
