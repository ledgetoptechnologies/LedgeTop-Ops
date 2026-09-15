PRAGMA foreign_keys = ON;

CREATE TABLE native_staff_profiles (
  staff_id TEXT NOT NULL PRIMARY KEY REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  login_email TEXT NOT NULL COLLATE NOCASE UNIQUE
    CHECK(length(login_email) BETWEEN 3 AND 254
      AND login_email=lower(login_email) COLLATE BINARY
      AND login_email=trim(login_email)
      AND instr(login_email,char(0))=0
      AND instr(login_email,'@')>1),
  display_name TEXT NOT NULL
    CHECK(length(display_name) BETWEEN 1 AND 160
      AND length(trim(display_name)) BETWEEN 1 AND 160
      AND instr(display_name,char(0))=0),
  version INTEGER NOT NULL DEFAULT 1
    CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER native_staff_profiles_update_guard BEFORE UPDATE ON native_staff_profiles
WHEN NEW.staff_id IS NOT OLD.staff_id
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'native staff profile update is invalid'); END;
