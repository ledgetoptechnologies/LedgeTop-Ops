import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { readBoundedJson } from "./bounded-json";
import { authenticateNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import {
  writeNativeDirectoryProfile,
  type NativeDirectoryClientCreateProfile,
  type NativeDirectoryClientUpdateProfile,
  type NativeDirectoryDestinationAuthority,
  type NativeDirectoryOrganizationProfile,
  type NativeDirectoryProfileKind,
  type NativeDirectoryProfileWrite,
  type NativeDirectoryProfileWriteOutcome,
  type NativeDirectoryScope,
  type NativeDirectoryWriterActor,
} from "./native-directory-profile-writer";
import { resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";
import type { Env, StaffPrincipal } from "./types";

type Variables = { principal: StaffPrincipal; administrator: boolean };
type App = Hono<{ Bindings: Env; Variables: Variables }>;
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export const NATIVE_DIRECTORY_PROFILE_ROUTE = "/api/client-hub/directory";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVISION = /^(?:0|[1-9][0-9]{0,18})$/;
const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_BODY_BYTES = 24 * 1024;

const mutationId = z.string().regex(UUID);
const sourceIds = z.array(z.string().regex(SOURCE_ID)).min(1).max(16)
  .refine(values => new Set(values).size === values.length);
const scalar = (maximum: number, required = false) => z.string().max(maximum)
  .refine(value => !/[\p{C}]/u.test(value))
  .refine(value => !required || value.length > 0);
const scope = z.object({ businessAreaId: scalar(191, true), divisionId: scalar(191, true).nullable() }).strict();
const scopes = z.array(scope).min(1).max(64)
  .refine(values => new Set(values.map(value => `${value.businessAreaId}\0${value.divisionId ?? ""}`)).size === values.length);
const organizationProfile = z.object({
  name: scalar(150, true), generalEmail: scalar(255), generalPhone: scalar(50), addressLine1: scalar(255),
  addressLine2: scalar(255), city: scalar(100), state: scalar(100), postalCode: scalar(32), country: scalar(100),
}).strict();
const clientCreateProfile = z.object({
  name: scalar(150, true), email: scalar(255), phone: scalar(50), clientType: z.enum(["unknown", "business", "consumer"]),
  addressLine1: scalar(255), addressLine2: scalar(255), city: scalar(100), state: scalar(2), postalCode: scalar(20), country: scalar(100),
}).strict();
const clientUpdateProfile = clientCreateProfile.omit({ clientType: true });
const organizationCreate = z.object({ mutationId, sourceIds, scopes, profile: organizationProfile }).strict();
const clientCreate = z.object({ mutationId, sourceIds, scopes, profile: clientCreateProfile }).strict();
const createAdmissionIntent = z.discriminatedUnion("kind", [
  organizationCreate.extend({ kind: z.literal("organization") }).strict(),
  clientCreate.extend({ kind: z.literal("client") }).strict(),
]);
const organizationUpdate = z.object({ mutationId, expectedLocalVersion: z.number().int().positive(), profile: organizationProfile }).strict();
const clientUpdate = z.object({ mutationId, expectedLocalVersion: z.number().int().positive(), profile: clientUpdateProfile }).strict();

type StoredDestination = Omit<NativeDirectoryDestinationAuthority, "expectedAuthorizationGeneration">;
type StoredCreateAdmission = {
  id: string; staff_id: string; bound_access_subject: string; record_id: string; record_kind: string;
  scopes_json: string; profile_json: string; destinations_json: string; active: number;
  consumed_mutation_id: string | null; issued_by: string;
};

export function nativeDirectoryProfileWritesEnabled(env: Pick<Env, "NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED">): boolean {
  return env.NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED === "true";
}

function recordId(kind: NativeDirectoryProfileKind, id: string): string {
  return id;
}

function normalizeProfile(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).map(([field, item]) => {
    const normalized = item.normalize("NFC").trim();
    return [field, field === "email" || field === "generalEmail" ? normalized.toLowerCase() : normalized];
  }));
}

