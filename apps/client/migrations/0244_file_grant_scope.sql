-- Single-file Client Workspace grants (Hub 2496ea83), step A.
-- object_path is a file's path relative to its folder binding; NULL is a folder grant, as before.
-- Nothing may store a file grant until the readers that enforce one ship (step B drops the closed trigger).
-- Client-facing readers use portal_v2_folder_delivery_grants, which never contains a file grant.
-- The view selects every column by name at creation; a later change to this table's columns must recreate it.
ALTER TABLE portal_v2_authenticated_delivery_grants ADD COLUMN object_path TEXT CHECK (object_path IS NULL OR (
  length(object_path) BETWEEN 1 AND 1024 AND substr(object_path, 1, 1) <> '/' AND substr(object_path, -1, 1) <> '/'));

CREATE TRIGGER portal_v2_authenticated_delivery_grants_file_scope_closed
BEFORE INSERT ON portal_v2_authenticated_delivery_grants
WHEN NEW.object_path IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'file grants are not enabled');
END;

CREATE TRIGGER portal_v2_authenticated_delivery_grants_object_path_immutable
BEFORE UPDATE OF object_path ON portal_v2_authenticated_delivery_grants
WHEN NEW.object_path IS NOT OLD.object_path
BEGIN
  SELECT RAISE(ABORT, 'object_path is immutable');
END;

CREATE VIEW portal_v2_folder_delivery_grants AS
SELECT * FROM portal_v2_authenticated_delivery_grants WHERE object_path IS NULL;
