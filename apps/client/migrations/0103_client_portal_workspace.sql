-- D1 applies migrations in an implicit transaction, so foreign_keys cannot be
-- disabled here. Defer checks while the request and notification tables are
-- rebuilt together, preserving every existing row.
PRAGMA defer_foreign_keys = ON;

-- Explicit Project Alpha identifiers remove name-based authorization guesses.
ALTER TABLE client_accounts ADD COLUMN project_alpha_client_id TEXT;
ALTER TABLE client_accounts ADD COLUMN project_alpha_organization_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_client_accounts_pa_client
  ON client_accounts(project_alpha_client_id) WHERE project_alpha_client_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_client_accounts_pa_organization
  ON client_accounts(project_alpha_organization_id) WHERE project_alpha_organization_id IS NOT NULL;

ALTER TABLE projects ADD COLUMN project_alpha_project_id TEXT;
ALTER TABLE projects ADD COLUMN status TEXT;
ALTER TABLE projects ADD COLUMN summary TEXT;
ALTER TABLE projects ADD COLUMN site_address TEXT;
ALTER TABLE projects ADD COLUMN service_address TEXT;
ALTER TABLE projects ADD COLUMN project_contact_name TEXT;
ALTER TABLE projects ADD COLUMN project_contact_email TEXT;
ALTER TABLE projects ADD COLUMN project_contact_phone TEXT;
ALTER TABLE projects ADD COLUMN next_milestone TEXT;
ALTER TABLE projects ADD COLUMN source_updated_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_pa_project
  ON projects(project_alpha_project_id) WHERE project_alpha_project_id IS NOT NULL;

-- Folder authorization is explicit and lives beside the file index read by the
-- client Worker. An association grants a bounded prefix, never an R2 bucket.
CREATE TABLE client_folder_associations (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('project','client')),
  project_id TEXT,
  account_id TEXT NOT NULL,
  r2_prefix TEXT NOT NULL CHECK (length(trim(r2_prefix)) BETWEEN 2 AND 1000 AND substr(r2_prefix,-1)='/'),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  CHECK ((scope_type='project' AND project_id IS NOT NULL) OR (scope_type='client' AND project_id IS NULL)),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES client_accounts(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_client_folder_associations_active
  ON client_folder_associations(scope_type,account_id,COALESCE(project_id,''),r2_prefix)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_client_folder_associations_project
  ON client_folder_associations(account_id,project_id,revoked_at,r2_prefix);

-- Rebuild requests to support account-level work and change requests while
-- preserving all existing rows. The authoritative billing artifact remains PA.
CREATE TABLE client_service_requests_next (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  project_id TEXT,
  parent_request_id TEXT,
  created_by_identity_id TEXT NOT NULL,
  request_type TEXT NOT NULL CHECK (request_type IN ('flight','service')),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  details TEXT NOT NULL CHECK (length(trim(details)) BETWEEN 1 AND 5000),
  location_text TEXT CHECK (location_text IS NULL OR length(trim(location_text)) BETWEEN 1 AND 240),
  preferred_start_at TEXT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint)=43),
  service_category TEXT CHECK (service_category IS NULL OR length(trim(service_category)) BETWEEN 1 AND 100),
  deliverables_text TEXT CHECK (deliverables_text IS NULL OR length(trim(deliverables_text)) BETWEEN 1 AND 2000),
  site_contact_name TEXT CHECK (site_contact_name IS NULL OR length(trim(site_contact_name)) BETWEEN 1 AND 160),
  site_contact_email TEXT CHECK (site_contact_email IS NULL OR length(trim(site_contact_email)) BETWEEN 3 AND 320),
  site_contact_phone TEXT CHECK (site_contact_phone IS NULL OR length(trim(site_contact_phone)) BETWEEN 3 AND 64),
  desired_completion_at TEXT,
  latitude REAL CHECK (latitude IS NULL OR (latitude BETWEEN -90 AND 90)),
  longitude REAL CHECK (longitude IS NULL OR (longitude BETWEEN -180 AND 180)),
  area_geojson TEXT,
  poi_points_json TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','under_review','accepted_pending_pa_linkage','accepted_linked','declined','cancelled','completed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id,idempotency_key),
  FOREIGN KEY (account_id) REFERENCES client_accounts(id),
  FOREIGN KEY (account_id,project_id) REFERENCES client_project_grants(account_id,project_id),
  FOREIGN KEY (created_by_identity_id,account_id) REFERENCES client_identity_links(id,account_id),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (parent_request_id) REFERENCES client_service_requests_next(id)
);
INSERT INTO client_service_requests_next
  (id,account_id,project_id,created_by_identity_id,request_type,title,details,location_text,
   preferred_start_at,idempotency_key,request_fingerprint,service_category,deliverables_text,
   site_contact_name,site_contact_email,site_contact_phone,desired_completion_at,latitude,
   longitude,area_geojson,status,created_at,updated_at)