function normalizeScopes(values: readonly NativeDirectoryScope[]): NativeDirectoryScope[] {
  return values.map(value => ({ ...value })).sort((left, right) =>
    `${left.businessAreaId}\0${left.divisionId ?? ""}`.localeCompare(`${right.businessAreaId}\0${right.divisionId ?? ""}`));
}

async function nativeActor(c: AppContext): Promise<Omit<NativeDirectoryWriterActor, "selectedGrantId" | "selectedIdentityGrantId">> {
  let authenticated: Awaited<ReturnType<typeof authenticateNativeStaffWithAdmissionVersion>>;
  try {
    authenticated = await authenticateNativeStaffWithAdmissionVersion(c.req.raw, c.env.OPS_DB, {
      enabled: true, issuer: c.env.TEAM_DOMAIN ?? "", staffAudience: c.env.OPERATIONS_AUD,
    });
  } catch { throw new HTTPException(403, { message: "Current native staff authority is required" }); }
  const principal = c.get("principal"), identity = authenticated.identity;
  if (identity.staffId !== principal.id || identity.email !== principal.email
    || identity.verifiedAccessSubject !== principal.accessSubject)
    throw new HTTPException(403, { message: "Operations and native staff identities do not match" });
  return { staffId: identity.staffId, accessSubject: identity.verifiedAccessSubject,
    admissionVersion: authenticated.admissionVersion, loginEmail: identity.email, profileVersion: identity.profileVersion };
}

async function selectGrant(db: D1Database, staffId: string,
  permission: "directory.profile.edit" | "directory.identity.link" | "directory.enrollment.manage",
  record: string, requestedScopes: readonly NativeDirectoryScope[], creating: boolean): Promise<string | null> {
  const primary = db.withSession("first-primary"), scopeJson = JSON.stringify(requestedScopes);
  const applies = creating ? `(grant.scope_kind='global'
      OR (grant.scope_kind='business_area' AND EXISTS(SELECT 1 FROM json_each(?) scope
        WHERE json_extract(scope.value,'$.businessAreaId')=grant.business_area_id))
      OR (grant.scope_kind='division' AND EXISTS(SELECT 1 FROM json_each(?) scope
        WHERE json_extract(scope.value,'$.divisionId')=grant.division_id)))`
    : `(grant.scope_kind='global' OR (grant.scope_kind='resource' AND grant.resource_id=?)
      OR (grant.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
        WHERE assignment.record_id=? AND assignment.staff_id=? AND assignment.active=1))
      OR (grant.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
        WHERE scope.record_id=? AND scope.active=1 AND scope.business_area_id=grant.business_area_id))
      OR (grant.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
        WHERE scope.record_id=? AND scope.active=1 AND scope.division_id=grant.division_id)))`;
  const denyApplies = creating ? `(deny.scope_kind='global' OR (deny.scope_kind='resource' AND deny.resource_id=?)
      OR (deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM json_each(?) scope
        WHERE json_extract(scope.value,'$.businessAreaId')=deny.business_area_id))
      OR (deny.scope_kind='division' AND EXISTS(SELECT 1 FROM json_each(?) scope
        WHERE json_extract(scope.value,'$.divisionId')=deny.division_id)))`
    : applies.replaceAll("grant.", "deny.");
  const parameters = creating ? [scopeJson, scopeJson] : [record, record, staffId, record, record];
  const denyParameters = creating ? [record, scopeJson, scopeJson] : parameters;
  const row = await primary.prepare(`SELECT grant.id FROM native_directory_grants grant
    WHERE grant.staff_id=? AND grant.permission=? AND grant.effect='allow' AND grant.active=1 AND ${applies}
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=grant.staff_id
        AND deny.permission=grant.permission AND deny.effect='deny' AND deny.active=1 AND ${denyApplies})
    ORDER BY CASE grant.scope_kind WHEN 'resource' THEN 1 WHEN 'division' THEN 2 WHEN 'business_area' THEN 3
      WHEN 'assigned' THEN 4 ELSE 5 END,grant.id LIMIT 1`).bind(staffId, permission, ...parameters, ...denyParameters)
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function configuredDestination(env: Env, sourceId: string, externalCanonicalId: string): Promise<StoredDestination | null> {
  try {
    if (!await env.OPS_DB.withSession("first-primary").prepare(`SELECT 1 ok FROM pa_connectors
      WHERE source_id=? AND state='active' AND read_visible=1`).bind(sourceId).first()) return null;
    const configured = resolveProjectAlphaApiV2Connection(env, sourceId);
    if (!configured.enabled || !configured.connection.expectedHistoryEpoch
      || !UUID.test(configured.connection.expectedHistoryEpoch)) return null;
    return { sourceId, sourceInstanceUUID: configured.connection.expectedSourceInstanceId,
      applicationUUID: configured.connection.expectedApplicationId, historyEpoch: configured.connection.expectedHistoryEpoch,
      origin: configured.connection.baseUrl, externalCanonicalId };
  } catch { return null; }
}

function storedDestination(value: unknown, expectedRecordId: string): StoredDestination | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const fields = ["sourceId", "sourceInstanceUUID", "applicationUUID", "historyEpoch", "origin", "externalCanonicalId"];
  if (Object.keys(row).length !== fields.length || !fields.every(field => Object.hasOwn(row, field))
    || typeof row.sourceId !== "string" || !SOURCE_ID.test(row.sourceId)
    || typeof row.sourceInstanceUUID !== "string" || !UUID.test(row.sourceInstanceUUID)
    || typeof row.applicationUUID !== "string" || !UUID.test(row.applicationUUID)
    || typeof row.historyEpoch !== "string" || !UUID.test(row.historyEpoch)
    || typeof row.origin !== "string" || row.externalCanonicalId !== expectedRecordId) return null;
  try { if (new URL(row.origin).origin !== row.origin || !row.origin.startsWith("https://")) return null; }
  catch { return null; }
  return row as StoredDestination;
}

