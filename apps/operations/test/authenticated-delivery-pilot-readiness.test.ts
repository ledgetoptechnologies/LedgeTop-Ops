import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { authenticatedDeliveryPilotReadiness } from "../src/worker/authenticated-delivery-pilot-readiness";
import type { Env } from "../src/worker/types";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));

describe("authenticated delivery pilot readiness", { timeout: 180_000, concurrent: false }, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let emptyDb: D1Database;
  let env: Env;
  const workspace = "pilot-workspace", organization = "1".repeat(32);

  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22",
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: { DELIVERY_DB: "pilot-readiness", EMPTY_DB: "pilot-readiness-empty" } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    emptyDb = await runtime.getD1Database("EMPTY_DB") as unknown as D1Database;
    const directory = new URL("../../client/migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) <= "0209").sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
    env = { DELIVERY_DB: db } as Env;
  });
  afterAll(async () => runtime.dispose());

  it("fails closed with typed flag and projection reasons and no identifiers", async () => {
    const result = await authenticatedDeliveryPilotReadiness(env);
    expect(result).toMatchObject({ enabled: false, pilotReady: false, reasons: expect.arrayContaining([
      "hierarchy_disabled", "hierarchy_relations_disabled", "grants_disabled", "authority_mutations_disabled", "creation_disabled",
      "primary_projection_unavailable", "notifications_disabled",
    ]) });
    expect(JSON.stringify(result)).not.toContain(workspace);
    expect(JSON.stringify(result)).not.toContain(organization);
  });

  it("fails closed instead of throwing when the migration schema is absent", async () => {
    const result = await authenticatedDeliveryPilotReadiness({ DELIVERY_DB: emptyDb,
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true", AUTHENTICATED_DELIVERY_GRANTS_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true", PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED: "true",
      AUTHENTICATED_DELIVERY_CREATION_ENABLED: "true", AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED: "true" } as Env);
    expect(result).toMatchObject({ enabled: false, pilotReady: false, reasons: ["schema_unavailable", "notification_schema_unavailable"],
      checks: { schema: { ready: false }, primaryProjection: { activeWorkspaceCount: null }, bindings: { unreceiptedActiveCount: null } } });
  });

  it("separates mutation readiness from notification pilot readiness", async () => {
    env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED = "true";
    env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED = "true";
    env.AUTHENTICATED_DELIVERY_GRANTS_ENABLED = "true";
    env.PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED = "true";
    const snapshot = "pilot-snapshot", directory = "pilot-directory";
    await db.batch([
      db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id)
        VALUES(?,'organization',?,'Pilot','active','project-alpha:primary')`).bind(workspace, organization),
      db.prepare(`INSERT INTO pa_portal_projection_generations(id,workspace_id,source_generation,source_sequence,snapshot_hash,page_count,
        record_count,workspace_root_type,workspace_root_public_id,workspace_display_name,workspace_source_version,workspace_active,status,complete,projection_source_id)
        VALUES(?,?,'source',1,?,1,1,'organization',?,'Pilot','v1',1,'active',1,'project-alpha:primary')`).bind(snapshot, workspace, "a".repeat(64), organization),
      db.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete)
        VALUES(?,?,'source',1,'active',1)`).bind(directory, workspace),
      db.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)`).bind(workspace, directory),
      db.prepare(`INSERT INTO pa_portal_projection_checkpoints(workspace_id,source_generation,source_sequence,snapshot_generation_id)
        VALUES(?,'source',1,?)`).bind(workspace, snapshot),
    ]);
    const result = await authenticatedDeliveryPilotReadiness(env);
    expect(result).toMatchObject({ enabled: true, creationEnabled: false, pilotReady: false,
      checks: { primaryProjection: { ready: true, activeWorkspaceCount: 1 }, bindings: { unreceiptedActiveCount: 0 } } });
    expect(result.reasons).toEqual(["creation_disabled", "notifications_disabled"]);

    env.AUTHENTICATED_DELIVERY_CREATION_ENABLED = "true";
    env.AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED = "true";
    const complete = await authenticatedDeliveryPilotReadiness(env);
    expect(complete).toMatchObject({ enabled: true, creationEnabled: true, pilotReady: true, reasons: [], checks: { notifications: { ready: true } } });
  });

  it("blocks mutation controls when an active Operations binding lacks its 0189 receipt", async () => {
    await db.prepare(`INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version,status)
      VALUES('unreceipted-binding',?,'organization',?,'Jobs/Clients/Pilot/','operations','v1','active')`).bind(workspace, organization).run();
    const result = await authenticatedDeliveryPilotReadiness(env);
    expect(result).toMatchObject({ enabled: false, pilotReady: false, reasons: ["unreceipted_bindings"],
      checks: { bindings: { unreceiptedActiveCount: 1 } } });
    expect(JSON.stringify(result)).not.toContain("unreceipted-binding");
    expect(JSON.stringify(result)).not.toContain("Jobs/Clients/Pilot");
  });
});
