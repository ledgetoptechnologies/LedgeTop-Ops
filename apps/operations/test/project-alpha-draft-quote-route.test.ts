import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { Miniflare } from "miniflare";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { canonicalProjectAlphaJson, projectAlphaDraftIdempotencyKey, registerProjectAlphaDraftQuoteRoutes, sha256Hex,
  type ProjectAlphaDraftQuotePayload } from "../src/worker/project-alpha-draft-quote";
import type { Env, StaffPrincipal } from "../src/worker/types";
import { applyConnectorSchema } from "./helpers/project-alpha-connectors";

// Only staff ACL loading is isolated. Delivery SQL uses the entire production
// migration chain; the actual primary-reference resolver queries real D1 rows.
// This suite tests route policy use, not role-assignment compilation or login.
const acl = vi.hoisted(() => ({ allowed: true }));
vi.mock("../src/worker/acl", () => ({ sqlScope: vi.fn(async () => ({
  global: acl.allowed, deniedGlobal: !acl.allowed, divisions: [], deniedDivisions: [], assigned: false, own: false,
})) }));

const primary = PRIMARY_ALPHA_SOURCE_ID;
const secondary = "project-alpha:secondary";
const principal: StaffPrincipal = { id: "staff-quote", email: "staff@example.test", displayName: "Quote reviewer",
  accessSubject: "staff-subject", projectAlphaUserId: null };
const remoteResult = { receiptId: "alpha-receipt", draftQuote: { publicId: "alpha-quote", documentNumber: "DRAFT-001",
  status: "draft", version: 1, editorPath: "/quotes/alpha-quote/edit" } };
type TestApp = Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>;
interface Fixture { requestId: string; accountId: string; projectId: string; clientId: string; organizationId: string; paProjectId: string; serviceId: string }