async function currentGeneration(db: D1Database, destination: StoredDestination, record: string | null): Promise<string | null> {
  const primary = db.withSession("first-primary");
  const exact = record ? await primary.prepare(`SELECT generation FROM (
      SELECT json_extract(outcome_json,'$.response.result.authorizationGeneration') generation,created_at observed_at
      FROM project_alpha_directory_outbox WHERE source_id=? AND expected_source_instance_id=? AND application_id=?
        AND expected_history_epoch_id=? AND destination_base_url=? AND external_id=? AND state='acknowledged'
      UNION ALL SELECT authorization_generation generation,received_at observed_at
      FROM project_alpha_existing_directory_binding_revision_refresh_receipts WHERE source_id=? AND source_instance_id=?
        AND application_id=? AND history_epoch_id=? AND destination_origin=? AND record_id=?)
    WHERE generation IS NOT NULL ORDER BY observed_at DESC LIMIT 1`).bind(destination.sourceId, destination.sourceInstanceUUID,
      destination.applicationUUID, destination.historyEpoch, destination.origin, record, destination.sourceId,
      destination.sourceInstanceUUID, destination.applicationUUID, destination.historyEpoch, destination.origin, record).first<string>("generation") : null;
  if (exact && REVISION.test(exact)) return exact;
  const source = await primary.prepare(`SELECT generation FROM (
      SELECT json_extract(outcome_json,'$.response.result.authorizationGeneration') generation,created_at observed_at
      FROM project_alpha_directory_outbox WHERE source_id=? AND expected_source_instance_id=? AND application_id=?
        AND expected_history_epoch_id=? AND destination_base_url=? AND state='acknowledged'
      UNION ALL SELECT authorization_generation generation,received_at observed_at
      FROM project_alpha_existing_directory_binding_revision_refresh_receipts WHERE source_id=? AND source_instance_id=?
        AND application_id=? AND history_epoch_id=? AND destination_origin=?)
    WHERE generation IS NOT NULL ORDER BY length(generation) DESC,generation DESC,observed_at DESC LIMIT 1`).bind(destination.sourceId,
      destination.sourceInstanceUUID, destination.applicationUUID, destination.historyEpoch, destination.origin, destination.sourceId,
      destination.sourceInstanceUUID, destination.applicationUUID, destination.historyEpoch, destination.origin).first<string>("generation");
  return source && REVISION.test(source) ? source : null;
}

