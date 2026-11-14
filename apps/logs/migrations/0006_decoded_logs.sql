-- 0006 reserved by Merger for decoded-log attribution (PR5). Additive only: no backfill, no rewrite of flights.
--
-- A decoded controller log is NOT a flight until its pilot is known. The uploader (raw_logs.pilot_id, the signed-in
-- controller account) is custody, never proof of who flew. Every decode result is kept here, keyed by the raw log:
--   unassigned  no flight has this content hash: waits for an administrator to assign it (admin only until then);
--   linked      an existing flight (e.g. an ODL import) has this exact hash and the same owner: linked to it;
--   conflict    a flight has this exact hash but a different owner: kept for review, nothing is linked or changed;
--   assigned    an administrator assigned it to a pilot (that creates the flight; see the assignment workflow).
CREATE TABLE decoded_logs (
  raw_sha256 TEXT PRIMARY KEY REFERENCES raw_logs(sha256),
  status TEXT NOT NULL CHECK (status IN ('unassigned', 'linked', 'conflict', 'assigned')),
  summary_json TEXT NOT NULL,
  telemetry_key TEXT,
  result_fingerprint TEXT NOT NULL,
  decoder_version TEXT NOT NULL,
  committed_attempt_token TEXT NOT NULL,
  flight_id TEXT,
  conflict_flight_id TEXT,
  decoded_at TEXT NOT NULL,
  assigned_by TEXT,
  assigned_at TEXT
);
CREATE INDEX decoded_logs_status ON decoded_logs (status, decoded_at);