function beforeReceiptBatch(database: D1Database, before: () => Promise<unknown>): D1Database {
  let called = false;
  const proxy: D1Database = new Proxy(database, { get(target, key) {
    if (key === "withSession") return () => proxy;
    if (key === "batch") return async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      if (!called) { called = true; await before(); }
      return target.batch<T>(statements);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return proxy;
}

function beforeCommandInsert(database: D1Database, before: () => Promise<unknown>): D1Database {
  let called = false;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, key) {
    if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
    if (key === "run") return async <T>(): Promise<D1Result<T>> => {
      if (!called) { called = true; await before(); }
      return target.run<T>();
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const proxy: D1Database = new Proxy(database, { get(target, key) {
    if (key === "withSession") return () => proxy;
    if (key === "prepare") return (sql: string) => {
      const statement = target.prepare(sql);
      return /INSERT\s+INTO\s+request_pa_draft_quote_commands\b/i.test(sql) ? wrap(statement) : statement;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return proxy;
}

describe("source-bound private quote real-D1 routes", () => {
  let runtime: Miniflare;
  let delivery: D1Database;
  let operations: D1Database;
  let environment: Env;
  let app: TestApp;
  let legacy: Fixture;
  let sender: ReturnType<typeof vi.fn<typeof fetch>>;

  async function fixture(name: string, options: { businessSource?: string; catalogSource?: string } = {}): Promise<Fixture> {
    const f = { requestId: `request-${name}`, accountId: `account-${name}`, projectId: `project-${name}`,
      clientId: `client-${name}`, organizationId: `organization-${name}`, paProjectId: `pa-project-${name}`, serviceId: `service-${name}` };
    const businessSource = options.businessSource ?? primary, catalogSource = options.catalogSource ?? primary;
    await operations.batch([
      operations.prepare("INSERT INTO pa_clients(id,projection_source_id,active,payload_json) VALUES(?,?,1,'{}')").bind(f.clientId, businessSource),
      operations.prepare("INSERT INTO pa_organizations(id,projection_source_id,active,payload_json) VALUES(?,?,1,'{}')").bind(f.organizationId, businessSource),
      operations.prepare("INSERT INTO pa_projects(id,projection_source_id,active,payload_json) VALUES(?,?,1,'{}')").bind(f.paProjectId, businessSource),
    ]);
    await delivery.batch([
      delivery.prepare(`INSERT INTO client_accounts(id,display_name,status,project_alpha_client_id,project_alpha_organization_id,project_alpha_source_id)
        VALUES(?,'Quote client','active',?,?,?)`).bind(f.accountId, f.clientId, f.organizationId, businessSource),
      delivery.prepare(`INSERT INTO client_identity_links(id,account_id,issuer,subject,email)
        VALUES(?,?,'https://issuer.test',?,'person@example.test')`).bind(`identity-${name}`, f.accountId, name),
      delivery.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES(?,?,'manager')").bind(f.accountId, `identity-${name}`),
      delivery.prepare(`INSERT INTO projects(id,client_name,project_name,r2_prefix,project_alpha_project_id,project_alpha_source_id)
        VALUES(?,'Quote client','Quote project',?,?,?)`).bind(f.projectId, `Clients/${name}/`, f.paProjectId, businessSource),
      delivery.prepare("INSERT INTO client_project_grants(account_id,project_id,can_request_service) VALUES(?,?,1)").bind(f.accountId, f.projectId),
      delivery.prepare(`INSERT INTO client_service_requests(id,account_id,project_id,created_by_identity_id,request_type,title,details,deliverables_text,
        idempotency_key,request_fingerprint,status,catalog_source_id)
        VALUES(?,?,?,?,'service','Original title','Original scope','Map package',?,?,'under_review',?)`)
        .bind(f.requestId, f.accountId, f.projectId, `identity-${name}`, `request-create-key-${name}`, "r".repeat(43), catalogSource),
      delivery.prepare(`INSERT INTO request_revisions(id,request_id,revision_number,author_type,author_id,action,snapshot_json)
        VALUES(?,?,1,'client',?,'submitted','{"original":true}')`).bind(`revision-${name}`, f.requestId, `identity-${name}`),
      delivery.prepare(`INSERT INTO client_service_request_services
        (request_id,ordinal,service_public_id,service_source_version,service_snapshot_json,answers_json,service_source_id)
        VALUES(?,0,?,'v1','{"name":"Mapping"}','{"note":"Original"}',?)`).bind(f.requestId, f.serviceId, catalogSource),
    ]);
    return f;
  }
  async function expectedPayload(f: Fixture): Promise<ProjectAlphaDraftQuotePayload> {
    return { schemaVersion: 1, source: "ltds-operations",
      request: { publicId: f.requestId, revision: 1, title: "Original title", scopeSummary: "Original scope", deliverablesSummary: "Map package" },
      authorization: { organizationPublicId: f.organizationId, clientPublicId: f.clientId, projectPublicId: f.paProjectId },
      services: [{ publicId: f.serviceId, catalogVersion: "v1", answers: { note: "Original" } }],
      workArea: { revision: 0, hash: await sha256Hex(canonicalProjectAlphaJson({ areaGeoJson: null, poiPoints: [] })), squareMeters: null, acres: null },
      attachments: [] };
  }
  async function nativeFixture(name: string) {
    const f = await fixture(name, { catalogSource: secondary });
    const publicId = (suffix: string) => createHash("sha256").update(`${name}:${suffix}`).digest("hex").slice(0,32);
    const ids = { workspace: `workspace-${name}`, generation: `generation-${name}`,
      root: publicId("root"), client: publicId("client"), project: publicId("project") };
    const key = (value: number) => Buffer.alloc(32,value).toString("base64url");
    const fingerprint = (value: string) => createHash("sha256").update(Buffer.concat([
      Buffer.from("ed25519\0"), Buffer.from(`${value}=`, "base64url"),
    ])).digest("hex");
    const primaryKey = key(1), secondaryKey = key(2);
    const draftApiKey = "secondary-draft-only-api-key";
    const draftHmac = "secondary-draft-only-hmac-secret-at-least-32-bytes";
    const secretFingerprint = (domain: string, value: string) => createHash("sha256").update(`${domain}\0${value}`).digest("hex");
    const connectorExists = !!await operations.prepare("SELECT 1 FROM pa_connectors WHERE source_id=?").bind(secondary).first();
    await operations.batch([
      ...(connectorExists ? [] : [
      operations.prepare("INSERT INTO pa_connector_signing_keys(fingerprint,source_id,algorithm) VALUES(?,?,'ed25519')")
        .bind(fingerprint(primaryKey), primary),
      operations.prepare(`INSERT INTO pa_connectors(source_id,producer_binding_id,snapshot_origin,application_key,snapshot_base_path,
        profile,display_name,read_visible,created_by) VALUES(?,'primary-binding','https://primary.example.test','ltds','/api/exports','primary_legacy','Primary',1,'fixture')`).bind(primary),
      operations.prepare(`INSERT INTO pa_connector_revisions(source_id,revision,credential_ref,snapshot_base_path,access_issuer,
        access_audience,access_subject,current_key_id,current_key_fingerprint,created_by)
        VALUES(?,1,'PRIMARY','/api/exports','https://access.example.test','audience','subject','primary-key',?,'fixture')`)
        .bind(primary,fingerprint(primaryKey)),
      operations.prepare("UPDATE pa_connectors SET state='active',version=2 WHERE source_id=?").bind(primary),
      operations.prepare("INSERT INTO pa_connector_signing_keys(fingerprint,source_id,algorithm) VALUES(?,?,'ed25519')")
        .bind(fingerprint(secondaryKey), secondary),
      operations.prepare(`INSERT INTO pa_connectors(source_id,producer_binding_id,snapshot_origin,application_key,snapshot_base_path,
        profile,display_name,created_by) VALUES(?,'secondary-binding','https://secondary.example.test','secondary_ops','/api/exports','business_data','Secondary','fixture')`).bind(secondary),
      operations.prepare(`INSERT INTO pa_connector_draft_quote_credentials
        (ownership_fingerprint,purpose_fingerprint,source_id,purpose) VALUES(?,?,?,'api_key')`)
        .bind(secretFingerprint("draft-quote-credential",draftApiKey),secretFingerprint("draft-quote-api-key",draftApiKey),secondary),
      operations.prepare(`INSERT INTO pa_connector_draft_quote_credentials
        (ownership_fingerprint,purpose_fingerprint,source_id,purpose) VALUES(?,?,?,'hmac')`)
        .bind(secretFingerprint("draft-quote-credential",draftHmac),secretFingerprint("draft-quote-hmac",draftHmac),secondary),
      operations.prepare(`INSERT INTO pa_connector_revisions(source_id,revision,credential_ref,snapshot_base_path,access_issuer,
        access_audience,access_subject,current_key_id,current_key_fingerprint,created_by,draft_quote_api_key_fingerprint,draft_quote_hmac_fingerprint)
        VALUES(?,1,'NATIVE','/api/exports','https://access.example.test','audience','subject','secondary-key',?,'fixture',?,?)`)
        .bind(secondary,fingerprint(secondaryKey),secretFingerprint("draft-quote-api-key",draftApiKey),secretFingerprint("draft-quote-hmac",draftHmac)),
      operations.prepare("UPDATE pa_connectors SET state='active',read_visible=1,version=2 WHERE source_id=?").bind(secondary),
      ]),
      operations.prepare("INSERT INTO pa_organizations(id,name,projection_source_id,active,payload_json) VALUES(?,'Native org',?,1,?)")
        .bind(`native-org-${name}`,secondary,JSON.stringify({public_id:ids.root})),
      operations.prepare("INSERT INTO pa_clients(id,name,organization_id,projection_source_id,active,payload_json) VALUES(?,'Native client',?,?,1,?)")
        .bind(`native-client-${name}`,`native-org-${name}`,secondary,JSON.stringify({public_id:ids.client})),
      operations.prepare("INSERT INTO pa_projects(id,name,client_id,organization_id,projection_source_id,active,payload_json) VALUES(?,'Native project',?,?,?,1,?)")
        .bind(`native-project-${name}`,`native-client-${name}`,`native-org-${name}`,secondary,JSON.stringify({public_id:ids.project})),
    ]);
    const authorityExists = !!await delivery.prepare("SELECT 1 FROM pa_portal_source_authorities WHERE source_id=?").bind(secondary).first();
    await delivery.batch([
      ...(authorityExists ? [] : [
      delivery.prepare(`INSERT INTO pa_portal_source_authorities(source_id,producer_binding_id,snapshot_origin,snapshot_base_path,
        application_key,state,active_revision,version,connector_revision,connector_version)
        VALUES(?,'secondary-binding','https://secondary.example.test','/api/exports','secondary_ops','pending',1,1,1,2)`).bind(secondary),
      delivery.prepare(`INSERT INTO pa_portal_source_authority_revisions(source_id,revision,credential_ref,access_issuer,access_audience,
        access_subject,current_key_id,current_key_fingerprint,created_by)
        VALUES(?,1,'NATIVE','https://access.example.test','audience','subject','portal-key',?,'fixture')`).bind(secondary,"d".repeat(64)),
      delivery.prepare("UPDATE pa_portal_source_authorities SET state='active',version=2 WHERE source_id=?").bind(secondary),
      ]),
      delivery.prepare(`INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id)
        VALUES(?,?,?)`).bind(ids.workspace,secondary,ids.workspace),
      delivery.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id)
        VALUES(?,'organization',?,'Native workspace','active',?)`).bind(ids.workspace,ids.root,secondary),
      delivery.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete)
        VALUES(?,?,'source-generation',7,'active',1)`).bind(ids.generation,ids.workspace),
      delivery.prepare("INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,7)")
        .bind(ids.workspace,ids.generation),
      delivery.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active)
        VALUES(?,?,'organization',?,NULL,'Native org','org-v1',1),(?,?,'client',?,?,'Native client','client-v1',1),(?,?,'project',?,?,'Native project','project-v1',1)`)
        .bind(ids.workspace,ids.generation,ids.root,ids.workspace,ids.generation,ids.client,ids.root,
          ids.workspace,ids.generation,ids.project,ids.client),
      delivery.prepare(`UPDATE client_service_requests SET project_id=NULL,portal_workspace_id=?,portal_project_public_id=? WHERE id=?`)
        .bind(ids.workspace,ids.project,f.requestId),
    ]);
    const credentials = { version: 1, sets: { NATIVE: { snapshotApiKey: "secondary-snapshot-only",
      eventCurrent: { keyId: "secondary-key", algorithm: "ed25519", value: secondaryKey },
      draftQuote: { apiKey: draftApiKey, hmacSecret: draftHmac } } } };
    return { f, ids, credentials };
  }
  async function addAreaRevision(f: Fixture) {
    await delivery.prepare(`INSERT INTO client_service_request_area_revisions
      (id,request_id,revision_number,base_request_updated_at,area_geojson,poi_points_json,reason,change_summary,
       created_by,mutation_key,mutation_fingerprint)
      SELECT ?,id,1,updated_at,NULL,'[]','Review the revised area','New area revision',?,?,? FROM client_service_requests WHERE id=?`)
      .bind(`area-${f.requestId}`, principal.id, `area-mutation-${f.requestId}`, "a".repeat(64), f.requestId).run();
  }
  async function insertUnresolvedOriginalCommand(f: Fixture) {
    const payload = canonicalProjectAlphaJson(await expectedPayload(f));
    const destination = { sourceId: primary, commandEndpoint: "https://alpha.example/api/v2/integrations/ltds/draft-quotes",
      applicationKey: "ltds", editorOrigin: "https://alpha.example" };
    await delivery.prepare(`INSERT INTO request_pa_draft_quote_commands
      (id,request_id,request_revision,area_revision,source_id,command_endpoint,application_key,editor_origin,
       destination_fingerprint,idempotency_key,payload_hash,payload_json,created_by)
      VALUES(?,?,1,0,?,?,?,?,?,?,?,?,?)`)
      .bind(`older-command-${f.requestId}`, f.requestId, primary, destination.commandEndpoint, destination.applicationKey,
        destination.editorOrigin, await sha256Hex(canonicalProjectAlphaJson(destination)),
        projectAlphaDraftIdempotencyKey(f.requestId, 1, 0), await sha256Hex(payload), payload, principal.id).run();
  }
  async function call(f: Fixture, overrides: Partial<Env> = {}, method = "POST") {
    const pending: Promise<unknown>[] = [];
    // Hono only uses waitUntil here; all submitted secondary audit work is
    // drained before returning so assertions cannot race background effects.
    const context = { waitUntil(promise: Promise<unknown>) { pending.push(promise); }, passThroughOnException() {} } as ExecutionContext;
    const response = await app.request(`/api/client-service-requests/${f.requestId}/pa-draft`, { method }, { ...environment, ...overrides }, context);
    await Promise.all(pending);
    return response;
  }
  async function counts(f: Fixture) {
    const [commands, receipts, audits, logs] = await Promise.all([
      delivery.prepare("SELECT COUNT(*) count FROM request_pa_draft_quote_commands WHERE request_id=?").bind(f.requestId).first<number>("count"),
      delivery.prepare("SELECT COUNT(*) count FROM request_pa_draft_quote_receipts WHERE request_id=?").bind(f.requestId).first<number>("count"),
      delivery.prepare("SELECT COUNT(*) count FROM request_admin_audit WHERE request_id=? AND action LIKE 'pa_draft_quote_%'").bind(f.requestId).first<number>("count"),
      delivery.prepare("SELECT COUNT(*) count FROM audit_log WHERE entity_id=? AND action LIKE 'client.service_request.pa_draft_quote_%'").bind(f.requestId).first<number>("count"),
    ]);
    return { commands, receipts, audits, logs };
  }
  async function draftNotices(f: Fixture) {
    return (await delivery.prepare(`SELECT notice.id,notice.event_type,notice.recipient_kind,notice.dedupe_key,
      notice.payload_json,notice.status,receipt.id receipt_id,
      notice.dedupe_key=('pa_draft_quote_created:' || receipt.id || ':' || notice.recipient_kind) dedupe_exact
      FROM client_portal_notification_outbox notice
      JOIN request_pa_draft_quote_receipts receipt ON receipt.request_id=notice.request_id
      WHERE notice.request_id=? AND notice.event_type='pa_draft_quote_created' ORDER BY notice.id`)
      .bind(f.requestId).all<Record<string, unknown>>()).results;
  }
  async function rebuildPre0201Outbox(directory: URL) {
    // Reuse the exact last pre-0201 outbox definition instead of approximating
    // CHECK behavior with a trigger. Existing 0201-only rows cannot be copied
    // into that historical schema, so remove only this suite's prior notices.
    await delivery.prepare("DELETE FROM client_portal_notification_outbox WHERE event_type='pa_draft_quote_created'").run();
    const statements = splitD1MigrationStatements(
      readFileSync(new URL("0118_staff_work_area_revisions.sql", directory), "utf8"),
    );
    const start = statements.findIndex(sql => sql.includes("CREATE TABLE client_portal_notification_outbox_next"));
    const end = statements.findIndex((sql, index) => index > start && sql.includes("CREATE TABLE client_portal_notifications_next"));
    if (start < 0 || end < 0) throw new Error("0118 outbox rebuild fixture is unavailable");
    await delivery.batch(statements.slice(start, end).map(sql => delivery.prepare(sql)));
  }

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-07-22", modules: true,
      script: "export default {fetch(){return new Response('quote-route')}}",
      d1Databases: { DELIVERY_DB: "quote-route-delivery", OPS_DB: "quote-route-operations" } });
    delivery = await runtime.getD1Database("DELIVERY_DB") as D1Database;
    operations = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../../client/migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(value => value.endsWith(".sql") && value < "0160_").sort()) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"));
      if (statements.length) await delivery.batch(statements.map(sql => delivery.prepare(sql)));
    }
    // Real projection rows with precisely the columns used by the real primary
    // proof, not a mocked 'available:true' result. Full Ops ingestion is tested
    // separately; this suite's migration contract is the shared Delivery DB.
    await operations.batch([
      operations.prepare(`CREATE TABLE pa_clients(id TEXT PRIMARY KEY,name TEXT NOT NULL DEFAULT 'Client',organization_id TEXT,
        projection_source_id TEXT NOT NULL,active INTEGER NOT NULL,payload_json TEXT NOT NULL)`),
      operations.prepare(`CREATE TABLE pa_organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL DEFAULT 'Organization',
        projection_source_id TEXT NOT NULL,active INTEGER NOT NULL,payload_json TEXT NOT NULL)`),
      operations.prepare(`CREATE TABLE pa_projects(id TEXT PRIMARY KEY,name TEXT NOT NULL DEFAULT 'Project',client_id TEXT,organization_id TEXT,
        projection_source_id TEXT NOT NULL,active INTEGER NOT NULL,payload_json TEXT NOT NULL)`),
      operations.prepare(`CREATE TABLE audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_type TEXT,actor_id TEXT,
        actor_email TEXT,actor_display_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,division_id TEXT,details_json TEXT,client_address_hash TEXT)`),
    ]);
    legacy = await fixture("legacy");
    const oldPayload = canonicalProjectAlphaJson(await expectedPayload(legacy));
    await delivery.prepare(`INSERT INTO request_pa_draft_quote_receipts
      (id,request_id,request_revision,area_revision,idempotency_key,payload_hash,project_alpha_receipt_id,
        project_alpha_artifact_public_id,document_number,artifact_status,artifact_version,editor_path,created_by)
      VALUES('legacy-receipt',?,1,0,?,?,'alpha-receipt','alpha-quote','DRAFT-001','draft',1,'/quotes/alpha-quote/edit','staff-original')`)
      .bind(legacy.requestId, projectAlphaDraftIdempotencyKey(legacy.requestId, 1, 0), await sha256Hex(oldPayload)).run();
    await delivery.batch(splitD1MigrationStatements(readFileSync(new URL("0160_project_alpha_quote_destinations.sql", directory), "utf8"))
      .map(sql => delivery.prepare(sql)));
    await delivery.batch([
      delivery.prepare("ALTER TABLE client_service_requests ADD COLUMN portal_workspace_id TEXT"),
      delivery.prepare("ALTER TABLE client_service_requests ADD COLUMN portal_identity_id TEXT"),
      delivery.prepare("ALTER TABLE client_service_requests ADD COLUMN portal_project_public_id TEXT"),
    ]);
    await delivery.batch(splitD1MigrationStatements(readFileSync(new URL("0162_portal_source_authorities.sql", directory), "utf8"))
      .map(sql => delivery.prepare(sql)));
    await delivery.batch(splitD1MigrationStatements(readFileSync(new URL("0201_native_draft_quote_notifications.sql", directory), "utf8"))
      .map(sql => delivery.prepare(sql)));
    await applyConnectorSchema(operations);
    environment = { DELIVERY_DB: delivery, OPS_DB: operations, PROJECT_ALPHA_BASE_URL: "https://alpha.example",
      PROJECT_ALPHA_DRAFT_QUOTES_ENABLED: "true", PROJECT_ALPHA_DRAFT_QUOTE_API_KEY: "quote-only-key-original",
      PROJECT_ALPHA_DRAFT_QUOTE_HMAC_SECRET: "original-hmac-secret-32-bytes-long", APPLICATION_KEY: "ltds",
      AUDIT_IP_SECRET: "audit-secret-for-this-local-test-only" } as Env;
    app = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
    app.use("*", async (c, next) => { c.set("principal", principal); c.set("administrator", true); await next(); });
    registerProjectAlphaDraftQuoteRoutes(app);
  }, 120_000);
  beforeEach(() => {
    acl.allowed = true;
    sender = vi.fn<typeof fetch>(async () => Response.json(remoteResult));
    vi.stubGlobal("fetch", sender);
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  afterAll(async () => { await runtime?.dispose(); });

  it("reserves before send, records receipt and both audits, and replays without rebasing the original editor origin", async () => {
    const f = await fixture("success");
    sender.mockImplementation(async (input, init) => {
      const command = await delivery.prepare("SELECT source_id,command_endpoint,idempotency_key,payload_json FROM request_pa_draft_quote_commands WHERE request_id=?").bind(f.requestId).first();
      expect(command).toMatchObject({ source_id: primary, command_endpoint: String(input), idempotency_key: new Headers(init?.headers).get("Idempotency-Key"), payload_json: init?.body });
      expect((await counts(f)).receipts).toBe(0);
      return Response.json(remoteResult);
    });
    const response = await call(f);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ idempotentReplay: false, sourceId: primary, editorUrl: "https://alpha.example/quotes/alpha-quote/edit" });
    expect(await counts(f)).toEqual({ commands: 1, receipts: 1, audits: 1, logs: 1 });
    const firstNotices = await draftNotices(f);
    expect(firstNotices).toHaveLength(1);
    expect(firstNotices[0]).toMatchObject({ event_type: "pa_draft_quote_created", recipient_kind: "client_requester",
      status: "pending", dedupe_exact: 1, receipt_id: expect.any(String) });
    expect(JSON.parse(String(firstNotices[0]?.payload_json))).toEqual({ lifecycle: "accepted_linked",
      action: "open_client_portal", title: "Original title", projectId: null, projectName: null,
      serviceCategory: null, locationLabel: null });
    const replay = await call(f, { PROJECT_ALPHA_BASE_URL: "https://changed.example", APPLICATION_KEY: "changed-app" });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ idempotentReplay: true, editorUrl: "https://alpha.example/quotes/alpha-quote/edit" });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(await counts(f)).toEqual({ commands: 1, receipts: 1, audits: 1, logs: 1 });
    expect(await draftNotices(f)).toEqual(firstNotices);
  }, 30_000);

  it("retries an uncertain upstream outcome using the identical saved body and idempotency key", async () => {
    const f = await fixture("uncertain");
    sender.mockRejectedValueOnce(new Error("connection ended after upstream acceptance"));
    const uncertain = await call(f);
    expect(uncertain.status).toBe(503);
    expect(await uncertain.json()).toMatchObject({ code: "integration_unavailable" });
    expect(await counts(f)).toEqual({ commands: 1, receipts: 0, audits: 0, logs: 0 });
    const retry = await call(f);
    expect(retry.status).toBe(201);
    const [first, second] = sender.mock.calls;
    expect(first?.[0]).toBe(second?.[0]);
    expect(first?.[1]?.body).toBe(second?.[1]?.body);
    expect(new Headers(first?.[1]?.headers).get("Idempotency-Key")).toBe(new Headers(second?.[1]?.headers).get("Idempotency-Key"));
    expect(await counts(f)).toEqual({ commands: 1, receipts: 1, audits: 1, logs: 1 });
  }, 30_000);

  it("blocks a newer area revision while an earlier command remains unconfirmed, including its GET capability", async () => {
    const f = await fixture("unresolved-older-area");
    sender.mockRejectedValueOnce(new Error("timeout after possible upstream acceptance"));
    expect((await call(f)).status).toBe(503);
    await addAreaRevision(f);
    const response = await call(f);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "reconciliation_required" });
    const read = await call(f, {}, "GET");
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ capability: { enabled: false, reason: expect.stringMatching(/reconcile/i) }, receipt: null });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(new Headers(sender.mock.calls[0]?.[1]?.headers).get("Idempotency-Key"))
      .toBe(projectAlphaDraftIdempotencyKey(f.requestId, 1, 0));
    expect(await delivery.prepare("SELECT request_revision,area_revision FROM request_pa_draft_quote_commands WHERE request_id=?")
      .bind(f.requestId).all()).toMatchObject({ results: [{ request_revision: 1, area_revision: 0 }] });
    expect(await counts(f)).toEqual({ commands: 1, receipts: 0, audits: 0, logs: 0 });
  }, 30_000);

  it("checks unresolved older commands in the reservation INSERT, not only in the preceding read", async () => {
    const f = await fixture("unresolved-reservation-race");
    await addAreaRevision(f);
    // Deliberately insert the older journal at the storage boundary, after the
    // route's reads. All application SQL still executes against actual D1.
    const raced = beforeCommandInsert(delivery, () => insertUnresolvedOriginalCommand(f));
    const response = await call(f, { DELIVERY_DB: raced });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "reconciliation_required" });
    expect(sender).not.toHaveBeenCalled();
    expect(await delivery.prepare("SELECT id,area_revision FROM request_pa_draft_quote_commands WHERE request_id=?")
      .bind(f.requestId).all()).toMatchObject({ results: [{ id: `older-command-${f.requestId}`, area_revision: 0 }] });
    expect(await counts(f)).toEqual({ commands: 1, receipts: 0, audits: 0, logs: 0 });
  }, 30_000);

  it("rejects a changed origin or application after uncertainty without another network call", async () => {
    const f = await fixture("destination-change");
    sender.mockRejectedValueOnce(new Error("uncertain"));
    expect((await call(f)).status).toBe(503);
    for (const overrides of [{ PROJECT_ALPHA_BASE_URL: "https://other.example" }, { APPLICATION_KEY: "other-app" }]) {
      const response = await call(f, overrides);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "destination_changed" });
    }
    expect(sender).toHaveBeenCalledTimes(1);
    expect(await counts(f)).toEqual({ commands: 1, receipts: 0, audits: 0, logs: 0 });
  }, 30_000);

  it("allows credential rotation with the same reserved destination without storing credentials", async () => {
    const f = await fixture("credential-rotation");
    sender.mockRejectedValueOnce(new Error("uncertain"));
    expect((await call(f)).status).toBe(503);
    const response = await call(f, { PROJECT_ALPHA_DRAFT_QUOTE_API_KEY: "rotated-quote-only-key",
      PROJECT_ALPHA_DRAFT_QUOTE_HMAC_SECRET: "rotated-hmac-secret-32-bytes-long!" });
    expect(response.status).toBe(201);
    expect(new Headers(sender.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe("Bearer rotated-quote-only-key");
    const stored = JSON.stringify(await delivery.prepare("SELECT * FROM request_pa_draft_quote_commands WHERE request_id=?").bind(f.requestId).first());
    expect(stored).not.toContain("rotated-quote-only-key");
    expect(stored).not.toContain("rotated-hmac-secret");
    expect(await counts(f)).toEqual({ commands: 1, receipts: 1, audits: 1, logs: 1 });
  }, 30_000);

  it("keeps historical origins unknown and never resends or creates a journal for a recorded legacy revision", async () => {
    const overrides = { PROJECT_ALPHA_BASE_URL: "https://different.example", APPLICATION_KEY: "different-app" };
    const read = await call(legacy, overrides, "GET");
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ receipt: { editorUrl: null, editorUnavailableReason: "legacy_destination_unknown", sourceId: primary } });
    const replay = await call(legacy, overrides);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ idempotentReplay: true, editorUrl: null, editorUnavailableReason: "legacy_destination_unknown" });
    expect(sender).not.toHaveBeenCalled();
    expect(await counts(legacy)).toEqual({ commands: 0, receipts: 1, audits: 0, logs: 0 });
  }, 30_000);

  it.each(["request_scope", "project_grant", "primary_projection", "staff_permission"])("quarantines the confirmed remote result when %s changes while fetch is in progress", async change => {
    const f = await fixture(`stale-${change}`);
    sender.mockImplementation(async () => {
      if (change === "request_scope") await delivery.prepare("UPDATE client_service_requests SET title='Changed title' WHERE id=?").bind(f.requestId).run();
      else if (change === "project_grant") await delivery.prepare("UPDATE client_project_grants SET revoked_at=datetime('now') WHERE account_id=? AND project_id=?").bind(f.accountId, f.projectId).run();
      else if (change === "primary_projection") await operations.prepare("UPDATE pa_projects SET active=0 WHERE id=?").bind(f.paProjectId).run();
      else acl.allowed = false;
      return Response.json(remoteResult);
    });
    const response = await call(f);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "scope_changed" });
    const recorded = await delivery.prepare("SELECT scope_stale_at,command_id,project_alpha_receipt_id FROM request_pa_draft_quote_receipts WHERE request_id=?").bind(f.requestId).first();
    expect(recorded).toMatchObject({ scope_stale_at: expect.any(String), command_id: expect.any(String), project_alpha_receipt_id: "alpha-receipt" });
    expect(await delivery.prepare("SELECT action FROM request_admin_audit WHERE request_id=?").bind(f.requestId).first("action")).toBe("pa_draft_quote_scope_stale");
    expect(await counts(f)).toEqual({ commands: 1, receipts: 1, audits: 1, logs: 1 });
    expect(await draftNotices(f)).toEqual([]);
  }, 30_000);

  it("uses the final Delivery SQL proof when scope changes after the post-fetch JavaScript checks", async () => {
    const f = await fixture("commit-race");
    const raced = beforeReceiptBatch(delivery, () => delivery.prepare("UPDATE client_service_requests SET title='Changed at commit' WHERE id=?").bind(f.requestId).run());
    const response = await call(f, { DELIVERY_DB: raced });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "scope_changed" });
    expect(await delivery.prepare("SELECT scope_stale_at FROM request_pa_draft_quote_receipts WHERE request_id=?").bind(f.requestId).first("scope_stale_at")).toEqual(expect.any(String));
    expect(await counts(f)).toEqual({ commands: 1, receipts: 1, audits: 1, logs: 1 });
  }, 30_000);

  it.each(["catalog", "business"])("never sends a secondary %s source to the primary connector", async kind => {
    const f = await fixture(`secondary-${kind}`, kind === "catalog" ? { catalogSource: secondary } : { businessSource: secondary });
    const response = await call(f);
    expect(response.status).toBe(409);
    expect(sender).not.toHaveBeenCalled();
    expect(await counts(f)).toEqual({ commands: 0, receipts: 0, audits: 0, logs: 0 });
  }, 30_000);

  it("routes a native request through its exact registered source and ignores synthetic storage identities", async () => {
    const { f, ids, credentials } = await nativeFixture("native-success");
    await delivery.prepare(`UPDATE client_accounts SET project_alpha_client_id='synthetic-wrong-client',
      project_alpha_organization_id='synthetic-wrong-org' WHERE id=?`).bind(f.accountId).run();
    const override = { PROJECT_ALPHA_CONNECTOR_CREDENTIALS: JSON.stringify(credentials) };
    const capability = await call(f, override, "GET");
    expect(capability.status).toBe(200);
    const capabilityBody = await capability.json() as { capability: { enabled: boolean; reason: string | null } };
    expect(capabilityBody.capability).toEqual({ enabled: true, reason: null });
    sender.mockImplementationOnce(async (input, init) => {
      expect(String(input)).toBe("https://secondary.example.test/api/v2/integrations/secondary_ops/draft-quotes");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer secondary-draft-only-api-key");
      expect(headers.get("X-Portal-Integration-Application-Key")).toBe("secondary_ops");
      const body = JSON.parse(String(init?.body)) as ProjectAlphaDraftQuotePayload;
      expect(body.authorization).toEqual({ organizationPublicId: ids.root, clientPublicId: ids.client, projectPublicId: ids.project });
      expect(JSON.stringify(body)).not.toContain("synthetic-wrong");
      return Response.json(remoteResult);
    });
    const response = await call(f, override);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ sourceId: secondary, editorUrl: "https://secondary.example.test/quotes/alpha-quote/edit" });
    expect(await counts(f)).toEqual({ commands: 1, receipts: 1, audits: 1, logs: 1 });
    expect(await draftNotices(f)).toEqual([
      expect.objectContaining({ event_type: "pa_draft_quote_created", recipient_kind: "native_request_owner",
        status: "pending", dedupe_exact: 1 }),
    ]);
  }, 30_000);

  it.each(["generation", "project", "client_projection", "credential", "workspace"])(
    "fails closed before a native send when its %s proof is stale", async change => {
      const { f, ids, credentials } = await nativeFixture(`native-stale-${change}`);
      const override: Partial<Env> = { PROJECT_ALPHA_CONNECTOR_CREDENTIALS: JSON.stringify(credentials) };
      if (change === "generation")
        await delivery.prepare("UPDATE portal_v2_directory_generations SET complete=0,status='rejected' WHERE id=?").bind(ids.generation).run();
      else if (change === "project")
        await operations.prepare(`UPDATE pa_projects SET active=0 WHERE projection_source_id=?
          AND json_extract(payload_json,'$.public_id')=?`).bind(secondary,ids.project).run();
      else if (change === "client_projection") {
        const replacementId = `replacement-client-${ids.client}`;
        await operations.batch([
          operations.prepare(`INSERT INTO pa_clients(id,name,organization_id,projection_source_id,active,payload_json)
            VALUES(?,'Replacement client',(SELECT id FROM pa_organizations WHERE projection_source_id=?
              AND json_extract(payload_json,'$.public_id')=?),?,1,?)`)
            .bind(replacementId,secondary,ids.root,secondary,JSON.stringify({public_id:`replacement-${ids.client}`})),
          operations.prepare(`UPDATE pa_projects SET client_id=? WHERE projection_source_id=?
            AND json_extract(payload_json,'$.public_id')=?`).bind(replacementId,secondary,ids.project),
        ]);
      }
      else if (change === "workspace")
        await delivery.prepare("UPDATE portal_v2_workspaces SET status='suspended' WHERE id=?").bind(ids.workspace).run();
      else {
        const changed = structuredClone(credentials);
        changed.sets.NATIVE.draftQuote.apiKey = "rotated-without-enrollment";
        override.PROJECT_ALPHA_CONNECTOR_CREDENTIALS = JSON.stringify(changed);
      }
      try {
        const response = await call(f, override);
        expect([409,503]).toContain(response.status);
        expect(sender).not.toHaveBeenCalled();
        expect(await counts(f)).toEqual({ commands: 0, receipts: 0, audits: 0, logs: 0 });
      } finally {
        if (change === "workspace")
          await delivery.prepare("UPDATE portal_v2_workspaces SET status='active' WHERE id=?").bind(ids.workspace).run();
      }
    }, 30_000);

  it.each(["lineage", "client_relation"])(
    "never sends when native %s is reassigned during command reservation", async change => {
      const { f, ids, credentials } = await nativeFixture(`native-race-${change}`);
      const raced = beforeCommandInsert(delivery, async () => {
        const replacementPublicId = `replacement-${ids.client}`;
        if (change === "lineage") {
          await delivery.batch([
            delivery.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,
              display_name,source_version,active) VALUES(?,?,'client',?,?,'Replacement client','client-v2',1)`)
              .bind(ids.workspace,ids.generation,replacementPublicId,ids.root),
            delivery.prepare(`UPDATE portal_v2_directory_entities SET parent_public_id=?
              WHERE workspace_id=? AND generation_id=? AND entity_type='project' AND public_id=?`)
              .bind(replacementPublicId,ids.workspace,ids.generation,ids.project),
          ]);
        } else {
          const replacementId = `replacement-client-${ids.client}`;
          await operations.batch([
            operations.prepare(`INSERT INTO pa_clients(id,name,organization_id,projection_source_id,active,payload_json)
              VALUES(?,'Replacement client',(SELECT id FROM pa_organizations WHERE projection_source_id=?
                AND json_extract(payload_json,'$.public_id')=?),?,1,?)`)
              .bind(replacementId,secondary,ids.root,secondary,JSON.stringify({public_id:replacementPublicId})),
            operations.prepare(`UPDATE pa_projects SET client_id=? WHERE projection_source_id=?
              AND json_extract(payload_json,'$.public_id')=?`).bind(replacementId,secondary,ids.project),
          ]);
        }
      });
      const response = await call(f, {
        DELIVERY_DB: raced,
        PROJECT_ALPHA_CONNECTOR_CREDENTIALS: JSON.stringify(credentials),
      });
      expect(response.status).toBe(409);
      expect(sender).not.toHaveBeenCalled();
      expect((await counts(f)).receipts).toBe(0);
      expect((await counts(f)).audits).toBe(0);
      expect((await counts(f)).logs).toBe(0);
      expect((await counts(f)).commands).toBe(change === "lineage" ? 0 : 1);
    }, 30_000);

  it("does not resend a saved command after the current payload changes under the same immutable revision key", async () => {
    const f = await fixture("changed-payload");
    sender.mockRejectedValueOnce(new Error("uncertain"));
    expect((await call(f)).status).toBe(503);
    await delivery.prepare("UPDATE client_service_requests SET title='Changed without revision' WHERE id=?").bind(f.requestId).run();
    const response = await call(f);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "idempotency_conflict" });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(await counts(f)).toEqual({ commands: 1, receipts: 0, audits: 0, logs: 0 });
  }, 30_000);

  it("converges racing reservations and confirmed identical receipts to one journal, receipt and audit pair", async () => {
    const f = await fixture("concurrent");
    let arrivals = 0, release: () => void = () => undefined;
    const bothInFlight = new Promise<void>(resolve => { release = resolve; });
    sender.mockImplementation(async () => { if (++arrivals === 2) release(); await bothInFlight; return Response.json(remoteResult); });
    const responses = await Promise.all([call(f), call(f)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
    const bodies = await Promise.all(responses.map(response => response.json()));
    expect(bodies).toEqual(expect.arrayContaining([expect.objectContaining({ idempotentReplay: true }), expect.objectContaining({ idempotentReplay: false })]));
    expect(sender).toHaveBeenCalledTimes(2);
    expect(new Headers(sender.mock.calls[0]?.[1]?.headers).get("Idempotency-Key"))
      .toBe(new Headers(sender.mock.calls[1]?.[1]?.headers).get("Idempotency-Key"));
    expect(await counts(f)).toEqual({ commands: 1, receipts: 1, audits: 1, logs: 1 });
  }, 30_000);

  it.each(["project_grant", "staff_permission"])("does not reuse a clean concurrent winner after %s is revoked for the still-in-flight caller", async change => {
    const f = await fixture(`concurrent-revoked-${change}`);
    let arrivals = 0, releaseBoth: () => void = () => undefined, releaseSecond: () => void = () => undefined;
    const bothInFlight = new Promise<void>(resolve => { releaseBoth = resolve; });
    const secondCanReturn = new Promise<void>(resolve => { releaseSecond = resolve; });
    sender.mockImplementation(async () => {
      const arrival = ++arrivals;
      if (arrival === 2) releaseBoth();
      await bothInFlight;
      if (arrival === 2) await secondCanReturn;
      return Response.json(remoteResult);
    });
    const pending = [call(f), call(f)];
    try {
      const winner = await Promise.race(pending);
      expect(winner.status).toBe(201);
      expect(await delivery.prepare("SELECT scope_stale_at FROM request_pa_draft_quote_receipts WHERE request_id=?")
        .bind(f.requestId).first()).toEqual({ scope_stale_at: null });
      if (change === "project_grant") await delivery.prepare("UPDATE client_project_grants SET revoked_at=datetime('now') WHERE account_id=? AND project_id=?")
        .bind(f.accountId, f.projectId).run();
      else acl.allowed = false;
      releaseSecond();
      const responses = await Promise.all(pending);
      expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
      const rejected = responses.find(response => response.status === 409);
      expect(await rejected?.json()).toMatchObject({ code: "scope_changed" });
      expect(sender).toHaveBeenCalledTimes(2);
      expect(new Headers(sender.mock.calls[0]?.[1]?.headers).get("Idempotency-Key"))
        .toBe(new Headers(sender.mock.calls[1]?.[1]?.headers).get("Idempotency-Key"));
      // The durable winner is not rewritten; it is simply no longer permission
      // for this later caller to use the receipt after losing current access.
      expect(await delivery.prepare("SELECT scope_stale_at FROM request_pa_draft_quote_receipts WHERE request_id=?")
        .bind(f.requestId).first()).toEqual({ scope_stale_at: null });
      expect(await counts(f)).toEqual({ commands: 1, receipts: 1, audits: 1, logs: 1 });
    } finally {
      releaseBoth(); releaseSecond();
      await Promise.all(pending);
    }
  }, 30_000);

  it("rolls back receipt and both audits together on local failure, then reconciles the same reserved upstream command", async () => {
    const f = await fixture("audit-failure");
    await delivery.prepare(`CREATE TRIGGER quote_route_fixture_audit_failure BEFORE INSERT ON request_admin_audit
      WHEN NEW.request_id='request-audit-failure' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END`).run();
    try {
      const failed = await call(f);
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({ code: "receipt_unconfirmed" });
      expect(await counts(f)).toEqual({ commands: 1, receipts: 0, audits: 0, logs: 0 });
    } finally { await delivery.prepare("DROP TRIGGER quote_route_fixture_audit_failure").run(); }
    expect((await call(f)).status).toBe(201);
    expect(sender).toHaveBeenCalledTimes(2);
    expect(sender.mock.calls[0]?.[1]?.body).toBe(sender.mock.calls[1]?.[1]?.body);
    expect(await counts(f)).toEqual({ commands: 1, receipts: 1, audits: 1, logs: 1 });
  }, 30_000);

  it("does not suppress the actual pre-0201 event CHECK and rolls back the receipt transaction", async () => {
    const f = await fixture("pre0201-check");
    const directory = new URL("../../client/migrations/", import.meta.url);
    await rebuildPre0201Outbox(directory);
    const schema = await delivery.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='client_portal_notification_outbox'").first<string>("sql");
    expect(schema).toContain("'request_work_area_changed'");
    expect(schema).not.toContain("'pa_draft_quote_created'");

    // This is the former producer statement's exact failure mode: SQLite's
    // broad OR IGNORE conflict policy suppresses the genuine CHECK violation.
    const ignored = await delivery.prepare(`INSERT OR IGNORE INTO client_portal_notification_outbox
      (id,request_id,event_type,recipient_kind,dedupe_key,payload_json)
      VALUES('legacy-ignore-probe',?,'pa_draft_quote_created','client_requester','legacy-ignore-probe','{}')`)
      .bind(f.requestId).run();
    expect(ignored.meta.changes).toBe(0);
    expect(await draftNotices(f)).toEqual([]);

    const failed = await call(f);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: "receipt_unconfirmed" });
    expect(await counts(f)).toEqual({ commands: 1, receipts: 0, audits: 0, logs: 0 });
    expect(await draftNotices(f)).toEqual([]);

    const upgrade = splitD1MigrationStatements(
      readFileSync(new URL("0201_native_draft_quote_notifications.sql", directory), "utf8"),
    );
    await delivery.batch(upgrade.map(sql => delivery.prepare(sql)));
    expect((await call(f)).status).toBe(201);
    expect(sender).toHaveBeenCalledTimes(2);
    expect(sender.mock.calls[0]?.[1]?.body).toBe(sender.mock.calls[1]?.[1]?.body);
    expect(await counts(f)).toEqual({ commands: 1, receipts: 1, audits: 1, logs: 1 });
    expect(await draftNotices(f)).toEqual([
      expect.objectContaining({ event_type: "pa_draft_quote_created", recipient_kind: "client_requester",
        status: "pending", dedupe_exact: 1 }),
    ]);
  }, 30_000);

  it("enforces the staff permission before reserving or sending anything", async () => {
    const f = await fixture("staff-denied"); acl.allowed = false;
    expect((await call(f)).status).toBe(403);
    expect(sender).not.toHaveBeenCalled();
    expect(await counts(f)).toEqual({ commands: 0, receipts: 0, audits: 0, logs: 0 });
  }, 30_000);
});
