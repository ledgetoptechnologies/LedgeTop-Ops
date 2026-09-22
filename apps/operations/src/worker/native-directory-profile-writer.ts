const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVISION = /^(?:0|[1-9][0-9]{0,18})$/;
const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_REVISION = "9223372036854775807";
const MAX_DESTINATIONS = 16;
const MAX_SCOPES = 64;

export type NativeDirectoryProfileKind = "organization" | "client";
export type NativeDirectoryOrganizationProfile = Readonly<{
  name: string; generalEmail: string; generalPhone: string; addressLine1: string; addressLine2: string;
  city: string; state: string; postalCode: string; country: string;
}>;
export type NativeDirectoryClientCreateProfile = Readonly<{
  name: string; email: string; phone: string; clientType: "unknown" | "business" | "consumer";
  addressLine1: string; addressLine2: string; city: string; state: string; postalCode: string; country: string;
}>;
export type NativeDirectoryClientUpdateProfile = Omit<NativeDirectoryClientCreateProfile, "clientType">;
export type NativeDirectoryScope = Readonly<{ businessAreaId: string; divisionId: string | null }>;
export type NativeDirectoryDestinationAuthority = Readonly<{
  sourceId: string; sourceInstanceUUID: string; applicationUUID: string; historyEpoch: string;
  /** Trusted service observation; HTTP routes must derive this server-side. */
  origin: string; externalCanonicalId: string; expectedAuthorizationGeneration: string;
}>;
export type NativeDirectoryWriterActor = Readonly<{
  staffId: string; accessSubject: string; admissionVersion: number; selectedGrantId: string;
  loginEmail: string; profileVersion: number; selectedIdentityGrantId: string;
}>;
type CommonWrite = Readonly<{
  mutationId: string; recordId: string; actor: NativeDirectoryWriterActor;
  destinations: readonly NativeDirectoryDestinationAuthority[];
}>;
export type NativeDirectoryCreateWrite = CommonWrite & Readonly<{
  operation: "create"; expectedLocalVersion: 0; kind: "organization"; profile: NativeDirectoryOrganizationProfile;
  scopes: readonly NativeDirectoryScope[];
}> | CommonWrite & Readonly<{
  operation: "create"; expectedLocalVersion: 0; kind: "client"; profile: NativeDirectoryClientCreateProfile;
  scopes: readonly NativeDirectoryScope[];
}>;
export type NativeDirectoryUpdateWrite = CommonWrite & Readonly<{
  operation: "update"; expectedLocalVersion: number; kind: "organization"; profile: NativeDirectoryOrganizationProfile;
}> | CommonWrite & Readonly<{
  operation: "update"; expectedLocalVersion: number; kind: "client"; profile: NativeDirectoryClientUpdateProfile;
}>;
export type NativeDirectoryProfileWrite = NativeDirectoryCreateWrite | NativeDirectoryUpdateWrite;
export type NativeDirectoryProfileWriteOutcome =
  | Readonly<{ status: "written"; replayed: boolean; mutationId: string; recordId: string; kind: NativeDirectoryProfileKind; version: number; commandIds: readonly string[] }>
  | Readonly<{ status: "rejected" | "blocked" | "conflict"; reason: string }>;

type NormalizedWrite = Readonly<{
  operation: "create" | "update"; mutationId: string; recordId: string; kind: NativeDirectoryProfileKind;
  expectedLocalVersion: number; actor: NativeDirectoryWriterActor; profile: Record<string, string>;
  scopes: readonly NativeDirectoryScope[]; destinations: readonly NativeDirectoryDestinationAuthority[];
}>;
type DestinationIdentity = Omit<NativeDirectoryDestinationAuthority, "expectedAuthorizationGeneration">;
type GrantRow = Readonly<{ id: string; effect: string; scope_kind: string; business_area_id: string | null; division_id: string | null; resource_id: string | null }>;

