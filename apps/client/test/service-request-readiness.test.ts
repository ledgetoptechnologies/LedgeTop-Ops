import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClientPortalRouter } from "../src/worker/client-portal/routes";
import { d1ClientPortalRepository } from "../src/worker/client-portal/repository";
import type { ClientPortalRepository, VerifiedClientPrincipal } from "../src/worker/client-portal/types";
import type { ClientRequestReadiness } from "../src/worker/client-portal/request-readiness";
import { readEffectiveWorkspaceRequestProof } from "../src/worker/client-portal/workspace-v2";
import type { Env } from "../src/worker/types";

const origin = "https://client.test";
const principal: VerifiedClientPrincipal = {
  issuer: "https://team.cloudflareaccess.com", subject: "readiness-a", email: "a@example.test",
};
const headers = { "X-LTDS-Workspace-Id": "workspace-account-a" };

// Real authorization traverses multiple primary-session reads through Miniflare's
// Windows IPC bridge; retain a bounded integration timeout without changing app timeouts.
describe("request readiness against migrated D1 and real authorization", { timeout: 60_000 }, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;

  async function migration(name: string) {
    const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")
      .replace(/\r\n/g, "\n").replace(/^\s*--.*$/gm, "");
    if (/CREATE\s+TRIGGER/i.test(sql)) {
      await db.exec(sql.replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "").replace(/\s*\n\s*/g, " "));
      return;
    }
    const statements = sql.split(/;\s*(?:\n|$)/).map(value => value.trim())
      .filter(value => value && !/^PRAGMA\s+foreign_keys\s*=\s*ON$/i.test(value))
      .map(value => db.prepare(value));
    // Rebuild migrations must retain their transaction boundaries.
    if (statements.length) await db.batch(statements);
  }

  beforeAll(async () => {
    runtime = new Miniflare({
      compatibilityDate: "2026-07-16", modules: true,
      script: "export default { fetch() { return new Response('fixture'); } };",
      d1Databases: { DELIVERY_DB: "request-readiness" },
    });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
    for (const name of readdirSync(directory).filter(name => name.endsWith(".sql")).sort()) await migration(name);
    await db.batch([
      db.prepare("INSERT INTO client_accounts(id,display_name,status,project_alpha_organization_id) VALUES ('account-a','Example client','active','pa-org-a'),('account-b','Other client','active','pa-org-b')"),
      db.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES ('identity-a','account-a',?,?,?),('identity-b','account-b',?,'readiness-b','b@example.test')")
        .bind(principal.issuer, principal.subject, principal.email, principal.issuer),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES ('account-a','identity-a','manager'),('account-b','identity-b','manager')"),
      db.prepare("INSERT INTO projects(id,project_alpha_project_id,client_name,project_name,r2_prefix) VALUES ('project-a','pa-project-a','Example client','Allowed project','clients/a/'),('project-b','pa-project-b','Other client','Private project','clients/b/')"),
      db.prepare("INSERT INTO client_project_grants(account_id,project_id,can_request_service) VALUES ('account-a','project-a',1),('account-b','project-b',1)"),
      db.prepare("INSERT INTO client_member_project_grants(account_id,identity_id,project_id,granted_by_identity_id) VALUES ('account-a','identity-a','project-a','identity-a')"),
      db.prepare("INSERT INTO pa_service_catalog_items(public_id,source_version,name,category,source_updated_at) VALUES ('service-a','version-1','Survey','Mapping',datetime('now'))"),
    ]);
    // Exercise the production upgrade's exact legacy-to-workspace projection.
    await migration("0121_client_workspace_hierarchy_v2.sql");
    await db.prepare("INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version) SELECT id,workspace_id,2 FROM portal_v2_directory_generations").run();
    await db.prepare(`INSERT INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
      VALUES ('root-request','workspace-account-a','identity-a','request.create','allow','workspace','workspace-account-a','operations','revoked')`).run();
    env = {
      DELIVERY_DB: db, CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_REQUEST_V2_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true", CLIENT_PORTAL_ORIGIN: origin, ENVIRONMENT: "development",
      PUBLIC_BULK_RATE_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
    } as Env;
  }, 60_000);

  afterAll(async () => runtime?.dispose());
  beforeEach(async () => {
    await db.batch([
      db.prepare("UPDATE client_accounts SET status='active'"),
      db.prepare("UPDATE client_identity_links SET revoked_at=NULL"),
      db.prepare("UPDATE client_account_members SET role='manager',revoked_at=NULL"),
      db.prepare("UPDATE projects SET active=1"),
      db.prepare("UPDATE client_project_grants SET revoked_at=NULL,can_request_service=1"),
      db.prepare("UPDATE client_member_project_grants SET revoked_at=NULL"),
      db.prepare("UPDATE pa_service_catalog_items SET active=1"),
      db.prepare("UPDATE portal_v2_identities SET status='active',revoked_at=NULL"),
      db.prepare("UPDATE portal_v2_workspaces SET status='active'"),
      db.prepare("UPDATE portal_v2_workspace_memberships SET status='active',revoked_at=NULL,expires_at=NULL"),
      db.prepare("UPDATE portal_v2_entitlements SET status=CASE WHEN id='root-request' THEN 'revoked' ELSE 'active' END,revoked_at=NULL,expires_at=NULL"),
    ]);
  });

  function router(repository: ClientPortalRepository = d1ClientPortalRepository) {
    return createClientPortalRouter({ resolvePrincipal: async () => principal, repository });
  }
  async function readiness(projectId: string | null = null, overrides: Partial<Env> = {}, requestHeaders: Record<string, string> = headers) {
    const response = await router().request(`${origin}/request-readiness${projectId === null ? "" : `?projectId=${encodeURIComponent(projectId)}`}`, {
      headers: requestHeaders,
    }, { ...env, ...overrides });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    return await response.json() as ClientRequestReadiness;
  }

  it("distinguishes an allowed project from unavailable standalone request authority", async () => {
    expect(await readiness()).toMatchObject({
      mode: "catalog", workspaceId: "workspace-account-a", target: { kind: "root", projectId: null },
      canStartRequest: false, reason: "request_not_permitted", projectRequestsSupported: true,
      root: { canStartRequest: false, reason: "request_not_permitted" },
    });
    expect(await readiness("project-a")).toMatchObject({
      target: { kind: "project", projectId: "project-a" }, canStartRequest: true, reason: "ready",
      root: { canStartRequest: false },
    });
  });

  it("requires a separate root entitlement rather than inferring it from manager status", async () => {
    await db.prepare("UPDATE portal_v2_entitlements SET status='active' WHERE id='root-request'").run();
    expect(await readiness()).toMatchObject({ canStartRequest: true, root: { canStartRequest: true, reason: "ready" } });
  });

  it("keeps the legacy form enabled when the catalog feature is off", async () => {
    await db.prepare("UPDATE pa_service_catalog_items SET active=0").run();
    expect(await readiness("project-a", { CLIENT_PORTAL_REQUEST_V2_ENABLED: "false" })).toMatchObject({
      mode: "legacy", canStartRequest: true, reason: "ready", projectRequestsSupported: true,
    });
    expect(await readiness(null, { CLIENT_PORTAL_REQUEST_V2_ENABLED: "false", CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "false" }, {})).toMatchObject({
      workspaceId: null, mode: "legacy", canStartRequest: true,
    });
  });

  it("does not promise a catalog request when no published services are available", async () => {
    await db.prepare("UPDATE pa_service_catalog_items SET active=0").run();
    expect(await readiness("project-a")).toMatchObject({ canStartRequest: false, reason: "catalog_unavailable", projectRequestsSupported: false });
  });

  it("does not promise a legacy request when its required rate limiter is absent", async () => {
    expect(await readiness("project-a", { CLIENT_PORTAL_REQUEST_V2_ENABLED: "false", PUBLIC_BULK_RATE_LIMITER: undefined })).toMatchObject({
      mode: "legacy", canStartRequest: false, reason: "request_unavailable", projectRequestsSupported: false,
    });
  });

  it("does not promise a catalog request with an incomplete repository contract", async () => {
    const response = await router({ ...d1ClientPortalRepository, createServiceRequestDraft: undefined }).request(`${origin}/request-readiness?projectId=project-a`, { headers }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ canStartRequest: false, reason: "request_unavailable", projectRequestsSupported: false });
  });

  it.each([
    "UPDATE projects SET active=0 WHERE id='project-a'",
    "UPDATE client_project_grants SET can_request_service=0 WHERE project_id='project-a'",
    "UPDATE client_project_grants SET revoked_at=datetime('now') WHERE project_id='project-a'",
    "UPDATE portal_v2_entitlements SET status='revoked' WHERE capability='request.create'",
  ])("intersects current local project authority and selected-workspace grants: %s", async statement => {
    await db.prepare(statement).run();
    expect(await readiness("project-a")).toMatchObject({ canStartRequest: false });
  });

  it("requires the member's own current project grant, not only the account grant", async () => {
    await db.prepare("UPDATE client_account_members SET role='member' WHERE identity_id='identity-a'").run();
    expect(await readiness("project-a")).toMatchObject({ canStartRequest: true });
    await db.prepare("UPDATE client_member_project_grants SET revoked_at=datetime('now') WHERE identity_id='identity-a'").run();
    expect(await readiness("project-a")).toMatchObject({ canStartRequest: false });
  });

  it.each([
    "UPDATE client_accounts SET status='suspended' WHERE id='account-a'",
    "UPDATE client_identity_links SET revoked_at=datetime('now') WHERE id='identity-a'",
    "UPDATE client_account_members SET revoked_at=datetime('now') WHERE identity_id='identity-a'",
    "UPDATE portal_v2_workspace_memberships SET status='suspended' WHERE identity_id='identity-a'",
    "UPDATE portal_v2_workspace_memberships SET expires_at=datetime('now','-1 hour') WHERE identity_id='identity-a'",
  ])("rejects stale sessions before readiness: %s", async statement => {
    await db.prepare(statement).run();
    const response = await router().request(`${origin}/request-readiness?projectId=project-a`, { headers }, env);
    expect(response.status).toBe(403);
  });

  it("does not disclose another client's project or let a header switch to their workspace", async () => {
    const unavailable = await readiness("project-b");
    expect(unavailable.canStartRequest).toBe(false);
    expect(JSON.stringify(unavailable)).not.toContain("Private project");
    const response = await router().request(`${origin}/request-readiness`, { headers: { "X-LTDS-Workspace-Id": "workspace-account-b" } }, env);
    expect(response.status).toBe(403);
  });

  it("rejects malformed target ids rather than treating them as standalone requests", async () => {
    const response = await router().request(`${origin}/request-readiness?projectId=${"a".repeat(300)}`, { headers }, env);
    expect(response.status).toBe(400);
  });

  it("readiness issues no grants, creates no draft, and queues no external action", async () => {
    const counts = async () => {
      const tables = ["portal_v2_entitlements", "portal_v2_workspace_memberships", "client_service_request_drafts", "client_access_sync_outbox", "client_portal_notification_outbox"];
      return Promise.all(tables.map(table => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first("count")));
    };
    const before = await counts();
    await readiness("project-a");
    expect(await counts()).toEqual(before);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("reauthorizes the mutation if permission is revoked after a ready result", async () => {
    expect(await readiness("project-a")).toMatchObject({ canStartRequest: true });
    await db.prepare("UPDATE client_project_grants SET can_request_service=0 WHERE project_id='project-a'").run();
    const response = await router().request(`${origin}/service-request-drafts`, {
      method: "POST", headers: { ...headers, Origin: origin, "Content-Type": "application/json", "Idempotency-Key": "readiness-revoked-draft-0001" },
      body: JSON.stringify({
        projectId: "project-a", requestType: "service", title: "Survey request", details: "Please survey this site.",
        location: null, preferredStartAt: null, deliverables: null, siteContactName: null, siteContactEmail: null,
        siteContactPhone: null, desiredCompletionAt: null, latitude: null, longitude: null, areaGeoJson: null, poiPoints: [],
        services: [{ publicId: "service-a", sourceVersion: "version-1", answers: {} }],
      }),
    }, env);
    expect(response.status).toBe(404);
    expect(await db.prepare("SELECT COUNT(*) count FROM client_service_request_drafts").first("count")).toBe(0);
  });
  it("honors an exact project deny without denying the independently authorized root", async () => {
    await db.batch([
      db.prepare("UPDATE portal_v2_entitlements SET status='active' WHERE id='root-request'"),
      db.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
        VALUES ('readiness-exact-deny','workspace-account-a','identity-a','request.create','deny','project','pa-project-a','operations','active')`),
    ]);
    try {
      expect(await readiness("project-a")).toMatchObject({
        canStartRequest: false, reason: "project_unavailable", root: { canStartRequest: true },
      });
      // Delivery remains visible, but neither the list nor a direct project
      // URL may advertise request access after the native deny is applied.
      const list = await router().request(`${origin}/projects`, { headers }, env);
      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject({ projects: [{ id: "project-a", canRequestService: false }] });
      const detail = await router().request(`${origin}/projects/project-a`, { headers }, env);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ project: { id: "project-a", canRequestService: false } });
    } finally {
      await db.prepare("DELETE FROM portal_v2_entitlements WHERE id='readiness-exact-deny'").run();
    }
  });

  it("fails closed when the selected directory generation is no longer complete", async () => {
    await db.prepare("UPDATE portal_v2_directory_generations SET complete=0 WHERE workspace_id='workspace-account-a'").run();
    try {
      const response = await router().request(`${origin}/request-readiness?projectId=project-a`, { headers }, env);
      expect(response.status).toBe(403);
    } finally {
      await db.prepare("UPDATE portal_v2_directory_generations SET complete=1 WHERE workspace_id='workspace-account-a'").run();
    }
  });

  it.each(["role", "permission"] as const)("rejects a %s change between readiness reads", async change => {
    let changed = false;
    const wrapStatement = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrapStatement(target.bind(...values), sql);
        if (property === "first") return async (column?: string) => {
          const value = column === undefined ? await target.first() : await target.first(column);
          // This bounded catalog read ends the first readiness snapshot, after
          // middleware and its current root/project authority checks.
          if (!changed && sql.includes("SELECT 1 available FROM pa_service_catalog_items")) {
            changed = true;
            await db.prepare(change === "role"
              ? "UPDATE client_account_members SET role='member' WHERE identity_id='identity-a'"
              : "UPDATE portal_v2_entitlements SET status='revoked' WHERE identity_id='identity-a' AND capability='request.create'").run();
          }
          return value;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const racedDb = new Proxy(db, {
      get(target, property) {
        if (property === "withSession") return (...values: Parameters<D1Database["withSession"]>) => new Proxy(target.withSession(...values), {
          get(session, sessionProperty) {
            if (sessionProperty === "prepare") return (sql: string) => wrapStatement(session.prepare(sql), sql);
            const value = Reflect.get(session, sessionProperty, session);
            return typeof value === "function" ? value.bind(session) : value;
          },
        });
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      const response = await router().request(`${origin}/request-readiness?projectId=project-a`, { headers }, { ...env, DELIVERY_DB: racedDb });
      expect(changed).toBe(true);
      expect(response.status).toBe(409);
      // This router is mounted without the outer Worker's JSON error mapper.
      expect(await response.text()).toContain("Request access changed");
    } finally {
      await db.batch([
        db.prepare("UPDATE client_account_members SET role='manager' WHERE identity_id='identity-a'"),
        db.prepare("UPDATE portal_v2_entitlements SET status=CASE WHEN id='root-request' THEN 'revoked' ELSE 'active' END WHERE identity_id='identity-a' AND capability='request.create'"),
      ]);
    }
  });
  it.each([null, "project-a"])("bounds total authorization queries for the %s readiness target", async projectId => {
    let queryCount = 0;
    const countedDb = new Proxy(db, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => {
          queryCount += 1;
          return target.prepare(sql);
        };
        if (property === "withSession") return (...values: Parameters<D1Database["withSession"]>) => new Proxy(target.withSession(...values), {
          get(session, sessionProperty) {
            if (sessionProperty === "prepare") return (sql: string) => {
              queryCount += 1;
              return session.prepare(sql);
            };
            const value = Reflect.get(session, sessionProperty, session);
            return typeof value === "function" ? value.bind(session) : value;
          },
        });
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const response = await router().request(`${origin}/request-readiness${projectId ? `?projectId=${projectId}` : ""}`, { headers }, {
      ...env, DELIVERY_DB: countedDb,
    });
    expect(response.status).toBe(200);
    expect(queryCount).toBeGreaterThan(0);
    // Includes full auth middleware, both fresh proofs, and both catalog reads.
    expect(queryCount).toBeLessThanOrEqual(projectId ? 40 : 35);
  });

  it("retains the fail-closed per-capability rule overflow limit in the shared proof", async () => {
    await db.batch(Array.from({ length: 200 }, (_, index) => db.prepare(`INSERT INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status,entitlement_version)
      VALUES (?,'workspace-account-a','identity-a','request.create','allow','workspace','workspace-account-a','operations','active',?)`)
      .bind(`readiness-overflow-${index}`, index + 2)));
    try {
      // The migrated project rule plus these 200 additional rules exceed the
      // same 200-rule limit used by the original capability evaluator.
      expect(await readiness("project-a")).toMatchObject({
        canStartRequest: false, root: { canStartRequest: false },
      });
    } finally {
      await db.prepare("DELETE FROM portal_v2_entitlements WHERE id LIKE 'readiness-overflow-%'").run();
    }
  });
  it.each(["missing_optional_tables", "database_error"] as const)("handles %s without broadening request authority", async mode => {
    const optionalTables = new Set([
      "portal_v2_identity_eligibility_bindings", "portal_v2_identity_eligibility_blocks",
      "portal_v2_identity_eligibility_legacy_bridges", "portal_v2_legacy_member_bridges",
    ]);
    const prepare = (database: Pick<D1Database, "prepare">, sql: string): D1PreparedStatement => {
      if (mode === "database_error" && sql.includes("portal_identity.id identity_id"))
        throw new Error("database authorization failed");
      if (mode === "missing_optional_tables") {
        const missing = [...optionalTables].find(table => new RegExp(`\\b(?:FROM|JOIN)\\s+${table}\\b`, "i").test(sql));
        if (missing) throw new Error(`D1_ERROR: no such table: ${missing}`);
      }
      const statement = database.prepare(sql);
      if (mode !== "missing_optional_tables" || !sql.includes("SELECT name FROM sqlite_master")) return statement;
      return new Proxy(statement, {
        get(target, property) {
          if (property === "all") return async () => {
            const result = await target.all<{ name: string }>();
            return { ...result, results: result.results.filter(row => !optionalTables.has(row.name)) };
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    const compatibilityDb = new Proxy(db, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => prepare(target, sql);
        if (property === "withSession") return (...values: Parameters<D1Database["withSession"]>) => new Proxy(target.withSession(...values), {
          get(session, sessionProperty) {
            if (sessionProperty === "prepare") return (sql: string) => prepare(session, sql);
            const value = Reflect.get(session, sessionProperty, session);
            return typeof value === "function" ? value.bind(session) : value;
          },
        });
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    // The actual migrated-D1 account/project/grant rows remain authoritative;
    // the proxy models only exact missing optional tables or a storage error.
    const response = await router().request(`${origin}/request-readiness?projectId=project-a`, { headers }, {
      ...env, DELIVERY_DB: compatibilityDb,
    });
    if (mode === "database_error") expect(response.status).toBe(500);
    else {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ canStartRequest: true, reason: "ready" });
    }
  });
  it("never borrows another identity's eligible shell in the same workspace", async () => {
    await db.batch([
      db.prepare(`INSERT INTO client_identity_links(id,account_id,issuer,subject,email)
        VALUES ('other-local','account-a','eligibility-readiness-test','identity-b','b@example.test')`),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES ('account-a','other-local','member')"),
      db.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status)
        VALUES ('other-shell-membership','workspace-account-a','identity-b','operations','active')`),
      db.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status)
        VALUES ('workspace-account-a','other-shell-principal','identity-b','b@example.test','Other contact','1','active')`),
      db.prepare(`INSERT INTO portal_v2_identity_eligibility_bindings
        (identity_id,workspace_id,principal_public_id,principal_source_version,verified_email)
        VALUES ('identity-b','workspace-account-a','other-shell-principal','1','b@example.test')`),
      db.prepare(`INSERT INTO portal_v2_identity_eligibility_legacy_bridges
        (workspace_id,identity_id,legacy_account_id,legacy_identity_id)
        VALUES ('workspace-account-a','identity-b','account-a','other-local')`),
      db.prepare("UPDATE portal_v2_entitlements SET status='revoked' WHERE identity_id='identity-a' AND capability='workspace.view'"),
    ]);
    try {
      const other = await readEffectiveWorkspaceRequestProof(env, {
        issuer: principal.issuer, subject: "readiness-b", email: "b@example.test",
      }, "workspace-account-a", null);
      expect(other?.workspace.identityId).toBe("identity-b");
      expect(other?.rootAllowed).toBe(false);
      expect(await readEffectiveWorkspaceRequestProof(env, principal, "workspace-account-a", "project-a")).toBeNull();
    } finally {
      await db.batch([
        db.prepare("DELETE FROM pa_portal_principals WHERE workspace_id='workspace-account-a' AND public_id='other-shell-principal'"),
        db.prepare("DELETE FROM portal_v2_workspace_memberships WHERE id='other-shell-membership'"),
        db.prepare("DELETE FROM client_account_members WHERE identity_id='other-local'"),
        db.prepare("DELETE FROM client_identity_links WHERE id='other-local'"),
        db.prepare("UPDATE portal_v2_entitlements SET status='active' WHERE identity_id='identity-a' AND capability='workspace.view'"),
      ]);
    }
  });
  it.each(["eligibility", "invitation"] as const)("uses the exact active %s bridge and its local project membership", async bridgeKind => {
    const originalSource = await db.prepare("SELECT source_type FROM portal_v2_workspace_memberships WHERE workspace_id='workspace-account-a' AND identity_id='identity-a'").first<string>("source_type");
    await db.batch([
      db.prepare(`INSERT INTO client_identity_links(id,account_id,issuer,subject,email)
        VALUES ('readiness-bridge-local','account-a','readiness-synthetic','identity-a','a@example.test')`),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES ('account-a','readiness-bridge-local','member')"),
      db.prepare(`INSERT INTO client_member_project_grants(account_id,identity_id,project_id,granted_by_identity_id)
        VALUES ('account-a','readiness-bridge-local','project-a','identity-a')`),
      ...(bridgeKind === "eligibility" ? [
        db.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status)
          VALUES ('workspace-account-a','readiness-bridge-principal','identity-a','a@example.test','Eligible contact','1','active')`),
        db.prepare(`INSERT INTO portal_v2_identity_eligibility_bindings
          (identity_id,workspace_id,principal_public_id,principal_source_version,verified_email)
          VALUES ('identity-a','workspace-account-a','readiness-bridge-principal','1','a@example.test')`),
        db.prepare(`INSERT INTO portal_v2_identity_eligibility_legacy_bridges
          (workspace_id,identity_id,legacy_account_id,legacy_identity_id)
          VALUES ('workspace-account-a','identity-a','account-a','readiness-bridge-local')`),
      ] : [
        db.prepare("UPDATE portal_v2_workspace_memberships SET source_type='client_invitation' WHERE workspace_id='workspace-account-a' AND identity_id='identity-a'"),
        db.prepare(`INSERT INTO portal_v2_invitations
          (id,workspace_id,token_hash,invited_email,invited_by_identity_id,status,expires_at,accepted_by_identity_id,accepted_at)
          VALUES ('readiness-accepted-invite','workspace-account-a',?,'a@example.test','identity-a','accepted','2099-01-01','identity-a',datetime('now'))`).bind("R".repeat(43)),
        db.prepare(`INSERT INTO portal_v2_legacy_member_bridges
          (workspace_id,identity_id,legacy_account_id,legacy_identity_id,invitation_id)
          VALUES ('workspace-account-a','identity-a','account-a','readiness-bridge-local','readiness-accepted-invite')`),
      ]),
    ]);
    try {
      const proof = await readEffectiveWorkspaceRequestProof(env, principal, "workspace-account-a", "project-a");
      expect(proof?.workspace.legacyIdentityId).toBe("readiness-bridge-local");
      expect(proof?.local.bridge_priority).toBe(bridgeKind === "invitation" ? 0 : 1);
      expect(await readiness("project-a")).toMatchObject({ canStartRequest: true, root: { canStartRequest: false } });
      await db.prepare("UPDATE client_member_project_grants SET revoked_at=datetime('now') WHERE identity_id='readiness-bridge-local'").run();
      // The original direct legacy identity is still a manager; it must not
      // replace the selected explicit bridge to bypass this member's grant.
      expect(await readiness("project-a")).toMatchObject({ canStartRequest: false });
    } finally {
      await db.batch([
        db.prepare("DELETE FROM portal_v2_legacy_member_bridges WHERE legacy_identity_id='readiness-bridge-local'"),
        db.prepare("DELETE FROM portal_v2_identity_eligibility_legacy_bridges WHERE legacy_identity_id='readiness-bridge-local'"),
        db.prepare("DELETE FROM pa_portal_principals WHERE workspace_id='workspace-account-a' AND public_id='readiness-bridge-principal'"),
        db.prepare("DELETE FROM portal_v2_invitations WHERE id='readiness-accepted-invite'"),
        db.prepare("DELETE FROM client_member_project_grants WHERE identity_id='readiness-bridge-local'"),
        db.prepare("DELETE FROM client_account_members WHERE identity_id='readiness-bridge-local'"),
        db.prepare("DELETE FROM client_identity_links WHERE id='readiness-bridge-local'"),
        db.prepare("UPDATE portal_v2_workspace_memberships SET source_type=? WHERE workspace_id='workspace-account-a' AND identity_id='identity-a'").bind(originalSource),
      ]);
    }
  });
});
