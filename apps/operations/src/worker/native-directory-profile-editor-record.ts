import type { Env } from "./types";
import { resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;

export type NativeDirectoryOrganizationChoice = Readonly<{
  recordId: string;
  expectedVersion: number;
  name: string;
  sourceIds: readonly string[];
}>;

export type NativeDirectoryLinkedClientEditorRecord = Readonly<{ recordId: string; name: string }>;

type EnrollmentDestination = Readonly<{
  sourceId: string; sourceInstanceUUID: string; applicationUUID: string; historyEpoch: string;
  origin: string; externalCanonicalId: string;
}>;

function enrollment(value: unknown, recordId: string): EnrollmentDestination[] | null {
  let parsed: unknown;
  try { parsed = typeof value === "string" ? JSON.parse(value) : value; } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 16) return null;
  const result: EnrollmentDestination[] = [], seen = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (Object.keys(row).length !== 6 || typeof row.sourceId !== "string" || !SOURCE_ID.test(row.sourceId)
      || typeof row.sourceInstanceUUID !== "string" || !UUID.test(row.sourceInstanceUUID)
      || typeof row.applicationUUID !== "string" || !UUID.test(row.applicationUUID)
      || typeof row.historyEpoch !== "string" || !UUID.test(row.historyEpoch)
      || typeof row.origin !== "string" || row.externalCanonicalId !== recordId) return null;
    try { if (new URL(row.origin).origin !== row.origin || !row.origin.startsWith("https://")) return null; } catch { return null; }
    const key = [row.sourceId, row.sourceInstanceUUID, row.applicationUUID, row.historyEpoch, row.origin].join("\0");
    if (seen.has(key)) return null;
    seen.add(key); result.push(row as EnrollmentDestination);
  }
  return result.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

/** Returns only organizations whose immutable enrollment, active mapping, and
 * currently configured PA destination identity agree exactly. No PA public ID,
 * revision, generation, origin, application, or history identity leaves this
 * server-owned helper. */
export async function nativeDirectoryOrganizationChoices(env: Env): Promise<NativeDirectoryOrganizationChoice[]> {
  const rows = (await env.OPS_DB.withSession("first-primary").prepare(`SELECT record.record_id recordId,
      record.current_version expectedVersion,revision.profile_json profileJson,enrollment.destinations_json destinationsJson
    FROM operations_directory_records record
    JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
    JOIN native_directory_enrollments enrollment ON enrollment.record_id=record.record_id
    WHERE record.record_kind='organization' ORDER BY record.record_id LIMIT 101`).all<{
      recordId: string; expectedVersion: number; profileJson: string; destinationsJson: string;
    }>()).results;
  if (rows.length > 100) return [];
  const choices: NativeDirectoryOrganizationChoice[] = [];
  for (const row of rows) {
    if (!row.recordId || Array.from(row.recordId).length > 191 || /\p{C}/u.test(row.recordId)
      || new TextEncoder().encode(row.recordId).byteLength > 764
      || !Number.isSafeInteger(row.expectedVersion) || row.expectedVersion < 1) continue;
    let profile: unknown;
    try { profile = JSON.parse(row.profileJson); } catch { continue; }
    const profileName = profile && typeof profile === "object" && !Array.isArray(profile)
      ? (profile as Record<string, unknown>).name : null;
    const name = typeof profileName === "string" ? profileName.normalize("NFC").trim() : "";
    if (!name || Array.from(name).length > 150 || /\p{C}/u.test(name)) continue;
    const destinations = enrollment(row.destinationsJson, row.recordId);
    if (!destinations) continue;
    let valid = true;
    for (const destination of destinations) {
      try {
        const configured = resolveProjectAlphaApiV2Connection(env, destination.sourceId);
        if (!configured.enabled || !configured.connection.expectedHistoryEpoch
          || configured.connection.expectedSourceInstanceId !== destination.sourceInstanceUUID
          || configured.connection.expectedApplicationId !== destination.applicationUUID
          || configured.connection.expectedHistoryEpoch !== destination.historyEpoch
          || configured.connection.baseUrl !== destination.origin
          || !await env.OPS_DB.withSession("first-primary").prepare(`SELECT 1 present
            FROM pa_connectors connector JOIN project_alpha_active_directory_mappings mapping
              ON mapping.source_id=connector.source_id
            WHERE connector.source_id=? AND connector.state='active' AND connector.read_visible=1
              AND mapping.source_instance_id=? AND mapping.application_id=? AND mapping.history_epoch_id=?
              AND mapping.resource_type='organization' AND mapping.external_id=?`).bind(destination.sourceId,
              destination.sourceInstanceUUID, destination.applicationUUID, destination.historyEpoch, row.recordId).first()) {
          valid = false; break;
        }
      } catch { valid = false; break; }
    }
    if (valid) choices.push({ recordId: row.recordId, expectedVersion: row.expectedVersion, name,
      sourceIds: destinations.map(value => value.sourceId) });
  }
  return choices.sort((left, right) => left.name.localeCompare(right.name) || left.recordId.localeCompare(right.recordId));
}

/** A projected PA public ID is never an Operations Directory record ID. Expose
 * an editor coordinate only when the active mapping proves the exact pair. */
