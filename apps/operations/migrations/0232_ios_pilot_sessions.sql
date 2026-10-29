-- Dedicated, short-lived read-only mobile credentials. No business data mutations.
CREATE TABLE ios_pilot_codes (
  code_hash TEXT PRIMARY KEY CHECK(length(code_hash)=64),
  challenge TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  origin TEXT NOT NULL,
  access_audience TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  proof_json TEXT NOT NULL,
  admission_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  session_expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX ios_pilot_codes_staff_created ON ios_pilot_codes(staff_id,created_at);
CREATE TABLE ios_pilot_sessions (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
  origin TEXT NOT NULL,
  access_audience TEXT NOT NULL,
  proof_json TEXT NOT NULL,
  admission_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX ios_pilot_sessions_expiry ON ios_pilot_sessions(expires_at);
