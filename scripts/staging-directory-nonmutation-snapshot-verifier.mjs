import { createHash } from "node:crypto";

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_ROWS_PER_TABLE = 100_000;
const STAGING_CLIENT_DATABASE_ID = "b6f653ab-9acd-4421-9ad0-207754b59aeb";

const define = (primaryKey, columns) => Object.freeze({
  primaryKey: Object.freeze(primaryKey), columns: Object.freeze(columns),
});

/** Deliberately bounded core authority/data surface. Telemetry and legacy authority families are excluded. */
export const CLIENT_DIRECTORY_NONMUTATION_MANIFEST = Object.freeze({
  viewer_native_client_grants: define(["id"], ["id","source_id","workspace_id","project_public_id","scope_type","association_id","include_future_published","can_measure","can_view_cameras","can_download","authorization_expires_at","grant_version","status","created_by_staff_id","created_at","updated_at","revoked_at","revoked_by_staff_id","revoke_reason"]),
  portal_v2_folder_bindings: define(["id"], ["id","workspace_id","owner_scope_type","owner_public_id","r2_prefix","source_type","source_version","status","revoked_at","created_at","updated_at"]),
  projects: define(["id"], ["id","external_ref","client_name","project_name","r2_prefix","active","created_by","created_at","updated_at","division_id","project_alpha_project_id","status","summary","site_address","service_address","project_contact_name","project_contact_email","project_contact_phone","next_milestone","source_updated_at","project_alpha_source_id"]),
  file_index: define(["r2_key"], ["r2_key","etag","size","uploaded_at","content_type","media_kind","stream_uid","stream_status","stream_error","last_seen_reconcile","indexed_at","updated_at","stream_upload_url","stream_upload_offset","provider_version","notification_observation_version"]),
  shares: define(["id"], ["id","project_id","token_hash","label","password_hash","password_salt","password_iterations","expires_at","revoked_at","created_by_type","created_by_id","created_at","last_accessed_at","access_count","public_id","idempotency_key","share_version","secret_ciphertext","secret_iv","r2_prefix","division_id","password_algorithm","revoked_reason","unavailable_since","recipient_email","image_location_map_enabled","r2_object_key"]),
  portal_operations_workspace_authority_heads: define(["workspace_id"], ["workspace_id","client_authority_id","ownership_epoch","state","binding_operation_id","last_operation_id","created_at","updated_at"]),
  portal_operations_principal_grant_heads: define(["workspace_id","issuer","subject"], ["workspace_id","client_authority_id","issuer","subject","ownership_epoch","grant_revision","state","last_operation_id","revoked_at","created_at","updated_at","protocol_version","permissions_json"]),
  portal_operations_authority_v2_audit: define(["operation_id"], ["operation_id","request_fingerprint","workspace_id","client_authority_id","issuer","subject","action","ownership_epoch","grant_revision","resulting_state","created_at","protocol_version","permissions_json"]),
  portal_operations_authority_v2_receipts: define(["operation_id"], ["operation_id","request_fingerprint","workspace_id","client_authority_id","issuer","subject","ownership_epoch","grant_revision","resulting_state","created_at","protocol_version","permissions_json"]),
  operations_portal_workspace_publication_commands: define(["operation_id"], ["operation_id","publication_id","request_fingerprint","target_id","target_revision","client_authority_id","workspace_id","root_kind","root_record_id","expected_revision","resulting_revision","snapshot_id","checkpoint_id","source_sequence","snapshot_sha256","canonical_publication_json","observed_at","created_at"]),
  operations_portal_workspace_publication_heads: define(["target_id"], ["target_id","revision","target_revision","client_authority_id","workspace_id","root_kind","root_record_id","source_sequence","snapshot_id","checkpoint_id","snapshot_sha256","latest_operation_id","updated_at"]),
  operations_portal_workspace_publication_snapshots: define(["snapshot_id"], ["snapshot_id","target_id","revision","checkpoint_id","source_sequence","snapshot_sha256","snapshot_json","directory_record_count","project_count","folder_reservation_count","recipient_authority_head_count","delivery_authority_head_count","operation_id","created_at"]),
  operations_portal_workspace_publication_history: define(["target_id","revision"], ["target_id","revision","source_sequence","snapshot_id","snapshot_sha256","operation_id","recorded_at"]),
  operations_portal_workspace_publication_receipts: define(["operation_id"], ["operation_id","request_fingerprint","publication_id","target_id","resulting_revision","source_sequence","snapshot_id","snapshot_sha256","created_at"]),
  operations_portal_native_authority_commands: define(["operation_id"], ["operation_id","request_fingerprint","action","target_id","target_revision","client_authority_id","workspace_id","root_kind","root_record_id","recipient_binding_id","enrollment_intent_id","target_client_record_id","issuer","subject","expected_ownership_epoch","expected_grant_revision","resulting_ownership_epoch","resulting_grant_revision","permissions_json","expires_at","publication_operation_id","publication_id","publication_revision","publication_source_sequence","publication_snapshot_id","publication_snapshot_sha256","publication_request_fingerprint","actor_staff_id","actor_access_subject","actor_admission_version","actor_profile_version","actor_grant_generation","actor_verified_until","observed_at","canonical_command_json","created_at"]),
  operations_portal_native_authority_receipts: define(["operation_id"], ["operation_id","request_fingerprint","action","target_id","recipient_binding_id","ownership_epoch","grant_revision","state","created_at"]),
  operations_portal_native_workspace_authority_heads: define(["target_id"], ["target_id","target_revision","client_authority_id","workspace_id","root_kind","root_record_id","ownership_epoch","state","latest_operation_id","updated_at"]),
  operations_portal_native_recipient_authority_heads: define(["recipient_binding_id"], ["recipient_binding_id","target_id","enrollment_intent_id","target_client_record_id","issuer","subject","ownership_epoch","grant_revision","state","permissions_json","expires_at","latest_operation_id","updated_at"]),
  operations_portal_native_authority_history: define(["operation_id"], ["operation_id","action","target_id","recipient_binding_id","ownership_epoch","grant_revision","state","request_fingerprint","recorded_at"]),
  operations_portal_native_delivery_commands: define(["operation_id"], ["operation_id","request_fingerprint","action","authority_id","recipient_binding_id","folder_reservation_id","target_id","expected_revision","resulting_revision","canonical_command_json","created_at"]),
  operations_portal_native_delivery_heads: define(["authority_id"], ["authority_id","recipient_binding_id","folder_reservation_id","target_id","revision","state","latest_operation_id"]),
  operations_portal_native_delivery_history: define(["operation_id"], ["operation_id","authority_id","revision","state","request_fingerprint","recorded_at"]),
  operations_portal_native_delivery_receipts: define(["operation_id"], ["operation_id","request_fingerprint","action","authority_id","recipient_binding_id","folder_reservation_id","resulting_revision","resulting_state","created_at"]),
});

