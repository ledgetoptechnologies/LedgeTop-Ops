PRAGMA foreign_keys = ON;

CREATE TABLE native_staff_admissions (
  staff_id TEXT NOT NULL PRIMARY KEY REFERENCES staff_users(id) ON DELETE RESTRICT,
  bound_access_subject TEXT NOT NULL UNIQUE CHECK(length(bound_access_subject) BETWEEN 1 AND 191),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  admitted_by TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE native_business_areas (
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 191),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);

CREATE TABLE native_business_divisions (
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 191),
  business_area_id TEXT NOT NULL REFERENCES native_business_areas(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  UNIQUE(business_area_id,id)
);

CREATE TABLE native_directory_resource_scopes (
  record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('business_area','division')),
  business_area_id TEXT NOT NULL REFERENCES native_business_areas(id) ON DELETE RESTRICT,
  division_id TEXT REFERENCES native_business_divisions(id) ON DELETE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  CHECK((scope_kind='business_area' AND division_id IS NULL)
    OR (scope_kind='division' AND division_id IS NOT NULL)),
  FOREIGN KEY(business_area_id,division_id) REFERENCES native_business_divisions(business_area_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX native_directory_resource_scope_identity
  ON native_directory_resource_scopes(record_id,scope_kind,business_area_id,ifnull(division_id,''));

CREATE TABLE native_directory_assignments (
  record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  staff_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  assigned_by TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(record_id,staff_id)
);

CREATE TABLE native_directory_grants (
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 191),
  staff_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  permission TEXT NOT NULL CHECK(permission IN ('directory.profile.view','directory.profile.edit','directory.identity.link',
    'directory.enrollment.manage','directory.portal_access.manage')),
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('global','business_area','division','assigned','resource')),
  business_area_id TEXT REFERENCES native_business_areas(id) ON DELETE RESTRICT,
  division_id TEXT REFERENCES native_business_divisions(id) ON DELETE RESTRICT,
  resource_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  granted_by TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((scope_kind IN ('global','assigned') AND business_area_id IS NULL AND division_id IS NULL AND resource_id IS NULL)
    OR (scope_kind='business_area' AND business_area_id IS NOT NULL AND division_id IS NULL AND resource_id IS NULL)
    OR (scope_kind='division' AND business_area_id IS NULL AND division_id IS NOT NULL AND resource_id IS NULL)
    OR (scope_kind='resource' AND business_area_id IS NULL AND division_id IS NULL AND resource_id IS NOT NULL)),
  UNIQUE(staff_id,permission,effect,scope_kind,business_area_id,division_id,resource_id)
);
CREATE UNIQUE INDEX native_directory_grant_identity
  ON native_directory_grants(staff_id,permission,effect,scope_kind,ifnull(business_area_id,''),ifnull(division_id,''),ifnull(resource_id,''));
CREATE INDEX native_directory_grants_staff_permission ON native_directory_grants(staff_id,permission,active);

CREATE TRIGGER native_staff_admissions_identity BEFORE UPDATE ON native_staff_admissions
WHEN NEW.staff_id IS NOT OLD.staff_id OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'native admission identity is immutable'); END;
CREATE TRIGGER native_directory_grants_identity BEFORE UPDATE ON native_directory_grants
WHEN NEW.id IS NOT OLD.id OR NEW.staff_id IS NOT OLD.staff_id OR NEW.permission IS NOT OLD.permission
  OR NEW.effect IS NOT OLD.effect OR NEW.scope_kind IS NOT OLD.scope_kind
  OR NEW.business_area_id IS NOT OLD.business_area_id OR NEW.division_id IS NOT OLD.division_id
  OR NEW.resource_id IS NOT OLD.resource_id OR NEW.granted_by IS NOT OLD.granted_by OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'native grant identity is immutable'); END;