SELECT id,account_id,project_id,created_by_identity_id,request_type,title,details,location_text,
   preferred_start_at,idempotency_key,request_fingerprint,service_category,deliverables_text,
   site_contact_name,site_contact_email,site_contact_phone,desired_completion_at,latitude,
   longitude,area_geojson,
   CASE status WHEN 'accepted' THEN 'accepted_pending_pa_linkage' ELSE status END,
   created_at,updated_at
FROM client_service_requests;

CREATE TABLE client_portal_notification_outbox_next (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('request_submitted','request_status_changed')),
  status_value TEXT CHECK (status_value IN ('submitted','under_review','accepted_pending_pa_linkage','accepted_linked','declined','cancelled','completed')),
  recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('staff_triage','client_requester')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','suppressed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_expires_at TEXT,
  last_error TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (request_id,event_type,status_value,recipient_kind),
  FOREIGN KEY (request_id) REFERENCES client_service_requests_next(id) ON DELETE CASCADE
);
INSERT INTO client_portal_notification_outbox_next
  (id,request_id,event_type,status_value,recipient_kind,payload_json,status,attempt_count,
   next_attempt_at,lease_expires_at,last_error,delivered_at,created_at,updated_at)
SELECT id,request_id,event_type,
   CASE status_value WHEN 'accepted' THEN 'accepted_pending_pa_linkage' ELSE status_value END,
   recipient_kind,payload_json,status,attempt_count,next_attempt_at,lease_expires_at,last_error,
   delivered_at,created_at,updated_at
FROM client_portal_notification_outbox;

DROP TABLE client_portal_notification_outbox;
DROP TABLE client_service_requests;
ALTER TABLE client_service_requests_next RENAME TO client_service_requests;
ALTER TABLE client_portal_notification_outbox_next RENAME TO client_portal_notification_outbox;
CREATE INDEX idx_client_service_requests_account ON client_service_requests(account_id,created_at DESC,id DESC);
CREATE INDEX idx_client_service_requests_project ON client_service_requests(project_id,status,created_at DESC);
CREATE INDEX idx_client_service_requests_triage ON client_service_requests(status,desired_completion_at,created_at DESC,id DESC);
CREATE INDEX idx_client_service_requests_parent ON client_service_requests(parent_request_id,created_at DESC);
CREATE INDEX idx_client_portal_notification_outbox_ready
  ON client_portal_notification_outbox(status,next_attempt_at,lease_expires_at,created_at);

CREATE TABLE request_pa_artifacts (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('quote','contract','invoice')),
  project_alpha_artifact_id TEXT NOT NULL,
  document_number TEXT,
  artifact_status TEXT NOT NULL,
  total_minor INTEGER,
  currency TEXT CHECK (currency IS NULL OR length(currency)=3),
  verification_fingerprint TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  superseded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (request_id) REFERENCES client_service_requests(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_request_pa_artifact_active
  ON request_pa_artifacts(request_id,artifact_type) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX idx_request_pa_artifact_source
  ON request_pa_artifacts(artifact_type,project_alpha_artifact_id,verification_fingerprint);

CREATE TABLE request_admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (request_id) REFERENCES client_service_requests(id)
);
CREATE INDEX idx_request_admin_audit_request ON request_admin_audit(request_id,created_at DESC,id DESC);