function fail(message) { throw new Error(message); }
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}
function exactKeys(value, expected, label) {
  const actual = Object.keys(object(value, label)).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    fail(`${label} keys do not match the capture contract`);
}
function scalar(value, label) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  fail(`${label} must be null, a string, a boolean, or a safe integer`);
}
function encoded(value) {
  const tag = value === null ? "n" : typeof value === "string" ? "s" : typeof value === "number" ? "i" : "b";
  const body = value === null ? "" : typeof value === "boolean" ? (value ? "1" : "0") : String(value);
  return Buffer.from(`${tag}${Buffer.byteLength(body)}:${body}`, "utf8");
}
function keyBuffer(row, primaryKey) {
  return Buffer.concat(primaryKey.flatMap(column => [encoded(row[column]), Buffer.from([0])]));
}
function provenance(value) {
  exactKeys(value, ["environment","database","databaseId","revision","readConsistency"], "provenance");
  if (value.environment !== "staging" || value.database !== "Client") fail("capture must attest the staging Client database");
  if (value.databaseId !== STAGING_CLIENT_DATABASE_ID) fail("capture databaseId is not the staging Client database");
  if (typeof value.revision !== "string" || !/^[0-9a-f]{40}$/u.test(value.revision)) fail("provenance revision must be a full commit SHA");
  const consistency = object(value.readConsistency, "provenance.readConsistency");
  exactKeys(consistency, ["mode","bookmark"], "provenance.readConsistency");
  if (consistency.mode === "primary-bookmark") {
    if (typeof consistency.bookmark !== "string" || !consistency.bookmark.trim()) fail("primary-bookmark requires a bookmark");
    return "bookmark-attested";
  }
  if (consistency.mode === "primary-read-unbookmarked" && consistency.bookmark === null) return "primary-read-unbookmarked";
  fail("readConsistency must attest primary-bookmark or explicitly primary-read-unbookmarked");
}