export async function nativeDirectoryProfileEditorRecord(env: Env, root: { source_id: string; root_namespace: string;
  kind: "organization" | "standalone_client"; public_id: string }): Promise<{ recordId: string; kind: "organization" | "client" } | null> {
  if (root.root_namespace !== "business" || !root.source_id.startsWith("project-alpha:")) return null;
  const recordKind = root.kind === "organization" ? "organization" : "client";
  try {
    const configured = resolveProjectAlphaApiV2Connection(env, root.source_id);
    if (!configured.enabled || !configured.connection.expectedHistoryEpoch) return null;
    const rows = (await env.OPS_DB.withSession("first-primary").prepare(`SELECT mapping.external_id recordId
      FROM project_alpha_active_directory_mappings mapping JOIN operations_directory_records record
        ON record.record_id=mapping.external_id AND record.record_kind=mapping.resource_type
      WHERE mapping.source_id=? AND mapping.source_instance_id=? AND mapping.application_id=? AND mapping.history_epoch_id=?
        AND mapping.resource_type=? AND mapping.project_alpha_public_id=?
        AND record.record_kind=? LIMIT 2`).bind(root.source_id, configured.connection.expectedSourceInstanceId,
        configured.connection.expectedApplicationId, configured.connection.expectedHistoryEpoch, recordKind, root.public_id, recordKind)
      .all<{ recordId: string }>()).results;
    return rows.length === 1 && typeof rows[0]?.recordId === "string" && rows[0].recordId.length > 0
      ? { recordId: rows[0].recordId, kind: recordKind } : null;
  } catch { return null; }
}

/** Lists only clients whose active mapping and current native relationship both
 * point at the exact organization represented by this Client Hub workspace. */
export async function nativeDirectoryLinkedClientEditorRecords(env: Env, root: { source_id: string; root_namespace: string;
  kind: "organization" | "standalone_client"; public_id: string }, staffId: string): Promise<NativeDirectoryLinkedClientEditorRecord[]> {
  if (root.root_namespace !== "business" || root.kind !== "organization" || !root.source_id.startsWith("project-alpha:")) return [];
  try {
    const configured = resolveProjectAlphaApiV2Connection(env, root.source_id);
    if (!configured.enabled || !configured.connection.expectedHistoryEpoch) return [];
    const rows = (await env.OPS_DB.withSession("first-primary").prepare(`SELECT client.external_id recordId,
        json_extract(revision.profile_json,'$.name') name
      FROM project_alpha_active_directory_mappings parent
      JOIN operations_directory_client_organizations relationship ON relationship.organization_record_id=parent.external_id
      JOIN project_alpha_active_directory_mappings client ON client.external_id=relationship.client_record_id
        AND client.source_id=parent.source_id AND client.source_instance_id=parent.source_instance_id
        AND client.application_id=parent.application_id AND client.history_epoch_id=parent.history_epoch_id
        AND client.resource_type='client'
      JOIN operations_directory_records record ON record.record_id=client.external_id AND record.record_kind='client'
      JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
      WHERE parent.source_id=? AND parent.source_instance_id=? AND parent.application_id=? AND parent.history_epoch_id=?
        AND parent.resource_type='organization' AND parent.project_alpha_public_id=?
        AND EXISTS(SELECT 1 FROM native_directory_grants allowed
          WHERE allowed.staff_id=? AND allowed.permission='directory.profile.view'
            AND allowed.effect='allow' AND allowed.active=1 AND (allowed.scope_kind='global'
              OR (allowed.scope_kind='resource' AND allowed.resource_id=record.record_id)
              OR (allowed.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
                WHERE assignment.record_id=record.record_id AND assignment.staff_id=allowed.staff_id AND assignment.active=1))
              OR (allowed.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
                WHERE scope.record_id=record.record_id AND scope.active=1 AND scope.business_area_id=allowed.business_area_id))
              OR (allowed.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
                WHERE scope.record_id=record.record_id AND scope.active=1 AND scope.division_id=allowed.division_id))))
        AND NOT EXISTS(SELECT 1 FROM native_directory_grants denied
          WHERE denied.staff_id=? AND denied.permission='directory.profile.view'
            AND denied.effect='deny' AND denied.active=1 AND (denied.scope_kind='global'
              OR (denied.scope_kind='resource' AND denied.resource_id=record.record_id)
              OR (denied.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
                WHERE assignment.record_id=record.record_id AND assignment.staff_id=denied.staff_id AND assignment.active=1))
              OR (denied.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
                WHERE scope.record_id=record.record_id AND scope.active=1 AND scope.business_area_id=denied.business_area_id))
              OR (denied.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
                WHERE scope.record_id=record.record_id AND scope.active=1 AND scope.division_id=denied.division_id))))
      ORDER BY client.external_id LIMIT 101`).bind(root.source_id, configured.connection.expectedSourceInstanceId,
        configured.connection.expectedApplicationId, configured.connection.expectedHistoryEpoch, root.public_id, staffId, staffId)
      .all<{ recordId: string; name: unknown }>()).results;
    if (rows.length > 100) return [];
    return rows.flatMap(row => typeof row.recordId === "string" && row.recordId.length > 0
      && typeof row.name === "string" && row.name.normalize("NFC").trim().length > 0
      ? [{ recordId: row.recordId, name: row.name.normalize("NFC").trim() }] : []);
  } catch { return []; }
}
