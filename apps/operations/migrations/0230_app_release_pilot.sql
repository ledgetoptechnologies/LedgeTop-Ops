PRAGMA foreign_keys=ON;

-- Staging-only Windows app release feed. Empty records do not enroll a pilot
-- or qualify a binary. Runtime activation requires separately reviewed rows.
CREATE TABLE app_release_control (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 schema_version INTEGER NOT NULL CHECK(schema_version=1),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
 storage_accepted INTEGER NOT NULL DEFAULT 0 CHECK(storage_accepted IN(0,1)),
 CHECK(enabled=0 OR storage_accepted=1)
);
INSERT INTO app_release_control(singleton,schema_version) VALUES(1,1);

CREATE TABLE app_release_catalog (
 release_id TEXT PRIMARY KEY NOT NULL CHECK(length(release_id) BETWEEN 1 AND 128),
 platform TEXT NOT NULL CHECK(platform='windows'),
 channel TEXT NOT NULL CHECK(channel='pilot'),
 version TEXT NOT NULL CHECK(length(version) BETWEEN 7 AND 23),
 version_major INTEGER NOT NULL CHECK(version_major BETWEEN 0 AND 65535),
 version_minor INTEGER NOT NULL CHECK(version_minor BETWEEN 0 AND 65535),
 version_patch INTEGER NOT NULL CHECK(version_patch BETWEEN 0 AND 65535),
 version_revision INTEGER NOT NULL CHECK(version_revision BETWEEN 0 AND 65535),
 installer_type TEXT NOT NULL CHECK(installer_type='exe'),
 artifact_key TEXT NOT NULL UNIQUE CHECK(length(artifact_key) BETWEEN 1 AND 512 AND instr(artifact_key,'..')=0),
 size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 1073741824),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
 strong_etag TEXT NOT NULL CHECK(length(strong_etag) BETWEEN 2 AND 512 AND substr(strong_etag,1,1)='"' AND substr(strong_etag,-1,1)='"' AND strong_etag NOT LIKE 'W/%'),
 source_commit TEXT NOT NULL CHECK(length(source_commit)=40 AND source_commit NOT GLOB '*[^0-9a-f]*'),
 min_supported TEXT CHECK(min_supported IS NULL OR length(min_supported)<=120),
 notes TEXT CHECK(notes IS NULL OR length(notes)<=600),
 reviewed_by_staff_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
 reviewed_at TEXT NOT NULL CHECK(julianday(reviewed_at) IS NOT NULL),
 UNIQUE(platform,channel,version),
 UNIQUE(platform,channel,version_major,version_minor,version_patch,version_revision),
 CHECK(version=CAST(version_major AS TEXT)||'.'||CAST(version_minor AS TEXT)||'.'||CAST(version_patch AS TEXT)||'.'||CAST(version_revision AS TEXT))
);
CREATE TRIGGER app_release_catalog_immutable_update BEFORE UPDATE ON app_release_catalog
BEGIN SELECT RAISE(ABORT,'app_release_catalog_immutable'); END;
CREATE TRIGGER app_release_catalog_immutable_delete BEFORE DELETE ON app_release_catalog
BEGIN SELECT RAISE(ABORT,'app_release_catalog_retained'); END;

CREATE TABLE app_release_head (
 platform TEXT NOT NULL CHECK(platform='windows'),
 channel TEXT NOT NULL CHECK(channel='pilot'),
 release_id TEXT NOT NULL REFERENCES app_release_catalog(release_id) ON DELETE RESTRICT,
 revision INTEGER NOT NULL CHECK(revision>=1),
 updated_at TEXT NOT NULL CHECK(julianday(updated_at) IS NOT NULL),
 PRIMARY KEY(platform,channel)
);
CREATE TABLE app_release_head_history (
 platform TEXT NOT NULL,
 channel TEXT NOT NULL,
 revision INTEGER NOT NULL,
 release_id TEXT NOT NULL REFERENCES app_release_catalog(release_id) ON DELETE RESTRICT,
 changed_at TEXT NOT NULL,
 PRIMARY KEY(platform,channel,revision)
);
CREATE TRIGGER app_release_head_insert_guard BEFORE INSERT ON app_release_head
WHEN NOT EXISTS(SELECT 1 FROM app_release_catalog r WHERE r.release_id=NEW.release_id AND r.platform=NEW.platform AND r.channel=NEW.channel)
BEGIN SELECT RAISE(ABORT,'app_release_head_invalid'); END;
CREATE TRIGGER app_release_head_update_guard BEFORE UPDATE ON app_release_head
WHEN NEW.platform IS NOT OLD.platform OR NEW.channel IS NOT OLD.channel OR NEW.revision<>OLD.revision+1
 OR NOT EXISTS(SELECT 1 FROM app_release_catalog n JOIN app_release_catalog o ON o.release_id=OLD.release_id
   WHERE n.release_id=NEW.release_id AND n.platform=NEW.platform AND n.channel=NEW.channel
    AND (n.version_major,n.version_minor,n.version_patch,n.version_revision)>(o.version_major,o.version_minor,o.version_patch,o.version_revision))
