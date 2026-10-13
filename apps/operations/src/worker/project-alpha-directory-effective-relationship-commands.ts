import type { ProjectAlphaDirectoryRelationshipAction } from "./project-alpha-directory-relationship-api-v2";

export type ProjectAlphaDirectoryRelationshipCommandKind = "normal" | "generation_recovery";

export type EffectiveRelationshipCommandRow = Readonly<Record<string, unknown> & {
  command_id: string;
  source_id: string;
  source_instance_id: string;
  application_id: string;
  history_epoch_id: string;
  destination_origin: string;
  client_public_id: string;
  action: ProjectAlphaDirectoryRelationshipAction;
  command_json: string;
  request_json: string;
  state: string;
  attempts: number;
  next_attempt_at: number;
  lease_expires_at: number | null;
  outcome_json: string | null;
}>;

const loadNormal = (db: D1Database, commandId: string) => db.prepare(
  "SELECT * FROM project_alpha_directory_relationship_outbox WHERE command_id=?",
).bind(commandId).first<EffectiveRelationshipCommandRow>();

const loadRecovery = (db: D1Database, commandId: string) => db.prepare(
  "SELECT * FROM project_alpha_directory_relationship_recovery_outbox WHERE command_id=?",
).bind(commandId).first<EffectiveRelationshipCommandRow>();

export function loadEffectiveRelationshipCommand(db: D1Database, kind: ProjectAlphaDirectoryRelationshipCommandKind,
  commandId: string): Promise<EffectiveRelationshipCommandRow | null> {
  return kind === "normal" ? loadNormal(db, commandId) : loadRecovery(db, commandId);
}

export async function isEffectiveRelationshipCommandLive(db: D1Database,
  kind: ProjectAlphaDirectoryRelationshipCommandKind, commandId: string): Promise<boolean> {
  if (kind === "normal") return !!await db.prepare(
    "SELECT 1 present FROM project_alpha_directory_live_relationship_commands WHERE command_id=?",
  ).bind(commandId).first();
  return !!await db.prepare(`SELECT 1 present FROM project_alpha_directory_effective_relationship_commands
    WHERE command_kind='generation_recovery' AND command_id=?`).bind(commandId).first();
}

export async function claimEffectiveRelationshipCommand(db: D1Database,
  kind: ProjectAlphaDirectoryRelationshipCommandKind, commandId: string, commandJson: string, token: string,
  now: number, leaseExpiresAt: number): Promise<boolean> {
  const statement = kind === "normal"
    ? db.prepare(`UPDATE project_alpha_directory_relationship_outbox
        SET state='leased',attempts=attempts+1,lease_token=?,lease_expires_at=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE command_id=? AND command_json=? AND ((state='pending' AND next_attempt_at<=?) OR (state='leased' AND lease_expires_at<=?))`)
    : db.prepare(`UPDATE project_alpha_directory_relationship_recovery_outbox
        SET state='leased',attempts=attempts+1,lease_token=?,lease_expires_at=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE command_id=? AND command_json=? AND ((state='pending' AND next_attempt_at<=?) OR (state='leased' AND lease_expires_at<=?))`);
  const result = await statement.bind(token, leaseExpiresAt, commandId, commandJson, now, now).run();
  return result.meta.changes === 1;
}

export async function releaseEffectiveRelationshipCommand(db: D1Database,
  kind: ProjectAlphaDirectoryRelationshipCommandKind, row: EffectiveRelationshipCommandRow, token: string,
  nextAttemptAt: number, now: number): Promise<void> {
  const statement = kind === "normal"
    ? db.prepare(`UPDATE project_alpha_directory_relationship_outbox SET state='pending',lease_token=NULL,lease_expires_at=NULL,
        next_attempt_at=?,outcome_json=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE command_id=? AND state='leased' AND lease_token=? AND lease_expires_at>?`)
    : db.prepare(`UPDATE project_alpha_directory_relationship_recovery_outbox SET state='pending',lease_token=NULL,lease_expires_at=NULL,
        next_attempt_at=?,outcome_json=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE command_id=? AND state='leased' AND lease_token=? AND lease_expires_at>?`);
  await statement.bind(nextAttemptAt, row.command_id, token, now).run();
}

export async function settleEffectiveRelationshipCommand(db: D1Database,
  kind: ProjectAlphaDirectoryRelationshipCommandKind, commandId: string, token: string, now: number,
  state: "acknowledged" | "terminal", outcomeJson: string): Promise<boolean> {
  const normalAcknowledged = `UPDATE project_alpha_directory_relationship_outbox SET state='acknowledged',outcome_json=?,
    lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE command_id=? AND state='leased' AND lease_token=? AND lease_expires_at>?`;
  const normalTerminal = `UPDATE project_alpha_directory_relationship_outbox SET state='terminal',outcome_json=?,
    lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE command_id=? AND state='leased' AND lease_token=? AND lease_expires_at>?`;
  const recoveryAcknowledged = `UPDATE project_alpha_directory_relationship_recovery_outbox SET state='acknowledged',outcome_json=?,
    lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE command_id=? AND state='leased' AND lease_token=? AND lease_expires_at>?`;
  const recoveryTerminal = `UPDATE project_alpha_directory_relationship_recovery_outbox SET state='terminal',outcome_json=?,
    lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE command_id=? AND state='leased' AND lease_token=? AND lease_expires_at>?`;
  const sql = kind === "normal"
    ? (state === "acknowledged" ? normalAcknowledged : normalTerminal)
    : (state === "acknowledged" ? recoveryAcknowledged : recoveryTerminal);
  const result = await db.prepare(sql).bind(outcomeJson, commandId, token, now).run();
  return result.meta.changes === 1;
}
