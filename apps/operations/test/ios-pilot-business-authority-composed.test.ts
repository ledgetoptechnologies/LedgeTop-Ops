import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, expect, it, vi } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
const testKey = vi.hoisted(() => ({ publicKey: undefined as unknown }));
vi.mock("../src/worker/access-jwks", () => ({ accessJwksResolver: () => testKey.publicKey }));
import { applyConnectorSchema, registerVisibleTestSource } from "./helpers/project-alpha-connectors";
import { applyBusinessPartySchema, applyBusinessPartyStaffSchema } from "./helpers/business-parties";
import rootAccessMigration from "../../client/migrations/0197_portal_root_access_policy.sql?raw";
import { readPilotBusinessAuthority } from "../src/worker/ios-pilot-business-authority";
import type { Env } from "../src/worker/types";

// Synthetic dual-D1 fixture derived from client-hub.test.ts; no production data.
const active: Miniflare[] = [];
const organizationUuid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const standaloneUuid = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const applySql = (database: D1Database, sql: string) => database.exec(sql.replace(/\s*\n\s*/g, " "));

async function fixture() {
  const miniflare = new Miniflare({
    compatibilityDate: "2026-08-06",
    modules: true,
    script: "export default { fetch(){ return new Response('ok'); } }",
    d1Databases: { OPS_DB: "client-hub-ops", DELIVERY_DB: "client-hub-delivery" },
  });
  active.push(miniflare);
  const ops = await miniflare.getD1Database("OPS_DB") as unknown as D1Database;
  const delivery = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
  await applyConnectorSchema(ops);
  await applyBusinessPartyStaffSchema(ops);
  await ops.batch([
    ops.prepare("INSERT INTO permissions(key,description) VALUES('team.view','View directory'),('team.manage','Manage business links')"),
    ops.prepare("INSERT INTO roles(id,name,description) VALUES('role-admin','Fixture administrator','Directory fixture authority')"),
    ops.prepare("INSERT INTO role_permissions(role_id,permission_key) VALUES('role-admin','team.view'),('role-admin','team.manage')"),
    ...["staff-one", "other-staff"].flatMap(id => [
      ops.prepare("INSERT INTO staff_users(id,email,display_name,status) VALUES(?,?,?,'active')").bind(id, `${id}@example.test`, id),
      ops.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES(?,?,'role-admin','global','global')")
        .bind(`fixture-${id}`, id),
    ]),
  ]);
  await applySql(ops, `
    CREATE TABLE pa_organizations(id TEXT PRIMARY KEY,name TEXT,active INTEGER,payload_json TEXT NOT NULL DEFAULT '{}',projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_clients(id TEXT PRIMARY KEY,name TEXT,organization_id TEXT,active INTEGER,payload_json TEXT NOT NULL DEFAULT '{}',projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_projects(id TEXT PRIMARY KEY,name TEXT,status TEXT,start_date TEXT,end_date TEXT,
      client_id TEXT,organization_id TEXT,manager_user_id TEXT,active INTEGER,payload_json TEXT,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_users(id TEXT PRIMARY KEY,display_name TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    INSERT INTO pa_organizations(id,name,active,payload_json) VALUES('pa-org','Organization One',1,'{"public_id":"${organizationUuid}"}');
    INSERT INTO pa_clients(id,name,organization_id,active) VALUES('pa-child-login','Login Contact','pa-org',1);
    INSERT INTO pa_clients(id,name,organization_id,active) VALUES('pa-child-no-login','No Login Contact','pa-org',1);
    INSERT INTO pa_clients(id,name,organization_id,active,payload_json) VALUES('pa-standalone','Standalone One',NULL,1,'{"public_id":"${standaloneUuid}"}');
  `);
  await applySql(ops, readFileSync(new URL("../migrations/0032_client_hub_directory.sql", import.meta.url), "utf8").replace(/^\s*--.*$/gm, ""));
  // The production directory cursor binds the business-activity revision from
  // migration 0037. This focused fixture builds only the tables it exercises,
  // so keep that required revision source present as well.
  await applySql(ops, `
    CREATE TABLE client_business_activity_state(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0)
    );
    INSERT INTO client_business_activity_state(singleton) VALUES(1);
    CREATE TABLE client_business_activity(
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      projection_source_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      origin TEXT NOT NULL,
      record_kind TEXT NOT NULL,
      record_id TEXT NOT NULL,
      root_kind TEXT NOT NULL,
      root_id TEXT NOT NULL,
      root_record_kind TEXT NOT NULL,
      action TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      source_updated_at TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );
    CREATE VIEW client_business_activity_records AS
      SELECT CAST(NULL AS TEXT) projection_source_id,CAST(NULL AS TEXT) record_kind,
        CAST(NULL AS TEXT) record_id,CAST(NULL AS TEXT) record_name,
        CAST(NULL AS TEXT) root_kind,CAST(NULL AS TEXT) root_id,0 readable
      WHERE 0;
  `);
  await applyBusinessPartySchema(ops);
  await applySql(ops, `
    INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
      VALUES('project-alpha:primary','organization','pa-org','pa-org');
    INSERT INTO client_hub_roots(source_id,kind,public_id,display_name,sort_name,status,portal_status,workspace_id,legacy_account_id,account_count,project_count,request_count,contact_count)
      VALUES('project-alpha:primary','organization','pa-org','Organization One','organization one','active','active','workspace-org','account-org',1,0,0,2),
        ('project-alpha:primary','standalone_client','pa-standalone','Standalone One','standalone one','active','not_provisioned',NULL,'account-standalone',1,1,1,1);
    UPDATE client_hub_directory_state SET ready=1;
    UPDATE client_hub_roots SET pa_public_id='${organizationUuid}' WHERE public_id='pa-org';
    UPDATE client_hub_roots SET pa_public_id='${standaloneUuid}' WHERE public_id='pa-standalone';
  `);
  await applySql(delivery, `
    CREATE TABLE client_accounts(id TEXT PRIMARY KEY,display_name TEXT,status TEXT,project_alpha_client_id TEXT,
      project_alpha_organization_id TEXT,created_at TEXT,updated_at TEXT,project_alpha_source_id TEXT);
    CREATE UNIQUE INDEX account_pa_client ON client_accounts(project_alpha_source_id,project_alpha_client_id) WHERE project_alpha_client_id IS NOT NULL;
    CREATE UNIQUE INDEX account_pa_organization ON client_accounts(project_alpha_source_id,project_alpha_organization_id) WHERE project_alpha_organization_id IS NOT NULL;
    CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,root_type TEXT,pa_organization_public_id TEXT,
      pa_client_public_id TEXT,display_name TEXT,status TEXT,legacy_account_id TEXT,project_alpha_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE portal_v2_directory_generations(id TEXT PRIMARY KEY,workspace_id TEXT,source_generation TEXT,
      source_sequence INTEGER,status TEXT,complete INTEGER);
    CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT PRIMARY KEY,active_generation_id TEXT,source_sequence INTEGER);
    CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,
      parent_public_id TEXT,display_name TEXT,active INTEGER,source_version TEXT);
    CREATE TABLE portal_v2_contact_assignment_contracts(workspace_id TEXT,generation_id TEXT,schema_version INTEGER,
      PRIMARY KEY(workspace_id,generation_id));
    CREATE TABLE portal_v2_contact_assignments(workspace_id TEXT,generation_id TEXT,public_id TEXT,contact_public_id TEXT,
      client_public_id TEXT,scope_type TEXT,scope_public_id TEXT,role TEXT,primary_contact INTEGER,primary_billing INTEGER,
      send_project_invoices INTEGER,can_view_invoice_links INTEGER,source_version TEXT,active INTEGER);
    CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT PRIMARY KEY,projection_source_id TEXT,source_workspace_id TEXT);
    CREATE TABLE pa_portal_source_authorities(source_id TEXT PRIMARY KEY,state TEXT,active_revision INTEGER,version INTEGER,
      connector_revision INTEGER,connector_version INTEGER);
    CREATE TABLE pa_portal_source_authority_revisions(source_id TEXT,revision INTEGER);
    CREATE TABLE client_project_grants(account_id TEXT,project_id TEXT,can_request_service INTEGER,granted_at TEXT,revoked_at TEXT);
    CREATE TABLE projects(id TEXT PRIMARY KEY,project_name TEXT,client_name TEXT,r2_prefix TEXT,active INTEGER,
      project_alpha_project_id TEXT,project_alpha_source_id TEXT);
    CREATE TABLE client_service_requests(id TEXT PRIMARY KEY,account_id TEXT,project_id TEXT,request_type TEXT,title TEXT,
      status TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE shares(id TEXT PRIMARY KEY,label TEXT,r2_prefix TEXT,created_at TEXT);
    CREATE TABLE client_delivery_grants(account_id TEXT,project_id TEXT,share_id TEXT,granted_at TEXT,expires_at TEXT,revoked_at TEXT);
    CREATE TABLE portal_v2_folder_bindings(id TEXT PRIMARY KEY,workspace_id TEXT,r2_prefix TEXT,owner_scope_type TEXT,owner_public_id TEXT);
    CREATE TABLE portal_v2_authenticated_delivery_grants(id TEXT PRIMARY KEY,workspace_id TEXT,folder_binding_id TEXT,
      audience_type TEXT,audience_public_id TEXT,status TEXT,expires_at TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE viewer_model_associations(id TEXT PRIMARY KEY,model_title TEXT);
    CREATE TABLE viewer_client_grants(id TEXT PRIMARY KEY,account_id TEXT,project_id TEXT,scope_type TEXT,association_id TEXT,
      include_future_published INTEGER,can_measure INTEGER,can_view_cameras INTEGER,can_download INTEGER,
      authorization_expires_at TEXT,status TEXT,created_at TEXT,updated_at TEXT);
    INSERT INTO client_accounts VALUES('account-standalone','Standalone One','active','pa-standalone',NULL,datetime('now'),datetime('now'),'project-alpha:primary');
    INSERT INTO client_accounts VALUES('account-org','Organization One','active','pa-child-login','pa-org',datetime('now'),datetime('now'),'project-alpha:primary');
    INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,pa_client_public_id,display_name,status,legacy_account_id) VALUES('workspace-org','organization','${organizationUuid}',NULL,'Organization One','active','account-org');
    INSERT INTO portal_v2_directory_generations VALUES('generation-org','workspace-org','native-1',1,'active',1);
    INSERT INTO portal_v2_directory_checkpoints VALUES('workspace-org','generation-org',1);
    INSERT INTO portal_v2_directory_entities VALUES('workspace-org','generation-org','organization','${organizationUuid}',NULL,'Organization One',1,'native-version');
    INSERT INTO projects VALUES('project-one','Project One','Standalone One','clients/standalone/project-one/',1,'pa-project-one','project-alpha:primary');
    INSERT INTO client_project_grants VALUES('account-standalone','project-one',1,datetime('now'),NULL);
    INSERT INTO client_service_requests VALUES('request-one','account-standalone','project-one','service','Oldest request','submitted','2026-01-01','2026-01-01');
    INSERT INTO shares VALUES('share-one','Delivered folder','clients/standalone/project-one/',datetime('now'));
    INSERT INTO client_delivery_grants VALUES('account-standalone','project-one','share-one',datetime('now'),NULL,NULL);
  `);
  await applySql(delivery, rootAccessMigration.replace(/^\s*--.*$/gm, "").replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, ""));
  const env = { OPS_DB: ops, DELIVERY_DB: delivery, PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: {
    "project-alpha:primary": { sourceId: "project-alpha:primary", enabled: true, baseUrl: "https://alpha.example.test/", apiKey: "test-key",
      sourceInstanceId: "00000000-0000-4000-8000-000000000001", applicationId: "00000000-0000-4000-8000-000000000002",
      historyEpoch: "00000000-0000-4000-8000-000000000003" },
  } }), CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED: "true",
    CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true", CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED: "true" } as Env;
  return { env, ops, delivery };
}


afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(active.splice(0).map(item => item.dispose())); });

it("enforces signed identity, native admission, ACL and source without mutation or outbound network", async () => {
  const { env, ops, delivery } = await fixture();
  await registerVisibleTestSource(ops, "project-alpha:staging", "Synthetic staging");
  await applySql(ops, readFileSync(new URL("../migrations/0034_client_hub_projection_sources.sql", import.meta.url), "utf8").replace(/^\s*--.*$/gm, ""));
  await ops.batch([
    ops.prepare("UPDATE staff_users SET access_subject='access|one' WHERE id='staff-one'"),
    ops.prepare("CREATE TABLE native_staff_access_reconciliation(singleton INTEGER PRIMARY KEY,enabled INTEGER NOT NULL)"),
    ops.prepare("CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,login_email TEXT,version INTEGER)"),
    ops.prepare("CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT,active INTEGER,version INTEGER)"),
    ops.prepare("INSERT INTO native_staff_access_reconciliation VALUES(1,1)"),
    ops.prepare("INSERT INTO native_staff_profiles VALUES('staff-one','staff-one@example.test',17)"),
    ops.prepare("INSERT INTO native_staff_admissions VALUES('staff-one','access|one',1,7)"),
    ops.prepare("INSERT INTO permissions(key,description) VALUES('projects.view','View projects')"),
    ops.prepare("INSERT INTO role_permissions(role_id,permission_key) VALUES('role-admin','projects.view')"),
    ops.prepare("INSERT INTO pa_organizations(id,name,active,payload_json,projection_source_id) VALUES('stage-org','Stage organization',1,'{}','project-alpha:staging')"),
    ops.prepare("INSERT INTO pa_clients(id,name,organization_id,active,payload_json,projection_source_id) VALUES('stage-client','Stage client','stage-org',1,'{}','project-alpha:staging')"),
    ops.prepare("INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id) VALUES('project-alpha:staging','organization','stage-org','stage-org')"),
    ops.prepare("INSERT INTO client_hub_roots(source_id,root_namespace,kind,public_id,display_name,sort_name,status) VALUES('project-alpha:staging','business','organization','stage-org','Stage organization','stage organization','active')"),
    ops.prepare(`INSERT INTO pa_projects(id,name,status,start_date,end_date,client_id,organization_id,active,payload_json,projection_source_id)
      VALUES('mobile-project','Pilot project',NULL,'2026-11-01',NULL,'stage-client','stage-org',1,?,'project-alpha:staging')`).bind(JSON.stringify({ public_id: 'd'.repeat(32), confidential: 'do not return' })),
  ]);
  const connections = JSON.parse(env.PROJECT_ALPHA_API_V2_CONNECTIONS!);
  connections.instances['project-alpha:staging'] = { sourceId: 'project-alpha:staging', enabled: true,
    baseUrl: 'https://staging.example.test/', apiKey: 'synthetic-test-key',
    sourceInstanceId: '00000000-0000-4000-8000-000000000004', applicationId: '00000000-0000-4000-8000-000000000005',
    historyEpoch: '00000000-0000-4000-8000-000000000006' };
  env.PROJECT_ALPHA_API_V2_CONNECTIONS = JSON.stringify(connections);

  // Reproduce the real ambiguity: the same Client Hub root key exists under
  // a different source and maps to a different organization. No production data.
  await registerVisibleTestSource(ops, 'project-alpha:source-2-staging', 'Other synthetic source');
  await ops.batch([
    ops.prepare("INSERT INTO pa_organizations(id,name,active,payload_json,projection_source_id) VALUES('other-org','Other organization',1,'{}','project-alpha:source-2-staging')"),
    ops.prepare("INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id) VALUES('project-alpha:source-2-staging','organization','stage-org','other-org')"),
    ops.prepare("INSERT INTO client_hub_roots(source_id,root_namespace,kind,public_id,display_name,sort_name,status) VALUES('project-alpha:source-2-staging','business','organization','stage-org','Other organization','other organization','active')"),
  ]);
  connections.instances['project-alpha:source-2-staging'] = { sourceId: 'project-alpha:source-2-staging', enabled: true,
    baseUrl: 'https://other.example.test/', apiKey: 'other-synthetic-test-key',
    sourceInstanceId: '00000000-0000-4000-8000-000000000007', applicationId: '00000000-0000-4000-8000-000000000008',
    historyEpoch: '00000000-0000-4000-8000-000000000009' };
  env.PROJECT_ALPHA_API_V2_CONNECTIONS = JSON.stringify(connections);
  const team = 'https://ledgetoptechnologies.cloudflareaccess.com';
  const pilotAud = 'e982d104616a480315256a577ef5ad5ce089f382c0b5453ce9db4cd9df7cf89d';
  const opsAud = '559cd7c0d2cc47f271aac422412fce677a51443ec365d9f2c585d9c0e377cc0b';
  Object.assign(env, { ENVIRONMENT: 'staging', TEAM_DOMAIN: team, OPERATIONS_AUD: opsAud,
    PUBLIC_BASE_URL: 'https://ops-staging.ledgetopdroneservices.com', IOS_PILOT_BUSINESS_AUTHORITY_ENABLED: 'true' });

  // Wrap both D1 bindings after fixture setup. Reject every statement except a
  // single SELECT/WITH query or read-only schema PRAGMA, and reject D1 run/exec.
  // Batch receives the original prepared statements after each has been checked.
  const rawStatements = new WeakMap<object, D1PreparedStatement>();
  const audit = { opsReads: 0, deliveryReads: 0, mutationAttempts: 0, networkAttempts: 0 };
  function readOnly<T extends D1Database | D1DatabaseSession>(database: T, source: 'opsReads' | 'deliveryReads'): T {
    const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => {
      const proxy = new Proxy(statement, { get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => wrapStatement(target.bind(...values));
        if (key === 'run') return () => { audit.mutationAttempts++; throw new Error('D1 run forbidden'); };
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => value.apply(target, args);
      }});
      rawStatements.set(proxy, statement);
      return proxy;
    };
    return new Proxy(database, { get(target, key) {
      if (key === 'prepare') return (sql: string) => {
        const normalized = sql.trim().replace(/;\s*$/, '');
        if (!/^(?:SELECT|WITH|PRAGMA\s+(?:table_info|index_list|index_info))\b/i.test(normalized)
          || normalized.includes(';') || /\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+\w+\s+SET|REPLACE\s+INTO|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE)\b/i.test(normalized)) {
          audit.mutationAttempts++; throw new Error('Non-read SQL forbidden');
        }
        audit[source]++;
        return wrapStatement(target.prepare(sql));
      };
      if (key === 'withSession') return (...args: unknown[]) => {
        const method = Reflect.get(target, key, target) as (...values: unknown[]) => D1DatabaseSession;
        return readOnly(method.apply(target, args), source);
      };
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        const raw = statements.map(statement => {
          const original = rawStatements.get(statement);
          if (!original) throw new Error('Unreviewed batch statement');
          return original;
        });
        const method = Reflect.get(target, key, target) as (values: D1PreparedStatement[]) => Promise<D1Result[]>;
        const results = await method.call(target, raw);
        if (results.some(row => row.meta?.changes)) { audit.mutationAttempts++; throw new Error('D1 changed rows'); }
        return results;
      };
      if (key === 'exec') return () => { audit.mutationAttempts++; throw new Error('D1 exec forbidden'); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
  }
  const protectedEnv = { ...env, OPS_DB: readOnly(ops, 'opsReads'), DELIVERY_DB: readOnly(delivery, 'deliveryReads') };
  vi.stubGlobal('fetch', vi.fn(async () => { audit.networkAttempts++; throw new Error('Outbound network forbidden'); }));
  const key = await generateKeyPair('RS256'), other = await generateKeyPair('RS256');
  testKey.publicKey = key.publicKey;
  const token = async (audience = pilotAud, subject = 'access|one', signer = key.privateKey) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ type: 'app', email: 'staff-one@example.test' }).setProtectedHeader({ alg: 'RS256' })
      .setIssuer(team).setAudience(audience).setSubject(subject).setIssuedAt(now - 1).setExpirationTime(now + 300).sign(signer);
  };
  const path = 'https://ios-pilot-staging.ledgetop.app/mobile-pilot/v1/business-roots/organization/stage-org/projects';
  const call = async (assertion: string, url = path) => JSON.parse(await readPilotBusinessAuthority(JSON.stringify({ url, assertion }), protectedEnv)) as { status: number; body: unknown };
  const valid = await token();
  const response = await call(valid);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ schemaVersion: 1, projects: [{ id: 'mobile-project', origin: 'pa', name: 'Pilot project', status: null,
    startDate: '2026-11-01', endDate: null }], nextCursor: null });
  expect(JSON.stringify(response)).not.toContain('confidential');
  expect(JSON.stringify(response)).not.toContain('Other organization');
  expect((await call(await token(opsAud))).status).toBe(401);
  expect((await call(await token(pilotAud, 'access|one', other.privateKey))).status).toBe(401);
  expect((await call(await token(pilotAud, 'access|wrong'))).status).not.toBe(200);
  expect((await call(valid, path.replace('stage-org', 'missing-root'))).status).not.toBe(200);
  expect((await call(valid, 'https://ios-pilot-staging.ledgetop.app/mobile-pilot/v1/operations')).status).toBe(404);
  await ops.prepare("DELETE FROM role_permissions WHERE role_id='role-admin' AND permission_key='projects.view'").run();
  expect((await call(valid)).status).not.toBe(200);
  await ops.prepare("INSERT INTO role_permissions(role_id,permission_key) VALUES('role-admin','projects.view')").run();
  await ops.prepare("DELETE FROM role_permissions WHERE role_id='role-admin' AND permission_key='team.view'").run();
  expect((await call(valid)).status).not.toBe(200);
  await ops.prepare("INSERT INTO role_permissions(role_id,permission_key) VALUES('role-admin','team.view')").run();
  await ops.prepare("UPDATE pa_connectors SET read_visible=0,version=version+1 WHERE source_id='project-alpha:staging'").run();
  expect((await call(valid)).status).not.toBe(200);
  await ops.prepare("UPDATE pa_connectors SET read_visible=1,version=version+1 WHERE source_id='project-alpha:staging'").run();
  expect((await call(valid)).status).toBe(200);
  await ops.prepare("UPDATE native_staff_admissions SET active=0,version=version+1 WHERE staff_id='staff-one'").run();
  expect((await call(valid)).status).not.toBe(200);
  expect(audit.opsReads).toBeGreaterThan(0);
  expect(audit.deliveryReads).toBeGreaterThan(0);
  expect(audit.mutationAttempts).toBe(0);
  expect(audit.networkAttempts).toBe(0);
}, 120_000);