BEGIN SELECT RAISE(ABORT,'app_release_head_must_advance'); END;
CREATE TRIGGER app_release_head_no_delete BEFORE DELETE ON app_release_head
BEGIN SELECT RAISE(ABORT,'app_release_head_retained'); END;
CREATE TRIGGER app_release_head_history_insert AFTER INSERT ON app_release_head
BEGIN INSERT INTO app_release_head_history VALUES(NEW.platform,NEW.channel,NEW.revision,NEW.release_id,NEW.updated_at); END;
CREATE TRIGGER app_release_head_history_update AFTER UPDATE ON app_release_head
BEGIN INSERT INTO app_release_head_history VALUES(NEW.platform,NEW.channel,NEW.revision,NEW.release_id,NEW.updated_at); END;
CREATE TRIGGER app_release_head_history_immutable_update BEFORE UPDATE ON app_release_head_history
BEGIN SELECT RAISE(ABORT,'app_release_head_history_immutable'); END;
CREATE TRIGGER app_release_head_history_immutable_delete BEFORE DELETE ON app_release_head_history
BEGIN SELECT RAISE(ABORT,'app_release_head_history_retained'); END;

CREATE TABLE app_release_withdrawals (
 release_id TEXT PRIMARY KEY REFERENCES app_release_catalog(release_id) ON DELETE RESTRICT,
 reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 80),
 withdrawn_at TEXT NOT NULL CHECK(julianday(withdrawn_at) IS NOT NULL),
 withdrawn_by_staff_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT
);
CREATE TRIGGER app_release_withdrawal_immutable_update BEFORE UPDATE ON app_release_withdrawals
BEGIN SELECT RAISE(ABORT,'app_release_withdrawal_immutable'); END;
CREATE TRIGGER app_release_withdrawal_immutable_delete BEFORE DELETE ON app_release_withdrawals
BEGIN SELECT RAISE(ABORT,'app_release_withdrawal_retained'); END;

-- A cohort entry is an explicit stable Ops principal allow. Revocation is
-- append-only and cannot be undone by editing or replacing the original row.
CREATE TABLE app_release_pilot_eligibilities (
 eligibility_id TEXT PRIMARY KEY NOT NULL,
 principal_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
 channel TEXT NOT NULL CHECK(channel='pilot'),
 cohort_id TEXT NOT NULL CHECK(length(cohort_id) BETWEEN 1 AND 128),
 cohort_revision INTEGER NOT NULL CHECK(cohort_revision>=1),
 granted_at TEXT NOT NULL CHECK(julianday(granted_at) IS NOT NULL),
 UNIQUE(principal_id,channel),
 UNIQUE(cohort_id,cohort_revision,principal_id)
);
CREATE TRIGGER app_release_pilot_eligibility_insert_guard BEFORE INSERT ON app_release_pilot_eligibilities
WHEN NOT EXISTS(SELECT 1 FROM staff_users s JOIN staff_role_assignments r ON r.staff_id=s.id
 WHERE s.id=NEW.principal_id AND s.status='active' AND r.role_id='role-owner' AND r.scope='global')
BEGIN SELECT RAISE(ABORT,'app_release_pilot_principal_not_owner'); END;
CREATE TRIGGER app_release_pilot_eligibility_immutable_update BEFORE UPDATE ON app_release_pilot_eligibilities
BEGIN SELECT RAISE(ABORT,'app_release_pilot_eligibility_immutable'); END;
CREATE TRIGGER app_release_pilot_eligibility_immutable_delete BEFORE DELETE ON app_release_pilot_eligibilities
BEGIN SELECT RAISE(ABORT,'app_release_pilot_eligibility_retained'); END;
CREATE TABLE app_release_pilot_revocations (
 eligibility_id TEXT PRIMARY KEY REFERENCES app_release_pilot_eligibilities(eligibility_id) ON DELETE RESTRICT,
 reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 80),
 revoked_at TEXT NOT NULL CHECK(julianday(revoked_at) IS NOT NULL),
 revoked_by_staff_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT
);
CREATE TRIGGER app_release_pilot_revocation_immutable_update BEFORE UPDATE ON app_release_pilot_revocations
BEGIN SELECT RAISE(ABORT,'app_release_pilot_revocation_immutable'); END;
CREATE TRIGGER app_release_pilot_revocation_immutable_delete BEFORE DELETE ON app_release_pilot_revocations
BEGIN SELECT RAISE(ABORT,'app_release_pilot_revocation_retained'); END;