function plain(value: unknown): value is Record<string, unknown> {
  try { return !!value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
  catch { return false; }
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  try { return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)); }
  catch { return false; }
}
function boundedText(value: unknown, maximum: number, nonempty = false): value is string {
  if (typeof value !== "string" || (nonempty && value.length === 0) || Array.from(value).length > maximum || /\p{C}/u.test(value)) return false;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) === value; }
  catch { return false; }
}
function revision(value: unknown): value is string {
  return typeof value === "string" && REVISION.test(value) && (value.length < MAX_REVISION.length || value <= MAX_REVISION);
}
function externalId(value: unknown): value is string {
  return boundedText(value, 191, true) && new TextEncoder().encode(value).byteLength <= 764;
}
function profile(value: unknown, kind: NativeDirectoryProfileKind, operation: "create" | "update"): value is Record<string, string> {
  const fields = kind === "organization"
    ? ["name", "generalEmail", "generalPhone", "addressLine1", "addressLine2", "city", "state", "postalCode", "country"]
    : operation === "create"
      ? ["name", "email", "phone", "clientType", "addressLine1", "addressLine2", "city", "state", "postalCode", "country"]
      : ["name", "email", "phone", "addressLine1", "addressLine2", "city", "state", "postalCode", "country"];
  if (!plain(value) || !exact(value, fields)) return false;
  for (const field of fields) {
    const maximum = field === "name" ? 150 : field === "state" ? (kind === "client" ? 2 : 100) : field === "postalCode" ? (kind === "client" ? 20 : 32)
      : field === "clientType" ? 8 : field === "email" || field === "generalEmail" ? 255
        : field === "phone" || field === "generalPhone" ? 50 : field === "city" || field === "country" ? 100 : 255;
    if (!boundedText(value[field], maximum, field === "name")) return false;
  }
  if (kind === "client" && operation === "create" && !["unknown", "business", "consumer"].includes(String(value.clientType))) return false;
  const email = String(kind === "client" ? value.email : value.generalEmail);
  return email === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function canonicalOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { const parsed = new URL(value); return parsed.protocol === "https:" && parsed.origin === value; }
  catch { return false; }
}
function destination(value: unknown, recordId: string): value is NativeDirectoryDestinationAuthority {
  return plain(value) && exact(value, ["sourceId", "sourceInstanceUUID", "applicationUUID", "historyEpoch", "origin", "externalCanonicalId", "expectedAuthorizationGeneration"])
    && typeof value.sourceId === "string" && SOURCE_ID.test(value.sourceId) && typeof value.sourceInstanceUUID === "string" && UUID.test(value.sourceInstanceUUID)
    && typeof value.applicationUUID === "string" && UUID.test(value.applicationUUID) && typeof value.historyEpoch === "string" && UUID.test(value.historyEpoch)
    && canonicalOrigin(value.origin) && value.externalCanonicalId === recordId && revision(value.expectedAuthorizationGeneration);
}
function normalize(input: NativeDirectoryProfileWrite): NormalizedWrite | null {
  const normalizedProfile = plain(input.profile) ? Object.fromEntries(Object.entries(input.profile).map(([field, value]) => {
    const normalized = typeof value === "string" ? value.normalize("NFC").trim() : value;
    return [field, (field === "email" || field === "generalEmail") && typeof normalized === "string" ? normalized.toLowerCase() : normalized];
  })) : null;
  if (!plain(input) || !UUID.test(input.mutationId) || !externalId(input.recordId) || (input.kind !== "organization" && input.kind !== "client")
    || (input.operation !== "create" && input.operation !== "update") || !Number.isSafeInteger(input.expectedLocalVersion)
    || input.expectedLocalVersion < 0 || (input.operation === "create") !== (input.expectedLocalVersion === 0)
    || !plain(input.actor) || !exact(input.actor, ["staffId", "accessSubject", "admissionVersion", "selectedGrantId", "loginEmail", "profileVersion", "selectedIdentityGrantId"])
    || !boundedText(input.actor.staffId, 191, true) || !boundedText(input.actor.accessSubject, 191, true)
    || !boundedText(input.actor.selectedGrantId, 191, true) || !Number.isSafeInteger(input.actor.admissionVersion) || input.actor.admissionVersion < 1
    || !boundedText(input.actor.loginEmail, 254, true) || input.actor.loginEmail !== input.actor.loginEmail.trim().toLowerCase()
    || !Number.isSafeInteger(input.actor.profileVersion) || input.actor.profileVersion < 1 || !boundedText(input.actor.selectedIdentityGrantId, 191, true)
    || (input.kind === "client" && !UUID.test(input.recordId))
    || !profile(normalizedProfile, input.kind, input.operation) || !Array.isArray(input.destinations)
    || input.destinations.length < 1 || input.destinations.length > MAX_DESTINATIONS
    || !input.destinations.every(value => destination(value, input.recordId))) return null;
  const scopes = input.operation === "create" ? input.scopes : [];
  if (!Array.isArray(scopes) || scopes.length < (input.operation === "create" ? 1 : 0) || scopes.length > MAX_SCOPES
    || !scopes.every(value => plain(value) && exact(value, ["businessAreaId", "divisionId"])
      && boundedText(value.businessAreaId, 191, true) && (value.divisionId === null || boundedText(value.divisionId, 191, true)))) return null;
  const normalizedScopes = scopes.map(value => ({ businessAreaId: value.businessAreaId, divisionId: value.divisionId }))
    .sort((left, right) => `${left.businessAreaId}\0${left.divisionId ?? ""}`.localeCompare(`${right.businessAreaId}\0${right.divisionId ?? ""}`));
  const normalizedDestinations = input.destinations.map(value => ({ ...value })).sort((left, right) => destinationKey(left).localeCompare(destinationKey(right)));
  if (new Set(normalizedScopes.map(value => `${value.businessAreaId}\0${value.divisionId ?? ""}`)).size !== normalizedScopes.length
    || new Set(normalizedDestinations.map(destinationKey)).size !== normalizedDestinations.length) return null;
  return { operation: input.operation, mutationId: input.mutationId, recordId: input.recordId, kind: input.kind,
    expectedLocalVersion: input.expectedLocalVersion, actor: { ...input.actor }, profile: normalizedProfile, scopes: normalizedScopes, destinations: normalizedDestinations };
}
function destinationKey(value: Pick<NativeDirectoryDestinationAuthority, "sourceId" | "sourceInstanceUUID" | "applicationUUID">): string {
  return `${value.sourceId}\0${value.sourceInstanceUUID}\0${value.applicationUUID}`;
}
function identity(value: NativeDirectoryDestinationAuthority): DestinationIdentity {
  return { sourceId: value.sourceId, sourceInstanceUUID: value.sourceInstanceUUID, applicationUUID: value.applicationUUID,
    historyEpoch: value.historyEpoch, origin: value.origin, externalCanonicalId: value.externalCanonicalId };
}
async function deterministicUuid(seed: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed))).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x40; digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function commandId(mutationId: string, destinationValue: NativeDirectoryDestinationAuthority): Promise<string> {
  return deterministicUuid(`${mutationId}\0${destinationKey(destinationValue)}`);
}
function applies(grant: GrantRow, write: NormalizedWrite, scopes: readonly NativeDirectoryScope[], assigned: boolean): boolean {
  return grant.scope_kind === "global" || (write.operation === "update" && grant.scope_kind === "resource" && grant.resource_id === write.recordId)
    || (write.operation === "update" && grant.scope_kind === "assigned" && assigned)
    || (grant.scope_kind === "business_area" && scopes.some(scope => scope.businessAreaId === grant.business_area_id))
    || (grant.scope_kind === "division" && scopes.some(scope => scope.divisionId === grant.division_id));
}
async function authority(db: D1Database, write: NormalizedWrite, permission = "directory.profile.edit", grantId = write.actor.selectedGrantId): Promise<boolean> {
  const selected = await db.prepare(`SELECT grant.id,grant.effect,grant.scope_kind,grant.business_area_id,grant.division_id,grant.resource_id
    FROM native_directory_grants grant JOIN native_staff_admissions admission ON admission.staff_id=grant.staff_id
    JOIN staff_users actor ON actor.id=grant.staff_id JOIN native_staff_profiles profile ON profile.staff_id=grant.staff_id
    WHERE grant.id=? AND grant.staff_id=? AND grant.permission=? AND grant.effect='allow' AND grant.active=1
      AND admission.active=1 AND admission.bound_access_subject=? AND admission.version=?
      AND actor.status='active' AND actor.access_subject=? AND profile.login_email=? AND profile.version=?`).bind(grantId, write.actor.staffId, permission,
      write.actor.accessSubject, write.actor.admissionVersion, write.actor.accessSubject, write.actor.loginEmail, write.actor.profileVersion).first<GrantRow>();
  if (!selected) return false;
  const scopes = write.operation === "create" ? write.scopes : (await db.prepare(`SELECT business_area_id businessAreaId,division_id divisionId
    FROM native_directory_resource_scopes WHERE record_id=? AND active=1`).bind(write.recordId).all<NativeDirectoryScope>()).results;
  const assigned = write.operation === "update" && !!await db.prepare(`SELECT 1 ok FROM native_directory_assignments WHERE record_id=? AND staff_id=? AND active=1`)
    .bind(write.recordId, write.actor.staffId).first();
  if (!applies(selected, write, scopes, assigned)) return false;
  const denies = (await db.prepare(`SELECT id,effect,scope_kind,business_area_id,division_id,resource_id FROM native_directory_grants
    WHERE staff_id=? AND permission=? AND effect='deny' AND active=1`).bind(write.actor.staffId, permission).all<GrantRow>()).results;
  return !denies.some(deny => applies(deny, write, scopes, assigned));
}
function auditCommand(write: NormalizedWrite): string {
  return JSON.stringify({ operation: write.operation, mutationId: write.mutationId, resourceType: write.kind, recordId: write.recordId,
    expectedLocalVersion: write.expectedLocalVersion, actor: write.actor, fields: write.profile,
    scopes: write.operation === "create" ? write.scopes : null, destinations: write.destinations });
}
type RemoteState = Readonly<{ projectAlphaPublicId: string; revision: string; authorizationGeneration: string }>;
async function updateRemoteState(db: D1Database, write: NormalizedWrite, destinationValue: NativeDirectoryDestinationAuthority): Promise<RemoteState | null> {
  const pending = await db.prepare(`SELECT 1 present FROM project_alpha_directory_outbox WHERE source_id=? AND expected_source_instance_id=?
    AND application_id=? AND expected_history_epoch_id=? AND resource_type=? AND external_id=? AND state<>'acknowledged' LIMIT 1`)
    .bind(destinationValue.sourceId, destinationValue.sourceInstanceUUID, destinationValue.applicationUUID, destinationValue.historyEpoch, write.kind, write.recordId).first();
  if (pending) return null;
  const active = await db.prepare(`SELECT project_alpha_public_id projectAlphaPublicId,mapping_kind mappingKind,provenance_id provenanceId
    FROM project_alpha_active_directory_mappings WHERE source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=?
      AND resource_type=? AND external_id=?`).bind(destinationValue.sourceId, destinationValue.sourceInstanceUUID,
      destinationValue.applicationUUID, destinationValue.historyEpoch, write.kind, write.recordId).first<Record<string, unknown>>();
  if (!active || typeof active.projectAlphaPublicId !== "string" || !/^[0-9a-f]{32}$/.test(active.projectAlphaPublicId)) return null;
  if (active.mappingKind === "acquired") {
    const refreshed = await db.prepare(`SELECT live_revision revision,authorization_generation authorizationGeneration
      FROM project_alpha_existing_directory_binding_revision_refresh_receipts WHERE record_id=? AND source_id=?
        AND source_instance_id=? AND application_id=? AND history_epoch_id=? AND resource_type=? AND external_id=?
        AND project_alpha_public_id=? AND local_record_version=? ORDER BY received_at DESC,receipt_id DESC LIMIT 1`).bind(write.recordId, destinationValue.sourceId,
        destinationValue.sourceInstanceUUID, destinationValue.applicationUUID, destinationValue.historyEpoch, write.kind, write.recordId,
        active.projectAlphaPublicId, write.expectedLocalVersion).first<Record<string, unknown>>();
    if (refreshed) return revision(refreshed.revision) && refreshed.authorizationGeneration === destinationValue.expectedAuthorizationGeneration
      ? { projectAlphaPublicId: active.projectAlphaPublicId, revision: refreshed.revision, authorizationGeneration: destinationValue.expectedAuthorizationGeneration } : null;
    const activated = await db.prepare(`SELECT project_alpha_revision revision FROM project_alpha_existing_directory_binding_activation_receipts
      WHERE activation_id=? AND record_id=? AND local_record_version=?`).bind(active.provenanceId, write.recordId, write.expectedLocalVersion)
      .first<Record<string, unknown>>();
    return activated && revision(activated.revision)
      ? { projectAlphaPublicId: active.projectAlphaPublicId, revision: activated.revision, authorizationGeneration: destinationValue.expectedAuthorizationGeneration } : null;
  }
  const row = await db.prepare(`SELECT mapping.project_alpha_public_id projectAlphaPublicId,
      json_extract(outbox.outcome_json,'$.response.result.resource.revision') revision,
      json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration') authorizationGeneration
    FROM project_alpha_directory_mappings mapping JOIN project_alpha_directory_outbox outbox
      ON outbox.source_id=mapping.source_id AND outbox.expected_source_instance_id=mapping.source_instance_id
      AND outbox.application_id=mapping.application_id AND outbox.expected_history_epoch_id=mapping.history_epoch_id
      AND outbox.resource_type=mapping.resource_type AND outbox.external_id=mapping.external_id
    WHERE mapping.source_id=? AND mapping.source_instance_id=? AND mapping.application_id=? AND mapping.history_epoch_id=?
      AND mapping.resource_type=? AND mapping.external_id=? AND outbox.state='acknowledged'
    ORDER BY outbox.created_at DESC,outbox.command_id DESC LIMIT 1`).bind(destinationValue.sourceId, destinationValue.sourceInstanceUUID,
      destinationValue.applicationUUID, destinationValue.historyEpoch, write.kind, write.recordId).first<Record<string, unknown>>();
  return row && row.projectAlphaPublicId === active.projectAlphaPublicId
    && revision(row.revision) && revision(row.authorizationGeneration) && row.authorizationGeneration === destinationValue.expectedAuthorizationGeneration
    ? { projectAlphaPublicId: row.projectAlphaPublicId, revision: row.revision, authorizationGeneration: row.authorizationGeneration } : null;
}