async function admittedCreate(env: Env, actor: Omit<NativeDirectoryWriterActor, "selectedGrantId" | "selectedIdentityGrantId">,
  kind: NativeDirectoryProfileKind, record: string, profile: Record<string, string>, requestedScopes: readonly NativeDirectoryScope[],
  selectedSources: readonly string[]): Promise<{ createAdmissionId: string; destinations: NativeDirectoryDestinationAuthority[] } | null> {
  const row = await env.OPS_DB.withSession("first-primary").prepare(`SELECT id,destinations_json FROM native_directory_create_admissions
    WHERE staff_id=? AND bound_access_subject=? AND record_id=? AND record_kind=? AND active=1
      AND consumed_mutation_id IS NULL AND json(scopes_json)=json(?) AND json(profile_json)=json(?) LIMIT 1`)
    .bind(actor.staffId, actor.accessSubject, record, kind, JSON.stringify(requestedScopes), JSON.stringify(profile))
    .first<{ id: string; destinations_json: string }>();
  let stored: unknown;
  try { stored = row ? JSON.parse(row.destinations_json) : null; } catch { return null; }
  if (!row || !Array.isArray(stored) || stored.length < 1 || stored.length > 16) return null;
  const admitted: StoredDestination[] = [];
  for (const value of stored) {
    const selected = storedDestination(value, record);
    if (!selected) return null;
    admitted.push(selected);
  }
  if (JSON.stringify(admitted.map(value => value.sourceId).sort()) !== JSON.stringify([...selectedSources].sort())) return null;
  const destinations: NativeDirectoryDestinationAuthority[] = [];
  for (const selected of admitted.sort((left, right) => left.sourceId.localeCompare(right.sourceId))) {
    const configured = await configuredDestination(env, selected.sourceId, record);
    if (!configured || JSON.stringify(configured) !== JSON.stringify(selected)) return null;
    const expectedAuthorizationGeneration = await currentGeneration(env.OPS_DB, selected, null);
    if (!expectedAuthorizationGeneration) return null;
    destinations.push({ ...selected, expectedAuthorizationGeneration });
  }
  return { createAdmissionId: row.id, destinations };
}

function createAdmissionId(record: string): string {
  return `native-directory-create:${record}`;
}

async function storedCreateAdmission(db: D1Database, record: string): Promise<StoredCreateAdmission | null> {
  return db.withSession("first-primary").prepare(`SELECT id,staff_id,bound_access_subject,record_id,record_kind,
      scopes_json,profile_json,destinations_json,active,consumed_mutation_id,issued_by
    FROM native_directory_create_admissions WHERE record_id=?`).bind(record).first<StoredCreateAdmission>();
}

function exactCreateAdmission(row: StoredCreateAdmission,
  actor: Omit<NativeDirectoryWriterActor, "selectedGrantId" | "selectedIdentityGrantId">,
  kind: NativeDirectoryProfileKind, record: string, profile: Record<string, string>, requestedScopes: readonly NativeDirectoryScope[],
  selectedSources: readonly string[], expectedDestinations?: readonly StoredDestination[]): boolean {
  let storedProfile: unknown, storedScopes: unknown, storedDestinations: unknown;
  try {
    storedProfile = JSON.parse(row.profile_json); storedScopes = JSON.parse(row.scopes_json);
    storedDestinations = JSON.parse(row.destinations_json);
  } catch { return false; }
  if (!Array.isArray(storedDestinations)) return false;
  const destinations = storedDestinations.map(value => storedDestination(value, record));
  if (destinations.some(value => value === null)) return false;
  const exactSources = JSON.stringify(destinations.map(value => value!.sourceId).sort()) === JSON.stringify([...selectedSources].sort());
  return row.id === createAdmissionId(record) && row.staff_id === actor.staffId
    && row.bound_access_subject === actor.accessSubject && row.record_id === record && row.record_kind === kind
    && row.issued_by === actor.staffId && row.active === 1 && row.consumed_mutation_id === null
    && JSON.stringify(storedProfile) === JSON.stringify(profile)
    && JSON.stringify(storedScopes) === JSON.stringify(requestedScopes) && exactSources
    && (expectedDestinations === undefined
      || JSON.stringify(destinations) === JSON.stringify(expectedDestinations));
}

