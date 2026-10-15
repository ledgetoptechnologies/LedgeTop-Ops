/** A lifecycle head is usable only through an unbroken, immutable activation
 * lineage. This adds evidence to existing readers; it grants no permissions and
 * does not waive their current inventory, binding, source or conflict checks. */
export async function nativeProjectLifecycleCanonicalProof(
  db: D1Database,
  head: "s" | "project",
): Promise<string | null> {
  const columns = await db
    .prepare("PRAGMA table_info(operations_shared_project_revisions)")
    .all<{ name: string }>();
  return nativeProjectLifecycleCanonicalProofForRevisionSchema(db, head, columns.results);
}

/** Reuse only revision columns already read by the current composite proof.
 * Lifecycle relations are still inspected here; no schema or authority state
 * is cached across invocations or database bindings. */
export async function nativeProjectLifecycleCanonicalProofForRevisionSchema(
  db: D1Database,
  head: "s" | "project",
  revisionColumns: readonly { name: string }[],
): Promise<string | null> {
  const tables = [
    "native_project_lifecycle_commands",
    "native_project_lifecycle_receipts",
    "native_project_lifecycle_refreshes",
    "native_project_lifecycle_refresh_receipts",
    "native_project_lifecycle_settlements",
    "native_project_lifecycle_activations",
    "native_project_lifecycle_authorizations",
    "native_project_lifecycle_events",
    "native_project_lifecycle_post_attempts",
    "native_project_lifecycle_activation_fences",
    "native_project_lifecycle_inbound_handoffs",
  ];
  const views = [
    "native_project_lifecycle_live_authorizations",
    "native_project_lifecycle_pending_handoffs",
  ];
  const names = [...tables, ...views];
  const relations = await db
    .prepare(
      `SELECT name,type FROM sqlite_master WHERE name IN (${names.map(() => "?").join(",")})`,
    )
    .bind(...names)
    .all<{ name: string; type: string }>();
  const hasColumn = revisionColumns.some(
    (column) => column.name === "lifecycle_settlement_id",
  );
  if (!hasColumn && relations.results.length === 0) return "0";
  if (
    !hasColumn ||
    relations.results.length !== names.length ||
    relations.results.some(
      (row) => row.type !== (views.includes(row.name) ? "view" : "table"),
    )
  )
    return null;
  const tuple = (alias: string) => `${alias}.source_id=${head}.source_id
    AND ${alias}.source_instance_id=${head}.source_instance_id
    AND ${alias}.application_id=${head}.application_id AND ${alias}.history_epoch_id=${head}.history_epoch_id
    AND ${alias}.external_project_id=${head}.external_project_id AND ${alias}.project_alpha_public_id=${head}.project_alpha_public_id`;
  // Versions strictly decrease. The bounded traversal also fails closed on a
  // corrupted/cyclic graph, rather than relying on SQLite's recursion limit.
  return `EXISTS (WITH RECURSIVE lifecycle_lineage(version,projection,organization,client,depth) AS (
    SELECT ${head}.current_version,${head}.canonical_projection_sha256,
      ${head}.organization_record_id,${head}.client_record_id,0
    UNION ALL
    SELECT command.expected_local_version,command.expected_projection_sha256,
      json_extract(command.prior_head_json,'$.organization_record_id'),
      json_extract(command.prior_head_json,'$.client_record_id'),lineage.depth+1
    FROM lifecycle_lineage lineage
    JOIN operations_shared_project_revisions history ON history.external_project_id=${head}.external_project_id AND history.version=lineage.version
    JOIN native_project_lifecycle_settlements settlement ON settlement.settlement_id=history.lifecycle_settlement_id
    JOIN native_project_lifecycle_commands command ON command.command_id=settlement.command_id
    JOIN native_project_lifecycle_receipts receipt ON receipt.command_id=command.command_id
    JOIN native_project_lifecycle_activations activation ON activation.command_id=command.command_id
      AND activation.settlement_id=settlement.settlement_id AND activation.resulting_local_version=lineage.version
    JOIN native_project_lifecycle_refreshes child ON child.command_id=settlement.refresh_command_id
      AND child.parent_command_id=command.command_id AND child.state='acknowledged'
    JOIN native_project_lifecycle_refresh_receipts refreshed ON refreshed.command_id=child.command_id
    WHERE (lineage.depth<256 AND command.state='activated' AND ${tuple("command")}
      AND command.expected_local_version=lineage.version-1 AND command.expected_local_version>=1
      AND json_extract(command.prior_head_json,'$.current_version')=command.expected_local_version
      AND json_extract(command.prior_head_json,'$.canonical_projection_sha256')=command.expected_projection_sha256
      AND json_extract(command.prior_head_json,'$.organization_record_id') IS lineage.organization
      AND json_extract(command.prior_head_json,'$.client_record_id') IS lineage.client)
      AND (history.read_json=settlement.read_json
      AND json_extract(settlement.read_json,'$.sourceInstanceId')=command.source_instance_id
      AND json_extract(settlement.read_json,'$.applicationId')=command.application_id
      AND json_extract(settlement.read_json,'$.historyEpoch')=command.history_epoch_id
      AND json_extract(settlement.read_json,'$.resource.id')=command.project_alpha_public_id
      AND json_extract(settlement.read_json,'$.resource.projectionSha256')=lineage.projection
      AND json_extract(settlement.read_json,'$.resource.revision')=receipt.project_alpha_revision)
      AND (json_extract(receipt.response_json,'$.accepted')=1
      AND json_extract(receipt.response_json,'$.result.archived')=(command.action='archive')
      AND json_extract(settlement.read_json,'$.data.archived')=(command.action='archive')
      AND child.expected_revision=receipt.project_alpha_revision AND child.expected_projection_sha256=lineage.projection
      AND json_extract(refreshed.response_json,'$.result.resource.publicId')=command.project_alpha_public_id
      AND json_extract(refreshed.response_json,'$.result.resource.id')=command.external_project_id
      AND json_extract(refreshed.response_json,'$.result.resource.revision')=child.expected_revision
      AND json_extract(refreshed.response_json,'$.result.resource.projectionSha256')=lineage.projection)
    UNION ALL
    SELECT proposal.expected_local_version,proposal.expected_local_projection_sha256,
      json_extract(proposal.local_snapshot_json,'$.organization_record_id'),
      json_extract(proposal.local_snapshot_json,'$.client_record_id'),lineage.depth+1
    FROM lifecycle_lineage lineage
    JOIN operations_shared_project_revisions history ON history.external_project_id=${head}.external_project_id AND history.version=lineage.version
    JOIN project_alpha_project_inbound_resolution_receipts inbound ON inbound.resolution_id=history.inbound_resolution_id
    JOIN project_alpha_project_inbound_proposals proposal ON proposal.proposal_id=inbound.proposal_id
    JOIN project_alpha_project_inbound_resolution_authorizations reviewed ON reviewed.resolution_id=inbound.resolution_id AND reviewed.proposal_id=proposal.proposal_id
    WHERE lineage.depth>0 AND lineage.depth<256 AND inbound.decision='accept_project_alpha'
      AND reviewed.decision='accept_project_alpha' AND ${tuple("proposal")}
      AND inbound.resulting_local_version=lineage.version AND inbound.prior_local_version=lineage.version-1
      AND proposal.expected_local_version=inbound.prior_local_version
      AND reviewed.final_remote_projection_sha256=lineage.projection
      AND reviewed.target_organization_record_id IS lineage.organization AND reviewed.target_client_record_id IS lineage.client
      AND history.read_json=reviewed.final_remote_snapshot_json
    ) SELECT 1 FROM lifecycle_lineage lineage
      JOIN project_alpha_project_v2_canonical_activation_receipts activation
        ON activation.external_project_id=${head}.external_project_id AND activation.resulting_local_version=lineage.version
      JOIN project_alpha_project_v2_canonical_settlement_receipts settlement
        ON settlement.settlement_id=activation.settlement_id AND settlement.command_id=activation.command_id
      WHERE lineage.depth>0 AND ${tuple("settlement")}
        AND settlement.projection_sha256=lineage.projection
        AND activation.organization_record_id IS lineage.organization AND activation.client_record_id IS lineage.client)`;
}