export function verifyClientDirectoryCapture(capture, options = {}) {
  exactKeys(capture, ["version","provenance","tables"], "capture");
  if (capture.version !== 1) fail("capture version is unsupported");
  const consistencyClaim = provenance(capture.provenance);
  const tables = object(capture.tables, "tables");
  exactKeys(tables, Object.keys(CLIENT_DIRECTORY_NONMUTATION_MANIFEST), "tables");
  const maxRows = options.maxRowsPerTable ?? MAX_ROWS_PER_TABLE;
  if (!Number.isSafeInteger(maxRows) || maxRows < 0 || maxRows > MAX_ROWS_PER_TABLE) fail("maxRowsPerTable is invalid");
  const summaries = [];
  for (const [tableName, spec] of Object.entries(CLIENT_DIRECTORY_NONMUTATION_MANIFEST)) {
    const table = object(tables[tableName], `table ${tableName}`);
    exactKeys(table, ["columns","rows"], `table ${tableName}`);
    if (!Array.isArray(table.columns) || table.columns.length !== spec.columns.length
      || table.columns.some((column, index) => column !== spec.columns[index])) fail(`table ${tableName} columns drifted`);
    if (!Array.isArray(table.rows) || table.rows.length > maxRows) fail(`table ${tableName} row bound exceeded`);
    const rows = table.rows.map((candidate, rowIndex) => {
      const row = object(candidate, `table ${tableName} row ${rowIndex}`);
      exactKeys(row, spec.columns, `table ${tableName} row ${rowIndex}`);
      for (const column of spec.columns) scalar(row[column], `table ${tableName} row ${rowIndex} column ${column}`);
      for (const column of spec.primaryKey) if (row[column] === null) fail(`table ${tableName} row ${rowIndex} has a null primary key`);
      return { row, key: keyBuffer(row, spec.primaryKey) };
    }).sort((left, right) => Buffer.compare(left.key, right.key));
    for (let index = 1; index < rows.length; index++)
      if (Buffer.compare(rows[index - 1].key, rows[index].key) === 0) fail(`table ${tableName} has a duplicate primary key`);
    const hash = createHash("sha256");
    for (const { row } of rows) {
      for (const column of spec.columns) { hash.update(encoded(row[column])); hash.update(Buffer.from([0])); }
      hash.update(Buffer.from([10]));
    }
    summaries.push(Object.freeze({ table: tableName, rowCount: rows.length, sha256: hash.digest("hex") }));
  }
  return Object.freeze({ version: 1, environment: "staging", database: "Client",
    databaseId: STAGING_CLIENT_DATABASE_ID, revision: capture.provenance.revision, consistencyClaim,
    equalityClaim: "declared-capture-equality-only", tables: Object.freeze(summaries) });
}

export function verifyClientDirectoryCaptureJson(text, options = {}) {
  if (typeof text !== "string") fail("capture JSON must be a string");
  const maxBytes = options.maxBytes ?? MAX_CAPTURE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CAPTURE_BYTES) fail("maxBytes is invalid");
  if (Buffer.byteLength(text, "utf8") > maxBytes) fail("capture byte bound exceeded");
  let value;
  try { value = JSON.parse(text); } catch { fail("capture JSON is invalid"); }
  return verifyClientDirectoryCapture(value, options);
}

export function compareClientDirectoryNonmutation(before, after) {
  const left = verifyClientDirectoryCapture(before);
  const right = verifyClientDirectoryCapture(after);
  if (left.revision !== right.revision) fail("capture revisions differ");
  const changes = left.tables.filter((table, index) => table.rowCount !== right.tables[index].rowCount
    || table.sha256 !== right.tables[index].sha256).map(table => table.table);
  return Object.freeze({ unchanged: changes.length === 0, changedTables: Object.freeze(changes), before: left, after: right,
    equalityClaim: "declared-capture-equality-only", atomicityClaim: "not-attested" });
}
