CREATE TABLE client_hub_native_project_preparations (
  command_id TEXT PRIMARY KEY,
  external_project_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  context_source_id TEXT NOT NULL,
  context_root_namespace TEXT NOT NULL,
  context_root_kind TEXT NOT NULL,
  context_root_public_id TEXT NOT NULL,
  context_version TEXT NOT NULL,
  actor_staff_id TEXT NOT NULL,
  actor_access_subject TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  actor_admission_version INTEGER NOT NULL,
  actor_profile_version INTEGER NOT NULL,
  authority_generation INTEGER NOT NULL,
  source_instance_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  history_epoch_id TEXT NOT NULL,
  transmission_started_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes')),
  CHECK (json_valid(request_json) AND json_type(request_json)='object'),
  CHECK (length(request_sha256)=43 AND request_sha256 NOT GLOB '*[^A-Za-z0-9_-]*'),
  CHECK (expires_at>created_at),
  CHECK (transmission_started_at IS NULL OR transmission_started_at>=created_at)
);
CREATE INDEX idx_client_hub_native_project_preparations_actor
  ON client_hub_native_project_preparations(actor_staff_id,created_at);
CREATE INDEX idx_client_hub_native_project_preparations_project
  ON client_hub_native_project_preparations(external_project_id,created_at);

CREATE TRIGGER client_hub_native_project_preparations_immutable_update
BEFORE UPDATE ON client_hub_native_project_preparations
WHEN NEW.command_id<>OLD.command_id OR NEW.external_project_id<>OLD.external_project_id
  OR NEW.request_json<>OLD.request_json OR NEW.request_sha256<>OLD.request_sha256
  OR NEW.context_source_id<>OLD.context_source_id OR NEW.context_root_namespace<>OLD.context_root_namespace
  OR NEW.context_root_kind<>OLD.context_root_kind OR NEW.context_root_public_id<>OLD.context_root_public_id
  OR NEW.context_version<>OLD.context_version OR NEW.actor_staff_id<>OLD.actor_staff_id
  OR NEW.actor_access_subject<>OLD.actor_access_subject OR NEW.actor_email<>OLD.actor_email
  OR NEW.actor_admission_version<>OLD.actor_admission_version OR NEW.actor_profile_version<>OLD.actor_profile_version
  OR NEW.authority_generation<>OLD.authority_generation OR NEW.source_instance_id<>OLD.source_instance_id
  OR NEW.application_id<>OLD.application_id OR NEW.history_epoch_id<>OLD.history_epoch_id
  OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
  OR OLD.transmission_started_at IS NOT NULL AND NEW.transmission_started_at IS NOT OLD.transmission_started_at
  OR OLD.transmission_started_at IS NULL AND NEW.transmission_started_at IS NULL
  OR OLD.transmission_started_at IS NULL AND NEW.transmission_started_at IS NOT NULL AND NEW.transmission_started_at<OLD.created_at
BEGIN
  SELECT RAISE(ABORT,'client hub native project preparation is immutable');
END;

CREATE TRIGGER client_hub_native_project_preparations_no_delete
BEFORE DELETE ON client_hub_native_project_preparations
BEGIN
  SELECT RAISE(ABORT,'client hub native project preparation cannot be deleted');
END;
