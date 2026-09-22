import type { Env } from "./types";
import { resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";

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
