import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { vi } from "vitest";
import { splitD1MigrationStatements } from "../../../client/test/helpers/d1-migrations";
import { registerVisibleTestSource } from "./project-alpha-connectors";
import type { NativeExistingImportActor, NativeExistingImportEnvironment, NativeExistingImportSelection } from "../../src/worker/native-directory-existing-import-types";

export const uuid = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const opaquePublicId = (n: number) => n.toString(16).padStart(32, "0");
let sequence = 1;

/** All real Ops migrations/guards are retained, including the new import migration. */
export async function fullImportDatabase() {
  const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('fixture')}}", d1Databases: ["OPS_DB", "DELIVERY_DB"] });
  const db = await runtime.getD1Database("OPS_DB") as D1Database;
  const delivery = await runtime.getD1Database("DELIVERY_DB") as D1Database;
  const directory = new URL("../../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort())
    await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
  await db.batch([
    db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('business-area-ltds','Ledge Top Drone Services',1)"),
    db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('business-area-ltt','Ledge Top Technologies',1)"),
  ]);
  // Separate D1 namespace: the importer receives OPS_DB only. These opaque
  // workspace/share rows are preservation sentinels, not import authority.
  await delivery.batch([
    delivery.prepare("CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,pa_client_public_id TEXT)"),
    delivery.prepare("CREATE TABLE shares(id TEXT PRIMARY KEY,workspace_id TEXT,token_hash TEXT,object_prefix TEXT)"),
  ]);
  return { runtime, db, delivery };
}