/**
 * Persists a canonical native Directory profile mutation and reserves its PA
 * outbox work. It performs no HTTP work. Standalone clients receive an
 * explicit versioned unlinked relationship decision and per-intent dependency;
 * their transport-only fields materialize organizationPublicId:null. Linked
 * client profile writes remain fail-closed in this bounded slice.
 */
export async function writeNativeDirectoryProfile(db: D1Database, input: NativeDirectoryProfileWrite): Promise<NativeDirectoryProfileWriteOutcome> {
  const write = normalize(input); if (!write) return { status: "rejected", reason: "invalid_write" };
  const auditJson = auditCommand(write);
  const replay = await db.prepare(`SELECT audit.command_json,audit.actor_id,audit.original_verified_access_subject,revision.record_id,
      revision.version,record.record_kind FROM operations_directory_audit audit
    JOIN operations_directory_revisions revision ON revision.mutation_id=audit.mutation_id
    JOIN operations_directory_records record ON record.record_id=revision.record_id WHERE audit.mutation_id=?`).bind(write.mutationId)
    .first<Record<string, unknown>>();
  if (replay) {
    if (replay.command_json !== auditJson || replay.actor_id !== write.actor.staffId || replay.original_verified_access_subject !== write.actor.accessSubject
      || replay.record_id !== write.recordId || replay.record_kind !== write.kind || typeof replay.version !== "number")
      return { status: "conflict", reason: "idempotency_body_conflict" };
    const ids = await Promise.all(write.destinations.map(value => commandId(write.mutationId, value)));
    return { status: "written", replayed: true, mutationId: write.mutationId, recordId: write.recordId, kind: write.kind, version: replay.version, commandIds: ids };
  }
  const record = await db.prepare(`SELECT record_kind,current_version FROM operations_directory_records WHERE record_id=?`).bind(write.recordId).first<{ record_kind: string; current_version: number }>();
  if (write.operation === "create" ? !!record : !record || record.record_kind !== write.kind || record.current_version !== write.expectedLocalVersion)
    return { status: "conflict", reason: write.operation === "create" ? "record_exists" : "stale_local_version" };
  if (!await authority(db, write)) return { status: "blocked", reason: "native_directory_authority" };
  let relationshipVersion: number | null = null, relationshipMutationId: string | null = null;
  if (write.kind === "client") {
    if (!await authority(db, write, "directory.identity.link", write.actor.selectedIdentityGrantId))
      return { status: "blocked", reason: "native_directory_identity_authority" };
    if (write.operation === "create") {
      relationshipVersion = 1;
      relationshipMutationId = await deterministicUuid(`${write.mutationId}\0standalone-client-relationship`);
    } else {
      const relationship = await db.prepare(`SELECT relation.organization_record_id,relation.relationship_version,history.mutation_id
        FROM operations_directory_client_organizations relation JOIN operations_directory_client_organization_history history
          ON history.client_record_id=relation.client_record_id AND history.relationship_version=relation.relationship_version
        WHERE relation.client_record_id=?`).bind(write.recordId)
        .first<{ organization_record_id: string | null; relationship_version: number; mutation_id: string }>();
      if (!relationship) return { status: "blocked", reason: "client_relationship_missing" };
      if (relationship.organization_record_id !== null) return { status: "blocked", reason: "client_relationship_linked_out_of_scope" };
      relationshipVersion = relationship.relationship_version;
      relationshipMutationId = relationship.mutation_id;
    }
  }
  let enrolled: readonly DestinationIdentity[] = write.destinations.map(identity);
  const remote = new Map<string, RemoteState>();
  if (write.operation === "update") {
    const enrollment = await db.prepare(`SELECT destinations_json FROM native_directory_enrollments WHERE record_id=?`).bind(write.recordId).first<{ destinations_json: string }>();
    try { enrolled = enrollment ? JSON.parse(enrollment.destinations_json) as DestinationIdentity[] : []; } catch { enrolled = []; }
    const requested = write.destinations.map(identity);
    if (JSON.stringify(enrolled) !== JSON.stringify(requested)) return { status: "blocked", reason: "enrollment_drift" };
    for (const value of write.destinations) { const state = await updateRemoteState(db, write, value); if (!state) return { status: "blocked", reason: "mapping_or_delivery_state" }; remote.set(destinationKey(value), state); }
  }
  const nextVersion = write.expectedLocalVersion + 1;
  const scopesJson = JSON.stringify(write.scopes), profileJson = JSON.stringify(write.profile), destinationsJson = JSON.stringify(enrolled);
  const commandIds = await Promise.all(write.destinations.map(value => commandId(write.mutationId, value)));
  const statements: D1PreparedStatement[] = [];
  const admissionId = `${write.mutationId}:create-admission`;
  if (write.operation === "create") statements.push(db.prepare(`INSERT INTO native_directory_create_admissions
    (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by) VALUES(?,?,?,?,?,?,?,?,?)`)
    .bind(admissionId, write.actor.staffId, write.actor.accessSubject, write.recordId, write.kind, scopesJson, profileJson, destinationsJson, write.actor.staffId));
  statements.push(db.prepare(`INSERT INTO operations_directory_write_fences
    (mutation_id,operation_kind,actor_id,bound_access_subject,actor_admission_version,permission,record_id,record_kind,expected_version,
      create_admission_id,selected_grant_id,scopes_json,profile_json,command_json,destinations_json,intent_writes)
    VALUES(?,?,?,?,?,'directory.profile.edit',?,?,?,?,?,?,?,?,?,?)`).bind(write.mutationId, write.operation, write.actor.staffId,
      write.actor.accessSubject, write.actor.admissionVersion, write.recordId, write.kind, write.expectedLocalVersion,
      write.operation === "create" ? admissionId : null, write.actor.selectedGrantId, scopesJson, profileJson, auditJson, destinationsJson, write.destinations.length));
  statements.push(write.operation === "create"
    ? db.prepare(`INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,?,1)`).bind(write.recordId, write.kind)
    : db.prepare(`UPDATE operations_directory_records SET current_version=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE record_id=? AND current_version=?`)
      .bind(nextVersion, write.recordId, write.expectedLocalVersion));
  statements.push(db.prepare(`INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json) VALUES(?,?,?,?)`).bind(write.recordId, nextVersion, write.mutationId, profileJson));
  statements.push(db.prepare(`INSERT INTO operations_directory_audit(audit_id,mutation_id,record_id,record_version,actor_type,actor_id,command_json,original_verified_access_subject)
    VALUES(?,?,?,?, 'staff',?,?,?)`).bind(`${write.mutationId}:audit`, write.mutationId, write.recordId, nextVersion, write.actor.staffId, auditJson, write.actor.accessSubject));
  const materializations: D1PreparedStatement[] = [];
  write.destinations.forEach((value, index) => {
    const intentId = `${write.mutationId}:intent:${index}`, state = remote.get(destinationKey(value));
    const fields = write.kind === "client" ? { ...write.profile, organizationPublicId: null } : write.profile;
    const materialized = write.operation === "create"
      ? { operation: "create", commandId: commandIds[index], resourceType: write.kind, externalId: write.recordId, expectedRevision: "0",
          expectedAuthorizationGeneration: value.expectedAuthorizationGeneration, fields, scopes: write.scopes }
      : { operation: "update", commandId: commandIds[index], resourceType: write.kind, externalId: write.recordId,
          expectedProjectAlphaPublicId: state!.projectAlphaPublicId, expectedRevision: state!.revision,
          expectedAuthorizationGeneration: state!.authorizationGeneration, fields };
    const disposition = { kind: write.operation === "create" ? "authorized_create" : "existing", ...identity(value),
      ...(state ? { projectAlphaPublicId: state.projectAlphaPublicId, projectAlphaRevision: state.revision } : {}) };
    statements.push(db.prepare(`INSERT INTO operations_directory_intents(intent_id,mutation_id,record_id,record_version,source_id,source_instance_uuid,
      application_uuid,destination_origin,external_canonical_id,desired_payload_json,expected_history_epoch_id,state)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'waiting')`).bind(intentId, write.mutationId, write.recordId, nextVersion, value.sourceId,
      value.sourceInstanceUUID, value.applicationUUID, value.origin, value.externalCanonicalId, profileJson, value.historyEpoch));
    materializations.push(db.prepare(`UPDATE operations_directory_intents SET state='ready' WHERE intent_id=? AND state='waiting'`).bind(intentId));
    materializations.push(db.prepare(`INSERT INTO operations_directory_materializations(intent_id,command_id,command_json,origin_snapshot_json,disposition_json,next_attempt_at,history_epoch_id)
      VALUES(?,?,?,?,?,?,?)`).bind(intentId, commandIds[index], JSON.stringify(materialized),
      JSON.stringify({ actorId: write.actor.staffId, authorityRevision: String(nextVersion), actorSubject: write.actor.accessSubject }),
      JSON.stringify(disposition), Date.now(), value.historyEpoch));
  });
  if (write.kind === "client") {
    if (write.operation === "create") {
      const verifiedUntil = new Date(Date.now() + 60_000).toISOString();
      statements.push(db.prepare(`INSERT INTO operations_directory_relationship_write_fences(mutation_id,client_record_id,
        expected_relationship_version,previous_organization_record_id,organization_record_id,client_record_version,
        previous_organization_record_version,organization_record_version,actor_staff_id,actor_access_subject,actor_email,
        actor_admission_version,actor_profile_version,verified_until) VALUES(?,?,0,NULL,NULL,1,NULL,NULL,?,?,?,?,?,?)`)
        .bind(relationshipMutationId, write.recordId, write.actor.staffId, write.actor.accessSubject, write.actor.loginEmail,
          write.actor.admissionVersion, write.actor.profileVersion, verifiedUntil));
      statements.push(db.prepare(`INSERT INTO operations_directory_client_organizations(client_record_id,organization_record_id,relationship_version)
        VALUES(?,NULL,1)`).bind(write.recordId));
      statements.push(db.prepare(`DELETE FROM operations_directory_relationship_write_fences WHERE mutation_id=?`).bind(relationshipMutationId));
    }
    write.destinations.forEach((value, index) => {
      statements.push(db.prepare(`INSERT INTO operations_directory_intent_relationship_dependencies(
        intent_id,client_record_id,client_record_version,relationship_version,relationship_mutation_id,organization_record_id,
        organization_record_version,source_id,source_instance_uuid,application_uuid,history_epoch_id,destination_origin,
        parent_external_canonical_id,evidence_kind) VALUES(?,?,?,?,?,NULL,NULL,?,?,?,?,?,NULL,'unlinked')`)
        .bind(`${write.mutationId}:intent:${index}`, write.recordId, nextVersion, relationshipVersion, relationshipMutationId,
          value.sourceId, value.sourceInstanceUUID, value.applicationUUID, value.historyEpoch, value.origin));
    });
  }
  statements.push(...materializations);
  statements.push(db.prepare(`DELETE FROM operations_directory_write_fences WHERE mutation_id=?`).bind(write.mutationId));
  try { await db.batch(statements); }
  catch { return { status: "blocked", reason: "authority_or_atomic_write" }; }
  return { status: "written", replayed: false, mutationId: write.mutationId, recordId: write.recordId, kind: write.kind, version: nextVersion, commandIds };
}
