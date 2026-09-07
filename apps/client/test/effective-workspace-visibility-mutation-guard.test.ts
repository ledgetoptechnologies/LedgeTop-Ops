import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readEffectiveWorkspaceVisibilityMutationGuard } from "../src/worker/client-portal/effective-workspace-visibility-mutation-guard";
import type { EffectivePortalWorkspaceContext } from "../src/worker/client-portal/workspace-v2";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const sourceId = "project-alpha:primary";
const workspaceId = "visibility-guard-workspace";
const identityId = "visibility-guard-identity";
const context: EffectivePortalWorkspaceContext = {
  workspaceId, identityId, legacyAccountId: "visibility-guard-account", legacyIdentityId: "visibility-guard-legacy",
  rootType: "organization", rootPublicId: "visibility-guard-org", displayName: "Visibility guard", role: "member", canViewBilling: false,
};

describe("effective workspace visibility mutation guard — migrated D1", { timeout: 120_000 }, () => {
  let runtime: Miniflare;
  let db: D1Database;

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: { DB: "visibility-mutation-guard" } });
    db = await runtime.getD1Database("DB") as unknown as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"));
      if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
    }
    await db.batch([
      db.prepare(`INSERT INTO client_accounts(id,display_name,status,project_alpha_organization_id,project_alpha_source_id)
        VALUES ('visibility-guard-account','Visibility guard','active','visibility-guard-org',?)`).bind(sourceId),
      db.prepare(`INSERT INTO client_identity_links(id,account_id,issuer,subject,email)
        VALUES ('visibility-guard-legacy','visibility-guard-account','https://issuer.test','visibility-guard-subject','visibility@example.test')`),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES ('visibility-guard-account','visibility-guard-legacy','member')"),
      db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,legacy_account_id,display_name,status,project_alpha_source_id)
        VALUES(?,'organization','visibility-guard-org','visibility-guard-account','Visibility guard','active',?)`).bind(workspaceId, sourceId),
      db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status)
        VALUES(?,'https://issuer.test','visibility-guard-subject','visibility@example.test','active')`).bind(identityId),
      db.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status,source_version)
        VALUES('visibility-guard-membership',?,?,'project_alpha','active','member-v1')`).bind(workspaceId, identityId),
      db.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status)
        VALUES(?, 'visibility-guard-principal', ?, 'visibility@example.test', 'Visibility recipient', 'principal-v1', 'active')`).bind(workspaceId, identityId),
      db.prepare(`INSERT INTO portal_v2_identity_eligibility_bindings
        (identity_id,workspace_id,principal_public_id,principal_source_version,verified_email)
        VALUES(?,?, 'visibility-guard-principal','principal-v1','visibility@example.test')`).bind(identityId, workspaceId),
      db.prepare(`INSERT INTO portal_v2_identity_eligibility_legacy_bridges
        (workspace_id,identity_id,legacy_account_id,legacy_identity_id,status)
        VALUES(?,?, 'visibility-guard-account','visibility-guard-legacy','active')`).bind(workspaceId, identityId),
      db.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
        VALUES('visibility-guard-view',?,?,'workspace.view','allow','workspace',?,'project_alpha','active')`).bind(workspaceId, identityId, workspaceId),
    ]);
  }, 110_000);
  afterAll(async () => runtime?.dispose());

  const guardFor = () => readEffectiveWorkspaceVisibilityMutationGuard({ DELIVERY_DB: db }, context);
  const allows = async (guard: Awaited<ReturnType<typeof guardFor>>) => {
    return (await db.prepare(`SELECT 1 allowed WHERE ${guard.sql}`).bind(...guard.bindings).first("allowed")) === 1;
  };

  it("allows a current workspace.view grant and rejects a revoked or denied view at write time", async () => {
    // Disable the separate default-on shell route: this case verifies the
    // ordinary entitlement branch rather than the guard's intentional shell OR.
    await db.prepare("UPDATE portal_v2_identity_eligibility_legacy_bridges SET revoked_at=datetime('now') WHERE workspace_id=?").bind(workspaceId).run();
    const entitlementGuard = await guardFor();
    expect(await allows(entitlementGuard)).toBe(true);
    await db.prepare("UPDATE portal_v2_entitlements SET revoked_at=datetime('now') WHERE id='visibility-guard-view'").run();
    expect(await allows(entitlementGuard)).toBe(false);
    await db.prepare("UPDATE portal_v2_entitlements SET revoked_at=NULL WHERE id='visibility-guard-view'").run();
    const denyGuard = await guardFor();
    expect(await allows(denyGuard)).toBe(true);
    await db.prepare(`INSERT INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
      VALUES('visibility-guard-deny',?,?,'workspace.view','deny','workspace',?,'project_alpha','active')`).bind(workspaceId, identityId, workspaceId).run();
    expect(await allows(denyGuard)).toBe(false);
    await db.prepare("UPDATE portal_v2_entitlements SET revoked_at=datetime('now') WHERE id='visibility-guard-deny'").run();
    expect(await allows(denyGuard)).toBe(true);
    await db.prepare("UPDATE portal_v2_identity_eligibility_legacy_bridges SET revoked_at=NULL WHERE workspace_id=?").bind(workspaceId).run();
  });

  it("permits only a currently matching default-on eligibility shell without workspace.view", async () => {
    await db.prepare("UPDATE portal_v2_identity_eligibility_legacy_bridges SET revoked_at=NULL WHERE workspace_id=?").bind(workspaceId).run();
    await db.prepare("UPDATE portal_v2_entitlements SET revoked_at=datetime('now') WHERE id='visibility-guard-view'").run();
    const shellGuard = await guardFor();
    expect(await allows(shellGuard)).toBe(true);
    await db.prepare("UPDATE portal_v2_identity_eligibility_legacy_bridges SET revoked_at=datetime('now') WHERE workspace_id=?").bind(workspaceId).run();
    expect(await allows(shellGuard)).toBe(false);
    await db.prepare("UPDATE portal_v2_identity_eligibility_legacy_bridges SET revoked_at=NULL WHERE workspace_id=?").bind(workspaceId).run();
    const principalGuard = await guardFor();
    expect(await allows(principalGuard)).toBe(true);
    await db.prepare("UPDATE pa_portal_principals SET source_version='principal-v2' WHERE workspace_id=? AND public_id='visibility-guard-principal'").bind(workspaceId).run();
    expect(await allows(principalGuard)).toBe(false);
    await db.prepare("UPDATE pa_portal_principals SET source_version='principal-v1' WHERE workspace_id=? AND public_id='visibility-guard-principal'").bind(workspaceId).run();
    const emailGuard = await guardFor();
    expect(await allows(emailGuard)).toBe(true);
    await db.prepare("UPDATE portal_v2_identities SET verified_email='rebound@example.test' WHERE id=?").bind(identityId).run();
    expect(await allows(emailGuard)).toBe(false);
  });
});
