-- Controllers (devices), their TV-style sign-in requests, and the ledger of raw DJI logs they upload.
-- A pilot types their Ledge Top username on the controller. It is resolved once, through Ops'
-- StaffDirectory, to a stable active staff id; only that staff member, signed in to Ops, can approve. Raw logs are stored write-once by content hash and are never shown to clients.

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  pilot_id TEXT NOT NULL,                 -- Ops staff id the device is signed in as
  model TEXT,
  name TEXT,
  hardware_id TEXT,                       -- Android ID; identifies the controller, never authorizes
  token_hash TEXT NOT NULL UNIQUE,        -- SHA-256 of the device token; the token itself is never stored
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  approved_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT
);
CREATE INDEX devices_pilot ON devices(pilot_id, status);

CREATE TABLE device_sign_ins (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,                     -- shown on the controller, e.g. KXT-482
  username TEXT NOT NULL,                 -- as typed on the controller (display only)
  pilot_id TEXT NOT NULL,                 -- the stable Ops staff id the username resolved to at issuance
  poll_token_hash TEXT NOT NULL,
  model TEXT,
  name TEXT,
  hardware_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'collected', 'expired')),
  device_id TEXT REFERENCES devices(id),  -- set when the controller collects its token (once, after approval)
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);
CREATE INDEX device_sign_ins_username ON device_sign_ins(username, status, expires_at);
CREATE INDEX device_sign_ins_pilot ON device_sign_ins(pilot_id, status, expires_at);

-- One row per distinct raw log (content hash). Attribution is fixed at upload: the pilot and device the
-- controller was signed in as when it sent the file. Parsing is a separate, fenced step (needs_parse ->
-- leased -> decoded | failed); an upload never marks a flight parsed by itself.
CREATE TABLE raw_logs (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  file_name TEXT,
  r2_key TEXT NOT NULL UNIQUE,
  -- Only controller uploads for now: a staff upload needs its own reviewed 'staff_selected' attribution first.
  source TEXT NOT NULL CHECK (source IN ('controller')),
  device_id TEXT NOT NULL REFERENCES devices(id),
  pilot_id TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  parse_status TEXT NOT NULL DEFAULT 'needs_parse' CHECK (parse_status IN ('needs_parse', 'leased', 'decoded', 'failed')),
  parse_attempts INTEGER NOT NULL DEFAULT 0,
  attempt_token TEXT,
  lease_expires_at TEXT,
  error_code TEXT,                        -- safe category only (e.g. keychain_unavailable); never raw details
  flight_id TEXT REFERENCES flights(id),  -- set by the decoder once a flight exists for this log
  decoded_at TEXT
);
CREATE INDEX raw_logs_parse ON raw_logs(parse_status, lease_expires_at);
CREATE INDEX raw_logs_pilot ON raw_logs(pilot_id, uploaded_at DESC);