export type ImportFixture = Awaited<ReturnType<typeof importCase>>;
export async function importCase(db: D1Database, kind: "organization" | "client" = "organization",
  options: { area?: string; sourceId?: string; publicId?: string; classicId?: string; parentRecordId?: string | null; parentPublicId?: string | null;
    sourceFixture?: { identity: { sourceInstanceId: string; applicationId: string; historyEpoch: string }; selection: NativeExistingImportSelection }; batchId?: string } = {}) {
  const n = sequence++, sourceId = options.sourceId ?? `project-alpha:import-${n}`;
  const staffId = `import-reviewer-${n}`, accessSubject = `access|import-${n}`, loginEmail = `reviewer${n}@example.test`;
  const identity = options.sourceFixture?.identity ?? { sourceInstanceId: uuid(n * 100 + 1), applicationId: uuid(n * 100 + 2), historyEpoch: uuid(n * 100 + 3) };
  const publicId = options.publicId ?? opaquePublicId(n * 100 + 4), recordId = options.classicId ?? `${sourceId}:${kind}:classic-${n}`;
  const businessAreaId = options.area ?? "business-area-ltds";
  await registerVisibleTestSource(db, sourceId);
  const origin = await db.prepare("SELECT snapshot_origin FROM pa_connectors WHERE source_id=?").bind(sourceId).first<string>("snapshot_origin");
  if (!origin) throw new Error("fixture connector missing");
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,'active')").bind(staffId, loginEmail, `Reviewer ${n}`, accessSubject),
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(staffId, accessSubject, staffId),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(staffId, loginEmail, `Reviewer ${n}`),
    db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key,created_by) VALUES(?,?,'role-owner','global','global',?)").bind(`owner-${n}`, staffId, staffId),
    ...["directory.profile.view", "directory.profile.edit", "directory.identity.link", "directory.enrollment.manage"].map(permission =>
      db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES(?,?,?,'allow','global',?)")
        .bind(`${staffId}:${permission}`, staffId, permission, staffId)),
  ]);
  const profile = { publicId, name: "Existing PA customer", email: "same-customer@example.test", phone: "+1 555 0100",
    address: { line1: "1 Existing Road", line2: null, city: "Existing City", state: "WI", postalCode: "53000", country: "US" },
    ...(kind === "client" ? { clientType: "business" as const, organizationPublicId: options.parentPublicId ?? null } : {}) };
  const classicPayload = JSON.stringify({ id: `pa-internal-${n}`, public_id: publicId, name: profile.name, ...(kind === "client" ? { email: profile.email, phone: profile.phone } : {}),
    client_type: "business", address_line1: profile.address.line1, address_line2: profile.address.line2,
    city: profile.address.city, state: profile.address.state, postal_code: profile.address.postalCode, country: profile.address.country });
  await db.prepare("INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id) VALUES(?,?,?,?)")
    .bind(sourceId, kind, `pa-internal-${n}`, recordId).run();
  if (kind === "organization") await db.prepare("INSERT INTO pa_organizations(id,name,active,payload_json,last_sync_id,projection_source_id) VALUES(?,?,1,?,'fixture-existing',?)")
    .bind(recordId, profile.name, classicPayload, sourceId).run();
  else await db.prepare("INSERT INTO pa_clients(id,name,organization_id,active,payload_json,last_sync_id,projection_source_id) VALUES(?,?,?,1,?,'fixture-existing',?)")
    .bind(recordId, profile.name, options.parentRecordId ?? null, classicPayload, sourceId).run();
  const requestId = uuid(n * 100 + 5);
  await db.batch([
    db.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,history_epoch_id,
      inventory_kind,request_id,authorization_generation,requested_cursor,next_cursor,page_sha256,item_count)
      VALUES(?,?,?,?,'directory',?,'5',NULL,NULL,?,1)`).bind(sourceId, identity.sourceInstanceId, identity.applicationId, identity.historyEpoch, requestId, sha(classicPayload)),
    db.prepare(`INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,history_epoch_id,
      request_id,resource_type,project_alpha_public_id,resource_revision,present,last_action,projection_sha256,
      binding_external_id,binding_status,binding_resource_revision) VALUES(?,?,?,?,?,?,?,'7',1,'upsert',?,NULL,NULL,NULL)`)
      .bind(sourceId, identity.sourceInstanceId, identity.applicationId, identity.historyEpoch, requestId, kind, publicId, sha(JSON.stringify(profile))),
  ]);
  const env: NativeExistingImportEnvironment = { OPS_DB: db, NATIVE_DIRECTORY_EXISTING_IMPORT_ENABLED: "true",
    NATIVE_DIRECTORY_EXISTING_IMPORT_AREAS: JSON.stringify({ [sourceId]: businessAreaId }),
    PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: { [sourceId]: { sourceId, enabled: true,
      baseUrl: origin, apiKey: "synthetic-import-test-only", ...identity } } }) };
  const actor: NativeExistingImportActor = { staffId, accessSubject, loginEmail, admissionVersion: 1, profileVersion: 1,
    grantGeneration: await db.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?").bind(staffId).first<number>("generation") ?? -1,
    verifiedUntil: new Date(Date.now() + 3_600_000).toISOString() };
  const selection: NativeExistingImportSelection = { sourceId, kind, recordId, businessAreaId, idempotencyKey: uuid(n * 100 + 6),
    batchId: options.batchId ?? options.sourceFixture?.selection.batchId ?? uuid(n * 100 + 7) };
  const initialNativeCount = await db.prepare("SELECT count(*) n FROM operations_directory_records").first<number>("n");
  return { db, env, actor, selection, identity, origin, profile, classicPayload, publicId, requestId, n,
    nativeRecordId: `pa-import:${sourceId}:${kind}:${recordId}` as string | undefined, initialNativeCount };
}

/** Only existing-object binding POSTs are admitted. Any PA create endpoint fails the test. */
export function paImportTransport(fixtures: readonly ImportFixture[]) {
  type State = { fixture: ImportFixture; fixtures: ImportFixture[]; generation: number; boundRecords: Set<string>;
    loseNextAck: boolean; wrongEpoch: boolean; tombstoned: boolean; profileName: string;
    commands: Map<string, Record<string, unknown>> };
  const states = new Map<string, State>();
  for (const f of fixtures) {
    const prior = states.get(f.origin);
    if (prior) prior.fixtures.push(f);
    else states.set(f.origin, { fixture: f, fixtures: [f], generation: 5, boundRecords: new Set(),
      loseNextAck: false, wrongEpoch: false, tombstoned: false, profileName: f.profile.name, commands: new Map() });
  }
  let requestSequence = 100_000;
  const fetcher = vi.fn<typeof fetch>(async (request, init) => {
    const url = new URL(request instanceof Request ? request.url : String(request)), state = states.get(url.origin);
    if (!state) throw new Error(`Unexpected network destination ${url.origin}`);
    const method = init?.method ?? "GET", sent = method === "POST" ? JSON.parse(String(init?.body)) as Record<string, unknown> : null;
    const f = state.fixtures.find(f => url.pathname.endsWith(`/${f.publicId}`)
      || sent?.expectedPublicId === f.publicId
      || url.pathname.endsWith(`/${Buffer.from(f.nativeRecordId ?? f.selection.recordId).toString("base64url")}`)) ?? state.fixture;
    const requestId = uuid(requestSequence++);
    const common = { sourceInstanceId: f.identity.sourceInstanceId, applicationId: f.identity.applicationId,
      historyEpoch: state.wrongEpoch ? uuid(999_999) : f.identity.historyEpoch };
    const json = (value: Record<string, unknown>, status = 200) => new Response(JSON.stringify({ ...value, requestId }), {
      status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Request-ID": requestId } });
    if (url.pathname === "/api/v2/capabilities") {
      const kinds = ["organization", "client"] as const;
      const endpoints = kinds.flatMap(kind => {
        const plural = kind === "client" ? "clients" : "organizations";
        return [
          { method: "GET", path: `/api/v2/directory/${plural}/{publicId}`, requiredCapability: `directory.${plural}.read`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
          { method: "GET", path: `/api/v2/bindings/${kind}/status/{base64urlExternalId}`, requiredCapability: `directory.${plural}.binding_status.read`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
          { method: "POST", path: `/api/v2/directory/${plural}/bindings/commands`, requiredCapability: `directory.${plural}.bind`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true, requiresExpectedPublicId: true, requiresExpectedRevision: true },
        ];
      });
      return json({ apiVersion: "2", ...common, grantedCapabilities: ["api.capabilities.read", ...endpoints.map(e => e.requiredCapability)].map(name => ({ name })),
        implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" }, ...endpoints] });
    }
    const plural = f.selection.kind === "client" ? "clients" : "organizations";
    if (url.pathname === `/api/v2/directory/${plural}/${f.publicId}` && method === "GET")
      return json({ apiVersion: "2", ...common, authorizationGeneration: String(state.generation),
        resource: { type: f.selection.kind, id: f.publicId, revision: "7" }, data: { ...f.profile, name: state.profileName } });
    if (url.pathname.startsWith(`/api/v2/bindings/${f.selection.kind}/status/`) && method === "GET") {
      if (state.tombstoned) return json({ code: "BINDING_TOMBSTONED" }, 410);
      if (!state.boundRecords.has(f.nativeRecordId ?? f.selection.recordId)) return json({ code: "BINDING_NOT_FOUND" }, 404);
      return json({ apiVersion: "2", ...common, authorizationGeneration: String(state.generation),
        binding: { type: f.selection.kind, externalId: f.nativeRecordId ?? f.selection.recordId, publicId: f.publicId, createdAt: "2026-10-15T12:00:00.000Z" }, resource: { revision: "7", present: true } });
    }
    if (url.pathname === `/api/v2/directory/${plural}/bindings/commands` && method === "POST") {
      const command = sent!;
      const old = state.commands.get(String(command.commandId));
      if (old) return json({ ...old, replayed: true });
      if (command.expectedPublicId !== f.publicId || command.externalId !== (f.nativeRecordId ?? f.selection.recordId) || command.expectedAuthorizationGeneration !== String(state.generation))
        return json({ code: "COMMAND_CONFLICT" }, 409);
      state.boundRecords.add(String(command.externalId)); state.generation++;
      const result = { ...common, replayed: false, result: { binding: { publicId: f.publicId },
        resource: { type: f.selection.kind, id: String(command.externalId), revision: "7" }, authorizationGeneration: String(state.generation) } };
      state.commands.set(String(command.commandId), result);
      if (state.loseNextAck) { state.loseNextAck = false; throw new Error("PA committed; acknowledgement lost"); }
      return json(result);
    }
    throw new Error(`Unexpected PA endpoint ${method} ${url.pathname}`);
  });
  return { fetcher, states, posts: () => fetcher.mock.calls.filter(([, init]) => init?.method === "POST") };
}

export async function preservationRows(db: D1Database) {
  const names = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all<{ name: string }>();
  const selected = names.results.map(r => r.name).filter(name => /grant|portal|financial|billing|notification|native_staff_|staff_role|staff_permission/.test(name));
  const result: Record<string, unknown[]> = {};
  const rows = await db.batch(selected.map(name => db.prepare(`SELECT * FROM "${name}"`)));
  for (const [index, name] of selected.entries())
    result[name] = [...rows[index]!.results].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return result;
}

export async function noRemoteCreateRows(db: D1Database) {
  const result: Record<string, number> = {};
  for (const table of ["project_alpha_directory_outbox", "operations_directory_intents", "operations_directory_materializations"])
    result[table] = await db.prepare(`SELECT count(*) n FROM ${table}`).first<number>("n") ?? -1;
  return result;
}
