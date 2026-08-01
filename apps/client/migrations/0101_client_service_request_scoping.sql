-- Additive, optional scoping details for client-submitted service requests.
-- No map provider, address lookup, or location tracking is introduced here.
-- Existing requests remain valid with all new fields NULL.
ALTER TABLE client_service_requests ADD COLUMN service_category TEXT
  CHECK (service_category IS NULL OR length(trim(service_category)) BETWEEN 1 AND 100);
ALTER TABLE client_service_requests ADD COLUMN deliverables_text TEXT
  CHECK (deliverables_text IS NULL OR length(trim(deliverables_text)) BETWEEN 1 AND 2000);
ALTER TABLE client_service_requests ADD COLUMN site_contact_name TEXT
  CHECK (site_contact_name IS NULL OR length(trim(site_contact_name)) BETWEEN 1 AND 160);
ALTER TABLE client_service_requests ADD COLUMN site_contact_email TEXT
  CHECK (site_contact_email IS NULL OR length(trim(site_contact_email)) BETWEEN 3 AND 320);
ALTER TABLE client_service_requests ADD COLUMN site_contact_phone TEXT
  CHECK (site_contact_phone IS NULL OR length(trim(site_contact_phone)) BETWEEN 3 AND 64);
ALTER TABLE client_service_requests ADD COLUMN desired_completion_at TEXT;
ALTER TABLE client_service_requests ADD COLUMN latitude REAL
  CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90));
ALTER TABLE client_service_requests ADD COLUMN longitude REAL
  CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180));

CREATE INDEX IF NOT EXISTS idx_client_service_requests_triage
  ON client_service_requests(status, desired_completion_at, created_at DESC, id DESC);
