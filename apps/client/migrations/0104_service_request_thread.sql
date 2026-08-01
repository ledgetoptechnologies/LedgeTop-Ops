PRAGMA defer_foreign_keys = ON;

-- Every request is an auditable operational thread. Revisions preserve the
-- exact client/staff view without turning LTDS into a financial system.
CREATE TABLE request_revisions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  author_type TEXT NOT NULL CHECK (author_type IN ('client','staff','system')),
  author_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('submitted','client_edit','change_request','staff_proposal','client_response','status_changed','pa_quote_linked')),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  note TEXT CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 2000),
  mutation_key TEXT,
  mutation_fingerprint TEXT CHECK (mutation_fingerprint IS NULL OR length(mutation_fingerprint) IN (43,64)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (request_id,revision_number),
  UNIQUE (request_id,mutation_key),
  FOREIGN KEY (request_id) REFERENCES client_service_requests(id) ON DELETE CASCADE
);
CREATE INDEX idx_request_revisions_thread ON request_revisions(request_id,revision_number DESC);

INSERT INTO request_revisions
  (id,request_id,revision_number,author_type,author_id,action,snapshot_json,created_at)
SELECT 'initial:' || id,id,1,'client',created_by_identity_id,
  CASE WHEN parent_request_id IS NULL THEN 'submitted' ELSE 'change_request' END,
  json_object(
    'requestType',request_type,'title',title,'details',details,'location',location_text,
    'preferredStartAt',preferred_start_at,'serviceCategory',service_category,
    'deliverables',deliverables_text,'siteContactName',site_contact_name,
    'siteContactEmail',site_contact_email,'siteContactPhone',site_contact_phone,
    'desiredCompletionAt',desired_completion_at,'latitude',latitude,'longitude',longitude,
    'areaGeoJson',CASE WHEN json_valid(area_geojson) THEN json(area_geojson) ELSE NULL END,
    'poiPoints',CASE WHEN json_valid(poi_points_json) THEN json(poi_points_json) ELSE json('[]') END,
    'status',status
  ),created_at
FROM client_service_requests;

CREATE TABLE request_operational_estimates (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  scope_text TEXT NOT NULL CHECK (length(trim(scope_text)) BETWEEN 1 AND 5000),
  estimate_amount_minor INTEGER CHECK (estimate_amount_minor IS NULL OR estimate_amount_minor >= 0),
  currency TEXT CHECK (currency IS NULL OR length(currency)=3),
  proposed_fields_json TEXT CHECK (proposed_fields_json IS NULL OR json_valid(proposed_fields_json)),
  status TEXT NOT NULL CHECK (status IN ('draft','ready','accepted','change_requested','superseded')),
  created_by TEXT NOT NULL,
  mutation_key TEXT NOT NULL,
  mutation_fingerprint TEXT NOT NULL CHECK (length(mutation_fingerprint)=64),
  client_response_note TEXT CHECK (client_response_note IS NULL OR length(trim(client_response_note)) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at TEXT,
  UNIQUE (request_id,version),
  UNIQUE (mutation_key),
  FOREIGN KEY (request_id) REFERENCES client_service_requests(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_request_estimate_current ON request_operational_estimates(request_id)
  WHERE status IN ('draft','ready','accepted','change_requested');
CREATE INDEX idx_request_estimate_history ON request_operational_estimates(request_id,version DESC);

-- Extend the durable notification ledger with the explicit client-confirmation
-- event while preserving all queued/sent/retry state from existing data.
CREATE TABLE client_portal_notification_outbox_next (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('request_submitted','request_status_changed','request_confirmation_requested','request_client_response')),
  status_value TEXT CHECK (status_value IN ('submitted','under_review','accepted_pending_pa_linkage','accepted_linked','declined','cancelled','completed')),
  recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('staff_triage','client_requester')),
  dedupe_key TEXT NOT NULL CHECK (length(trim(dedupe_key)) BETWEEN 1 AND 300),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','suppressed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_expires_at TEXT,
  last_error TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (request_id,dedupe_key),
  FOREIGN KEY (request_id) REFERENCES client_service_requests(id) ON DELETE CASCADE
);
INSERT INTO client_portal_notification_outbox_next
  (id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json,status,
   attempt_count,next_attempt_at,lease_expires_at,last_error,delivered_at,created_at,updated_at)
SELECT id,request_id,event_type,status_value,recipient_kind,
  event_type || ':' || COALESCE(status_value,'none') || ':' || recipient_kind,
  CASE WHEN json_valid(payload_json) THEN payload_json ELSE json_object('legacyPayloadDiscarded',1) END,
  status,attempt_count,next_attempt_at,lease_expires_at,last_error,delivered_at,created_at,updated_at
FROM client_portal_notification_outbox;
DROP TABLE client_portal_notification_outbox;
ALTER TABLE client_portal_notification_outbox_next RENAME TO client_portal_notification_outbox;
CREATE INDEX idx_client_portal_notification_outbox_ready
  ON client_portal_notification_outbox(status,next_attempt_at,lease_expires_at,created_at);