async function requestedCreateDestinations(env: Env, selectedSources: readonly string[], record: string): Promise<StoredDestination[] | null> {
  const destinations: StoredDestination[] = [];
  for (const sourceId of selectedSources) {
    const destination = await configuredDestination(env, sourceId, record);
    if (!destination) return null;
    destinations.push(destination);
  }
  return destinations;
}

async function updateDestinations(env: Env, record: string): Promise<NativeDirectoryDestinationAuthority[] | null> {
  const enrollment = await env.OPS_DB.withSession("first-primary").prepare(`SELECT destinations_json FROM native_directory_enrollments WHERE record_id=?`)
    .bind(record).first<{ destinations_json: string }>();
  let values: unknown;
  try { values = enrollment ? JSON.parse(enrollment.destinations_json) : null; } catch { return null; }
  if (!Array.isArray(values) || values.length < 1 || values.length > 16) return null;
  const destinations: NativeDirectoryDestinationAuthority[] = [];
  for (const value of values) {
    const enrolled = storedDestination(value, record);
    if (!enrolled) return null;
    const configured = await configuredDestination(env, enrolled.sourceId, record);
    if (!configured || JSON.stringify(configured) !== JSON.stringify(enrolled)) return null;
    const expectedAuthorizationGeneration = await currentGeneration(env.OPS_DB, enrolled, record);
    if (!expectedAuthorizationGeneration) return null;
    destinations.push({ ...enrolled, expectedAuthorizationGeneration });
  }
  return destinations;
}

async function standaloneRelationship(db: D1Database, record: string): Promise<{
  organizationRecordId: null; expectedRelationshipVersion: number;
} | null> {
  const row = await db.withSession("first-primary").prepare(`SELECT organization_record_id,relationship_version
    FROM operations_directory_client_organizations WHERE client_record_id=?`).bind(record)
    .first<{ organization_record_id: string | null; relationship_version: number }>();
  return row && row.organization_record_id === null && Number.isSafeInteger(row.relationship_version)
    && row.relationship_version >= 1 ? { organizationRecordId: null, expectedRelationshipVersion: row.relationship_version } : null;
}

async function publicResult(c: AppContext, outcome: Awaited<ReturnType<typeof writeNativeDirectoryProfile>>) {
  if (outcome.status !== "written") {
    if (outcome.status === "rejected") return c.json({ status: "invalid_request" }, 400);
    if (outcome.status === "conflict") return c.json({ status: "conflict", reason: outcome.reason }, 409);
    return c.json({ status: "conflict", reason: "directory_write_blocked" }, 409);
  }
  const destinations = [] as { sourceId: string; state: "pending" | "acknowledged" | "conflict" }[];
  for (const commandId of outcome.commandIds) {
    const row = await c.env.OPS_DB.withSession("first-primary").prepare(`SELECT source_id,state FROM project_alpha_directory_outbox WHERE command_id=?`)
      .bind(commandId).first<{ source_id: string; state: string }>();
    if (!row) return c.json({ status: "conflict", reason: "destination_state_unavailable" }, 409);
    destinations.push({ sourceId: row.source_id, state: row.state === "acknowledged" ? "acknowledged"
      : row.state === "dead_letter" ? "conflict" : "pending" });
  }
  if (destinations.some(value => value.state === "conflict"))
    return c.json({ status: "conflict", reason: "destination_conflict", recordId: outcome.recordId,
      kind: outcome.kind, version: outcome.version, destinations }, 409);
  return c.json({ status: destinations.every(value => value.state === "acknowledged") ? "written" : "pending",
    recordId: outcome.recordId, kind: outcome.kind, version: outcome.version, replayed: outcome.replayed, destinations },
  destinations.every(value => value.state === "acknowledged") ? 200 : 202);
}

