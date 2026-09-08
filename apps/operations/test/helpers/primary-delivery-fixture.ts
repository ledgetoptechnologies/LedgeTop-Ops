/** Exact primary projection/receipt facts required by the 0189 Operations
 * binding authority fence. Test fixtures compose these at the same points as
 * production's signed projection state; they never bypass the receipt. */
export function primaryProjectionSourceStatements(db: Pick<D1Database, "prepare">, value: {
  workspace: string; snapshot: string; generation: string;
  organization: string; displayName: string;
}): D1PreparedStatement[] {
  return [
    db.prepare(`INSERT INTO pa_portal_projection_generations
      (id,workspace_id,source_generation,source_sequence,snapshot_hash,page_count,record_count,workspace_root_type,
        workspace_root_public_id,workspace_display_name,workspace_source_version,workspace_active,status,complete,projection_source_id)
      VALUES(?,?,?,1,?,1,2,'organization',?,?,'v1',1,'active',1,'project-alpha:primary')`)
      .bind(value.snapshot,value.workspace,value.generation,"a".repeat(64),value.organization,value.displayName),
  ];
}

export function primaryProjectionCheckpointStatement(db: Pick<D1Database, "prepare">, value: {
  workspace: string; generation: string; snapshot: string;
}): D1PreparedStatement {
  return db.prepare("INSERT INTO pa_portal_projection_checkpoints(workspace_id,source_generation,source_sequence,snapshot_generation_id) VALUES(?,?,1,?)")
    .bind(value.workspace,value.generation,value.snapshot);
}

export function primaryStaffReceiptStatement(db: Pick<D1Database, "prepare">, value: {
  binding: string; workspace: string; organization: string; project: string; generation: string; snapshot: string; prefix: string;
}): D1PreparedStatement {
  return db.prepare(`INSERT INTO portal_primary_staff_bindings
    (binding_id,workspace_id,source_id,root_type,root_public_id,owner_scope_type,owner_public_id,project_public_id,
      directory_generation_id,snapshot_generation_id,source_sequence,root_source_version,project_source_version,r2_prefix,
      ops_project_id,ops_context_version,created_by_staff_id,reason_code,state)
    VALUES(?,?,'project-alpha:primary','organization',?,'project',?,?,?, ?,1,'v1','v1',?, ?,?,?, 'migration_0189_legacy_compat','active')`)
    .bind(value.binding,value.workspace,value.organization,value.project,value.project,value.generation,value.snapshot,
      value.prefix,value.project,"0".repeat(64),"staff-a");
}
