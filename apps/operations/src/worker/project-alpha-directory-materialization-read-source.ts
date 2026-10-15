/** Fixed, schema-owned read sources only. This never changes the immutable
 * materialization write target or treats observed PA inventory as authority. */
export type DirectoryMaterializationReadSource =
  | "operations_directory_materializations"
  | "operations_directory_effective_materializations";

export async function directoryMaterializationReadSource(
  db: D1Database,
): Promise<DirectoryMaterializationReadSource> {
  const view = await db.prepare(`SELECT name FROM sqlite_master
    WHERE type='view' AND name='operations_directory_effective_materializations'`)
    .first<{ name: string }>();
  return view?.name === "operations_directory_effective_materializations"
    ? "operations_directory_effective_materializations"
    : "operations_directory_materializations";
}

export type ProjectAlphaDirectoryUnsettledReadSource =
  | "project_alpha_directory_outbox"
  | "project_alpha_directory_unsettled_commands";

/** Schema 180 has no recovery lineage and therefore reads the original outbox.
 * Newer schemas expose a reviewed view that hides only a terminal predecessor
 * whose exact latest recovery successor is acknowledged. */
export async function projectAlphaDirectoryUnsettledReadSource(
  db: D1Database,
): Promise<ProjectAlphaDirectoryUnsettledReadSource> {
  const view = await db.prepare(`SELECT name FROM sqlite_master
    WHERE type='view' AND name='project_alpha_directory_unsettled_commands'`)
    .first<{ name: string }>();
  return view?.name === "project_alpha_directory_unsettled_commands"
    ? "project_alpha_directory_unsettled_commands"
    : "project_alpha_directory_outbox";
}
