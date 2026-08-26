import { createCatalogSourceContext, PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";

/** Configured server provenance, not authentication or a second-source registry. */
export interface ProjectAlphaSourceContext { readonly sourceId: string; readonly staffAuthority: boolean }
export function createProjectAlphaSourceContext(sourceId: unknown): ProjectAlphaSourceContext {
  const validated = createCatalogSourceContext(sourceId).sourceId;
  return Object.freeze({ sourceId: validated, staffAuthority: validated === PRIMARY_ALPHA_SOURCE_ID });
}
export const PRIMARY_PROJECT_ALPHA_SOURCE = createProjectAlphaSourceContext(PRIMARY_ALPHA_SOURCE_ID);

export const PROJECT_ALPHA_RECORD_KINDS = [
  "user", "business_unit", "client", "organization", "project", "project_assignment", "service_location",
  "application_entitlement", "operation", "task", "calendar_event", "contract", "invoice",
] as const;
export type ProjectAlphaRecordKind = (typeof PROJECT_ALPHA_RECORD_KINDS)[number];
const kinds = new Set<string>(PROJECT_ALPHA_RECORD_KINDS);
interface CollectionIdentity { readonly idKind: ProjectAlphaRecordKind | null; readonly references: Readonly<Record<string, ProjectAlphaRecordKind>> }
export const PROJECT_ALPHA_COLLECTION_IDENTITIES = {
  users: { idKind: "user", references: {} },
  business_units: { idKind: "business_unit", references: {} },
  worker_business_units: { idKind: null, references: { user_id: "user", business_unit_id: "business_unit" } },
  clients: { idKind: "client", references: { organization_id: "organization" } },
  organizations: { idKind: "organization", references: {} },
  projects: { idKind: "project", references: { client_id: "client", organization_id: "organization", business_unit_id: "business_unit", manager_user_id: "user" } },
  project_assignments: { idKind: "project_assignment", references: { project_id: "project", user_id: "user" } },
  service_locations: { idKind: "service_location", references: { project_id: "project", client_id: "client", organization_id: "organization" } },
  application_entitlements: { idKind: "application_entitlement", references: { user_id: "user" } },
  operations: { idKind: "operation", references: { project_id: "project", business_unit_id: "business_unit", created_by: "user", created_by_user_id: "user" } },
  operation_assignments: { idKind: null, references: { operation_id: "operation", user_id: "user", assigned_by: "user", assigned_by_user_id: "user" } },
  tasks: { idKind: "task", references: { operation_id: "operation", project_id: "project", business_unit_id: "business_unit", assignee_user_id: "user", created_by: "user", created_by_user_id: "user" } },
  task_assignments: { idKind: null, references: { task_id: "task", user_id: "user", assigned_by: "user", assigned_by_user_id: "user" } },
  calendar_events: { idKind: "calendar_event", references: { project_id: "project", business_unit_id: "business_unit" } },
} as const satisfies Record<string, CollectionIdentity>;
export type ProjectAlphaCollectionName = keyof typeof PROJECT_ALPHA_COLLECTION_IDENTITIES;
export interface ProjectAlphaSourceReference { readonly kind: ProjectAlphaRecordKind; readonly externalId: string }
export interface ProjectAlphaSourceMap {
  readonly sourceId: string;
  get(kind: ProjectAlphaRecordKind, externalId: string): string;
  optional(kind: ProjectAlphaRecordKind, externalId: string | null): string | null;
}
type SourceDatabase = Pick<D1Database, "prepare" | "batch">;
interface MappingRow { record_kind: ProjectAlphaRecordKind; external_id: string; local_id: string }

function externalId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const id = typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
  if (id === null || id.length > 1024 || /[\u0000]/u.test(id)) throw new Error("project-alpha-source-record-id-invalid");
  return id;
}
function recordKey(kind: ProjectAlphaRecordKind, id: string): string { return JSON.stringify([kind, id]); }

function fields(collection: ProjectAlphaCollectionName, row: Record<string, unknown>): [string, ProjectAlphaRecordKind][] {
  const identity: CollectionIdentity = PROJECT_ALPHA_COLLECTION_IDENTITIES[collection];
  if (!identity) throw new Error("project-alpha-source-collection-invalid");
  const result: [string, ProjectAlphaRecordKind][] = identity.idKind ? [["id", identity.idKind]] : [];
  result.push(...Object.entries(identity.references));
  if (collection === "calendar_events" && row.source_id !== null && row.source_id !== undefined && row.source_id !== "") {
    if (row.source_type !== "operation" && row.source_type !== "task" && row.source_type !== "contract" && row.source_type !== "invoice") {
      throw new Error("project-alpha-source-calendar-kind-invalid");
    }
    result.push(["source_id", row.source_type]);
  }
  return result;
}

