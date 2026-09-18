PRAGMA foreign_keys = ON;

-- Historical rows remain NULL and cannot authorize a new outbound dispatch.
ALTER TABLE operations_directory_audit
  ADD COLUMN original_verified_access_subject TEXT;

-- A new staff audit must be written by the same atomic native authority fence
-- that authorized the canonical mutation. Direct and post-hoc claims fail.
CREATE TRIGGER operations_directory_audit_original_subject_required
BEFORE INSERT ON operations_directory_audit
WHEN NEW.actor_type = 'staff'
BEGIN
  SELECT RAISE(ABORT, 'directory audit original subject is not authorized')
    WHERE NEW.original_verified_access_subject IS NULL
      OR length(NEW.original_verified_access_subject) NOT BETWEEN 1 AND 191
      OR NOT EXISTS (
        SELECT 1 FROM operations_directory_write_fences fence
        WHERE fence.mutation_id = NEW.mutation_id
          AND fence.actor_id = NEW.actor_id
          AND fence.bound_access_subject = NEW.original_verified_access_subject
      );
END;

CREATE TRIGGER operations_directory_audit_system_subject_null
BEFORE INSERT ON operations_directory_audit
WHEN NEW.actor_type = 'system' AND NEW.original_verified_access_subject IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'system directory audit cannot claim an Access subject');
END;

-- Preserve legacy reservations, but do not create new wire commands from an
-- intent whose original staff identity was never recorded.
CREATE TRIGGER operations_directory_materializations_original_subject_required
BEFORE INSERT ON operations_directory_materializations
WHEN NOT EXISTS (
  SELECT 1 FROM operations_directory_intents intent
  JOIN operations_directory_audit audit ON audit.mutation_id=intent.mutation_id
    AND audit.record_id=intent.record_id AND audit.record_version=intent.record_version
  WHERE intent.intent_id=NEW.intent_id AND audit.actor_type='staff'
    AND audit.original_verified_access_subject IS NOT NULL
    AND length(audit.original_verified_access_subject) BETWEEN 1 AND 191
)
BEGIN SELECT RAISE(ABORT, 'directory materialization requires original actor identity'); END;