async function committedReplay(env: Env, actor: Omit<NativeDirectoryWriterActor, "selectedGrantId" | "selectedIdentityGrantId">,
  input: { operation: "create" | "update"; mutationId: string; recordId: string; kind: NativeDirectoryProfileKind;
    expectedLocalVersion: number; profile: Record<string, string>; scopes?: readonly NativeDirectoryScope[]; sourceIds?: readonly string[] },
): Promise<NativeDirectoryProfileWriteOutcome | null> {
  const primary = env.OPS_DB.withSession("first-primary");
  const row = await primary.prepare(`SELECT audit.command_json,audit.actor_id,audit.original_verified_access_subject,
      revision.record_id,revision.version,record.record_kind FROM operations_directory_audit audit
    JOIN operations_directory_revisions revision ON revision.mutation_id=audit.mutation_id
    JOIN operations_directory_records record ON record.record_id=revision.record_id WHERE audit.mutation_id=?`)
    .bind(input.mutationId).first<Record<string, unknown>>();
  if (!row) return null;
  let command: Record<string, unknown> | null = null;
  try { const value = JSON.parse(String(row.command_json)); command = value && typeof value === "object" && !Array.isArray(value) ? value : null; }
  catch { command = null; }
  const destinations = command && Array.isArray(command.destinations) ? command.destinations as Record<string, unknown>[] : [];
  const exactSources = input.sourceIds === undefined || JSON.stringify(destinations.map(value => value.sourceId).sort()) === JSON.stringify([...input.sourceIds].sort());
  const exactScopes = input.operation === "update" || JSON.stringify(command?.scopes) === JSON.stringify(input.scopes);
  if (!command || row.actor_id !== actor.staffId || row.original_verified_access_subject !== actor.accessSubject
    || row.record_id !== input.recordId || row.record_kind !== input.kind || command.operation !== input.operation
    || command.mutationId !== input.mutationId || command.expectedLocalVersion !== input.expectedLocalVersion
    || JSON.stringify(command.fields) !== JSON.stringify(input.profile) || !exactScopes || !exactSources
    || typeof row.version !== "number" || !Number.isSafeInteger(row.version))
    return { status: "conflict", reason: "idempotency_body_conflict" };
  const materializations = await primary.prepare(`SELECT materialization.command_id FROM operations_directory_materializations materialization
    JOIN operations_directory_intents intent ON intent.intent_id=materialization.intent_id
    WHERE intent.mutation_id=? ORDER BY intent.intent_id LIMIT 17`).bind(input.mutationId).all<{ command_id: string }>();
  if (materializations.results.length < 1 || materializations.results.length > 16)
    return { status: "blocked", reason: "replay_destination_state" };
  return { status: "written", replayed: true, mutationId: input.mutationId, recordId: input.recordId,
    kind: input.kind, version: row.version, commandIds: materializations.results.map(value => value.command_id) };
}

async function actorWithGrants(c: AppContext, kind: NativeDirectoryProfileKind, record: string,
  requestedScopes: readonly NativeDirectoryScope[], creating: boolean,
  actor: Omit<NativeDirectoryWriterActor, "selectedGrantId" | "selectedIdentityGrantId">): Promise<NativeDirectoryWriterActor> {
  const selectedGrantId = await selectGrant(c.env.OPS_DB, actor.staffId, "directory.profile.edit", record, requestedScopes, creating);
  if (!selectedGrantId) throw new HTTPException(403, { message: "Directory profile edit permission required" });
  const selectedIdentityGrantId = kind === "client"
    ? await selectGrant(c.env.OPS_DB, actor.staffId, "directory.identity.link", record, requestedScopes, creating) : selectedGrantId;
  if (!selectedIdentityGrantId) throw new HTTPException(403, { message: "Directory identity-link permission required" });
  return { ...actor, selectedGrantId, selectedIdentityGrantId };
}

