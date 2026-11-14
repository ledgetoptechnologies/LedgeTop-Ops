-- Local-host-only tables (not part of the Logs D1 schema). Applied with their own ledger.
CREATE TABLE idempotency_records (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done')),
  result TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idempotency_records_expiry ON idempotency_records (expires_at);
