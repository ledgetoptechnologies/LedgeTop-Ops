-- Disabled until the release has verified every authority transition hook.
CREATE TABLE portal_shared_profile_runtime(id INTEGER PRIMARY KEY CHECK(id=1),hooks_ready INTEGER NOT NULL DEFAULT 0 CHECK(hooks_ready IN(0,1)));
INSERT INTO portal_shared_profile_runtime(id,hooks_ready) VALUES(1,0);
CREATE TABLE portal_shared_profile_authority_heads(
 workspace_id TEXT PRIMARY KEY,source_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=1),
 state TEXT NOT NULL CHECK(state IN('active','blocked')),operation_id TEXT NOT NULL,pending_operation_id TEXT,
 updated_at TEXT NOT NULL DEFAULT(datetime('now'))
);

-- One local latch closes registration-versus-bulk-enumeration races. Every
-- already-issued proof has an immutable head; no new head can appear between
-- bulk enumeration and its final atomic authority commit.
CREATE TABLE portal_shared_profile_bulk_latch(id INTEGER PRIMARY KEY CHECK(id=1),operation_id TEXT);
INSERT INTO portal_shared_profile_bulk_latch(id,operation_id) VALUES(1,NULL);
CREATE TRIGGER portal_shared_profile_head_bulk_insert BEFORE INSERT ON portal_shared_profile_authority_heads
WHEN EXISTS(SELECT 1 FROM portal_shared_profile_bulk_latch WHERE id=1 AND operation_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'shared-profile-bulk-authority-pending'); END;
CREATE TRIGGER portal_shared_profile_head_identity_immutable BEFORE UPDATE ON portal_shared_profile_authority_heads
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.source_id IS NOT OLD.source_id
BEGIN SELECT RAISE(ABORT,'shared-profile-head-identity-immutable'); END;
CREATE TRIGGER portal_shared_profile_head_no_delete BEFORE DELETE ON portal_shared_profile_authority_heads
BEGIN SELECT RAISE(ABORT,'shared-profile-head-identity-immutable'); END;
CREATE TRIGGER portal_shared_profile_head_pending_activation BEFORE UPDATE ON portal_shared_profile_authority_heads
WHEN NEW.state='active' AND (OLD.pending_operation_id IS NOT NULL OR NEW.pending_operation_id IS NOT NULL
 OR EXISTS(SELECT 1 FROM portal_shared_profile_bulk_latch WHERE id=1 AND operation_id IS NOT NULL))
 AND NOT(OLD.state='active' AND OLD.pending_operation_id IS NULL AND NEW.pending_operation_id IS NOT NULL
  AND NEW.operation_id IS OLD.operation_id AND NEW.revision=OLD.revision)
BEGIN SELECT RAISE(ABORT,'shared-profile-authority-pending'); END;
CREATE TABLE portal_shared_profile_authority_recoveries(
 operation_id TEXT PRIMARY KEY CHECK(length(operation_id)=36),ownership_id TEXT NOT NULL UNIQUE CHECK(length(ownership_id)=36),requested_by TEXT NOT NULL,actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),original_hooks_ready INTEGER NOT NULL CHECK(original_hooks_ready IN(0,1)),original_bulk_operation_id TEXT,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','aligned','completed')),final_heads_json TEXT CHECK(final_heads_json IS NULL OR json_valid(final_heads_json)),created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE UNIQUE INDEX portal_shared_profile_authority_one_recovery ON portal_shared_profile_authority_recoveries((1)) WHERE state<>'completed';
CREATE TRIGGER portal_shared_profile_recovery_immutable BEFORE UPDATE ON portal_shared_profile_authority_recoveries
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.ownership_id IS NOT OLD.ownership_id OR NEW.requested_by IS NOT OLD.requested_by OR NEW.actor_json IS NOT OLD.actor_json OR NEW.snapshot_json IS NOT OLD.snapshot_json
 OR NEW.original_hooks_ready IS NOT OLD.original_hooks_ready OR NEW.original_bulk_operation_id IS NOT OLD.original_bulk_operation_id OR NEW.created_at IS NOT OLD.created_at
 OR NOT((OLD.state='pending' AND NEW.state='aligned' AND NEW.final_heads_json IS NOT NULL) OR (OLD.state='aligned' AND NEW.state='completed' AND NEW.final_heads_json IS OLD.final_heads_json))
BEGIN SELECT RAISE(ABORT,'shared-profile-recovery-receipt-immutable'); END;
CREATE TRIGGER portal_shared_profile_recovery_no_delete BEFORE DELETE ON portal_shared_profile_authority_recoveries BEGIN SELECT RAISE(ABORT,'shared-profile-recovery-receipt-immutable'); END;