export function projectAlphaSourceReferences(collection: ProjectAlphaCollectionName, row: Record<string, unknown>): ProjectAlphaSourceReference[] {
  return fields(collection, row).flatMap(([field, kind]) => {
    const id = externalId(row[field]);
    return id === null ? [] : [{ kind, externalId: id }];
  });
}

/** Shallow copy only: callers retain the original row for payload_json and hashes. */
export function mapProjectAlphaSourceRow(collection: ProjectAlphaCollectionName, row: Record<string, unknown>, mapping: ProjectAlphaSourceMap): Record<string, unknown> {
  const result = { ...row };
  for (const [field, kind] of fields(collection, row)) {
    const id = externalId(row[field]);
    if (id !== null) result[field] = mapping.get(kind, id);
  }
  return result;
}

/** No whole-directory reads or per-reference queries. A bounded JSON relation
 * joins the exact source/kind/external key; writes never reassign an existing
 * mapping. Reserve missing parents too, without creating active source rows. */
export async function prepareProjectAlphaSourceRecords(db: SourceDatabase, source: ProjectAlphaSourceContext,
  requested: readonly ProjectAlphaSourceReference[]): Promise<ProjectAlphaSourceMap> {
  const { sourceId } = createProjectAlphaSourceContext(source.sourceId);
  const unique = new Map<string, ProjectAlphaSourceReference>();
  for (const reference of requested) {
    if (!kinds.has(reference.kind) || typeof reference.externalId !== "string" || externalId(reference.externalId) === null) {
      throw new Error("project-alpha-source-record-id-invalid");
    }
    unique.set(recordKey(reference.kind, reference.externalId), reference);
  }
  const entries = [...unique.values()];
  const resolved = new Map<string, string>();
  const read = async (chunk: readonly ProjectAlphaSourceReference[]) => {
    // Keep the bounded JSON request as the outer loop: SQLite otherwise chose
    // a source-only index scan over every reserved record before filtering IDs.
    const rows = await db.prepare(`SELECT m.record_kind,m.external_id,m.local_id
      FROM json_each(?) requested CROSS JOIN pa_projection_record_ids m
        ON m.projection_source_id=? AND m.record_kind=json_extract(requested.value,'$[0]')
        AND m.external_id=json_extract(requested.value,'$[1]')`)
      .bind(JSON.stringify(chunk.map(reference => [reference.kind, reference.externalId])), sourceId).all<MappingRow>();
    for (const row of rows.results) resolved.set(recordKey(row.record_kind, row.external_id), row.local_id);
  };
  // At most 500 references and 128 KiB of encoded identifiers in each query.
  for (let offset = 0; offset < entries.length;) {
    const chunk: ProjectAlphaSourceReference[] = [];
    let bytes = 2;
    while (offset < entries.length && chunk.length < 500) {
      const next = entries[offset]!;
      const size = new TextEncoder().encode(JSON.stringify([next.kind, next.externalId])).byteLength + 1;
      if (chunk.length && bytes + size > 128 * 1024) break;
      chunk.push(next); bytes += size; offset += 1;
    }
    await read(chunk);
    const missing = chunk.filter(reference => !resolved.has(recordKey(reference.kind, reference.externalId)));
    if (missing.length) {
      const proposed = missing.map(reference => [reference.kind, reference.externalId,
        sourceId === PRIMARY_ALPHA_SOURCE_ID ? reference.externalId : `pa-local-${crypto.randomUUID()}`]);
      try {
        await db.batch([db.prepare(`INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
          SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]')
          FROM json_each(?) requested WHERE NOT EXISTS (
            SELECT 1 FROM pa_projection_record_ids existing WHERE existing.projection_source_id=?
              AND existing.record_kind=json_extract(requested.value,'$[0]')
              AND existing.external_id=json_extract(requested.value,'$[1]')
          )
          ON CONFLICT(projection_source_id,record_kind,external_id) DO NOTHING`).bind(sourceId, JSON.stringify(proposed), sourceId)]);
      } catch (error) {
        if (/UNIQUE constraint failed: pa_projection_record_ids\.record_kind, pa_projection_record_ids\.local_id/.test(error instanceof Error ? error.message : String(error))) {
          throw new Error("project-alpha-source-id-conflict");
        }
        throw error;
      }
      await read(chunk);
    }
    for (const reference of chunk) if (!resolved.has(recordKey(reference.kind, reference.externalId))) throw new Error("project-alpha-source-map-incomplete");
  }
  const get = (kind: ProjectAlphaRecordKind, id: string): string => {
    const local = resolved.get(recordKey(kind, id));
    if (local === undefined) throw new Error("project-alpha-source-reference-unmapped");
    return local;
  };
  return Object.freeze({ sourceId, get, optional: (kind: ProjectAlphaRecordKind, id: string | null) => id === null ? null : get(kind, id) });
}
