-- Ledge Top flight logs (logs.ledgetop.app). Staff-only data: nothing here is ever exposed to clients.
-- Pilots are Ops staff ids; Ops verifies the staff member before any write reaches this database.

CREATE TABLE aircraft (
  id TEXT PRIMARY KEY,
  serial TEXT NOT NULL UNIQUE,
  model TEXT,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'unconfirmed' CHECK (status IN ('unconfirmed', 'active', 'retired')),
  first_flight_at TEXT,
  last_flight_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE batteries (
  id TEXT PRIMARY KEY,
  serial TEXT NOT NULL UNIQUE,
  max_cycle_count INTEGER,
  status TEXT NOT NULL DEFAULT 'unconfirmed' CHECK (status IN ('unconfirmed', 'active', 'retired')),
  first_flight_at TEXT,
  last_flight_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE controllers (
  id TEXT PRIMARY KEY,
  serial TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'unconfirmed' CHECK (status IN ('unconfirmed', 'active', 'retired')),
  first_flight_at TEXT,
  last_flight_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL CHECK (source_system IN ('opendronelog')),
  pilot_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'abandoned')),
  expected_flights INTEGER NOT NULL,
  flights_created INTEGER NOT NULL DEFAULT 0,
  flights_existing INTEGER NOT NULL DEFAULT 0,
  tracks_stored INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

-- file_hash is the SHA-256 of the original DJI log file (ODL's file_hash uses the same definition),
-- so a raw log uploaded later attaches to the flight imported from a backup.
CREATE TABLE flights (
  id TEXT PRIMARY KEY,
  file_hash TEXT NOT NULL UNIQUE,
  source_system TEXT NOT NULL,
  source_flight_id TEXT,
  source_file_name TEXT,
  import_id TEXT REFERENCES imports(id),
  pilot_id TEXT NOT NULL,
  pilot_attribution TEXT NOT NULL CHECK (pilot_attribution IN ('backup_owner', 'controller_sign_in', 'admin_reassigned')),
  aircraft_id TEXT REFERENCES aircraft(id),
  battery_id TEXT REFERENCES batteries(id),
  controller_id TEXT REFERENCES controllers(id),
  display_name TEXT,
  started_at TEXT,
  ended_at TEXT,
  duration_seconds REAL,
  distance_m REAL,
  max_altitude_m REAL,
  max_speed_mps REAL,
  home_lat REAL,
  home_lon REAL,
  photo_count INTEGER NOT NULL DEFAULT 0,
  video_count INTEGER NOT NULL DEFAULT 0,
  battery_cycle_count INTEGER,
  battery_life_percent INTEGER,
  telemetry_points INTEGER NOT NULL DEFAULT 0,
  telemetry_key TEXT,
  raw_log_status TEXT NOT NULL DEFAULT 'missing' CHECK (raw_log_status IN ('missing', 'stored')),
  raw_log_key TEXT,
  notes TEXT,
  color TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX flights_started ON flights(started_at DESC, id);
CREATE INDEX flights_pilot ON flights(pilot_id, started_at DESC);
CREATE INDEX flights_aircraft ON flights(aircraft_id, started_at DESC);

CREATE TABLE flight_tags (
  flight_id TEXT NOT NULL REFERENCES flights(id),
  tag TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('auto', 'manual')),
  PRIMARY KEY (flight_id, tag)
);

CREATE TABLE flight_messages (
  flight_id TEXT NOT NULL REFERENCES flights(id),
  seq INTEGER NOT NULL,
  offset_ms INTEGER,
  level TEXT NOT NULL CHECK (level IN ('tip', 'caution', 'warn')),
  text TEXT NOT NULL,
  PRIMARY KEY (flight_id, seq)
);

-- DJI per-log decryption keys, AES-GCM encrypted with the KEYCHAIN_ENCRYPTION_KEY secret.
-- Only the log parser decrypts them; no API returns them.
CREATE TABLE keychains (
  file_hash TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  fetched_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);
CREATE INDEX audit_subject ON audit_events(subject, at);