async function parsed<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const result = schema.safeParse(await readBoundedJson(request, MAX_BODY_BYTES, "Directory profile"));
  if (!result.success) throw new HTTPException(400, { message: "Directory profile request is invalid" });
  return result.data;
}

async function prepareCreateAdmission(c: AppContext) {
  const input = await parsed(c.req.raw, createAdmissionIntent);
  if (c.req.header("Idempotency-Key") !== input.mutationId)
    throw new HTTPException(400, { message: "Idempotency-Key must match mutationId" });
  const record = recordId(input.kind, input.mutationId);
  const actor = await nativeActor(c), profile = normalizeProfile(input.profile);
  const requestedScopes = normalizeScopes(input.scopes), selectedSources = [...input.sourceIds].sort();
  await actorWithGrants(c, input.kind, record, requestedScopes, true, actor);
  if (!await selectGrant(c.env.OPS_DB, actor.staffId, "directory.enrollment.manage", record, requestedScopes, true))
    throw new HTTPException(403, { message: "Directory enrollment-management permission required" });

  const existing = await storedCreateAdmission(c.env.OPS_DB, record);
  if (existing && !exactCreateAdmission(existing, actor, input.kind, record, profile, requestedScopes, selectedSources))
    return c.json({ status: "conflict", reason: "idempotency_body_conflict" }, 409);
  const destinations = await requestedCreateDestinations(c.env, selectedSources, record);
  if (!destinations) return c.json({ status: "conflict", reason: "source_authority_unavailable" }, 409);
  if (existing) return exactCreateAdmission(existing, actor, input.kind, record, profile, requestedScopes, selectedSources, destinations)
    ? c.json({ status: "prepared" })
    : c.json({ status: "conflict", reason: "create_admission_unavailable" }, 409);
  try {
    await c.env.OPS_DB.withSession("first-primary").prepare(`INSERT INTO native_directory_create_admissions
      (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(createAdmissionId(record), actor.staffId, actor.accessSubject,
      record, input.kind, JSON.stringify(requestedScopes), JSON.stringify(profile), JSON.stringify(destinations), actor.staffId).run();
  } catch { /* The exact read below distinguishes a concurrent replay from unavailable admission state. */ }
  const prepared = await storedCreateAdmission(c.env.OPS_DB, record);
  return prepared && exactCreateAdmission(prepared, actor, input.kind, record, profile, requestedScopes, selectedSources, destinations)
    ? c.json({ status: "prepared" })
    : c.json({ status: "conflict", reason: "create_admission_unavailable" }, 409);
}

async function create(c: AppContext, kind: NativeDirectoryProfileKind) {
  const input = kind === "organization" ? await parsed(c.req.raw, organizationCreate) : await parsed(c.req.raw, clientCreate);
  if (c.req.header("Idempotency-Key") !== input.mutationId)
    throw new HTTPException(400, { message: "Idempotency-Key must match mutationId" });
  const localRecordId = recordId(kind, input.mutationId);
  const baseActor = await nativeActor(c), normalizedProfile = normalizeProfile(input.profile), normalizedScopeValues = normalizeScopes(input.scopes);
  const replay = await committedReplay(c.env, baseActor, { operation: "create", mutationId: input.mutationId,
    recordId: localRecordId, expectedLocalVersion: 0, kind, profile: normalizedProfile,
    scopes: normalizedScopeValues, sourceIds: input.sourceIds });
  if (replay) return publicResult(c, replay);
  const actor = await actorWithGrants(c, kind, localRecordId, normalizedScopeValues, true, baseActor);
  if (!await selectGrant(c.env.OPS_DB, baseActor.staffId, "directory.enrollment.manage",
    localRecordId, normalizedScopeValues, true))
    throw new HTTPException(403, { message: "Directory enrollment-management permission required" });
  const admitted = await admittedCreate(c.env, baseActor, kind, localRecordId, normalizedProfile, normalizedScopeValues, input.sourceIds);
  if (!admitted) return c.json({ status: "conflict", reason: "create_admission_unavailable" }, 409);
  const common = { operation: "create" as const, mutationId: input.mutationId, recordId: localRecordId,
    expectedLocalVersion: 0 as const, scopes: normalizedScopeValues, destinations: admitted.destinations,
    createAdmissionId: admitted.createAdmissionId, actor };
  const write: NativeDirectoryProfileWrite = kind === "client"
    ? { ...common, kind: "client", profile: normalizedProfile as NativeDirectoryClientCreateProfile,
        relationship: { organizationRecordId: null, expectedRelationshipVersion: 0 } }
    : { ...common, kind: "organization", profile: normalizedProfile as NativeDirectoryOrganizationProfile };
  return publicResult(c, await writeNativeDirectoryProfile(c.env.OPS_DB, write));
}

async function update(c: AppContext, kind: NativeDirectoryProfileKind) {
  const input = kind === "organization" ? await parsed(c.req.raw, organizationUpdate) : await parsed(c.req.raw, clientUpdate);
  if (c.req.header("Idempotency-Key") !== input.mutationId)
    throw new HTTPException(400, { message: "Idempotency-Key must match mutationId" });
  const localRecordId = c.req.param("recordId");
  if (!localRecordId || Array.from(localRecordId).length > 191 || /\p{C}/u.test(localRecordId)
    || (kind === "client" && !UUID.test(localRecordId))) throw new HTTPException(404, { message: "Directory record not found" });
  const baseActor = await nativeActor(c), normalizedProfile = normalizeProfile(input.profile);
  const replay = await committedReplay(c.env, baseActor, { operation: "update", mutationId: input.mutationId,
    recordId: localRecordId, expectedLocalVersion: input.expectedLocalVersion, kind, profile: normalizedProfile });
  if (replay) return publicResult(c, replay);
  const actor = await actorWithGrants(c, kind, localRecordId, [], false, baseActor);
  const relationship = kind === "client" ? await standaloneRelationship(c.env.OPS_DB, localRecordId) : null;
  if (kind === "client" && !relationship)
    return c.json({ status: "conflict", reason: "standalone_relationship_changed" }, 409);
  const destinations = await updateDestinations(c.env, localRecordId);
  if (!destinations) return c.json({ status: "conflict", reason: "source_authority_unavailable" }, 409);
  const common = { operation: "update" as const, mutationId: input.mutationId, recordId: localRecordId,
    expectedLocalVersion: input.expectedLocalVersion, destinations, actor };
  const write: NativeDirectoryProfileWrite = kind === "client"
    ? { ...common, kind: "client", profile: normalizedProfile as NativeDirectoryClientUpdateProfile, relationship: relationship! }
    : { ...common, kind: "organization", profile: normalizedProfile as NativeDirectoryOrganizationProfile };
  return publicResult(c, await writeNativeDirectoryProfile(c.env.OPS_DB, write));
}

/** Mounted under the shared authenticated /api mutation middleware, which
 * supplies staff authentication plus same-origin and CSRF enforcement. This
 * route only derives native Directory and PA authority and never sends HTTP. */
export function registerNativeDirectoryProfileRoutes(app: App): void {
  app.use(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/*`, async (c, next) => {
    if (!nativeDirectoryProfileWritesEnabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.post(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/create-admissions`, prepareCreateAdmission);
  app.post(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/organizations`, c => create(c, "organization"));
  app.post(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/standalone-clients`, c => create(c, "client"));
  app.patch(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/:kind/:recordId`, c => {
    const kind = c.req.param("kind");
    if (kind === "organizations") return update(c, "organization");
    if (kind === "standalone-clients") return update(c, "client");
    throw new HTTPException(404, { message: "Directory record not found" });
  });
}
