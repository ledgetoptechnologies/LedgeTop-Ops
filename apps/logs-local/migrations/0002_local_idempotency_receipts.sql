-- Idempotency records gain the 'committed' state: the operation's first write committed together with its
-- receipt (same transaction), but the answer is not recorded. SQLite cannot alter a CHECK, so the table is rebuilt.
CREATE TABLE idempotency_records_next (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'done', 'expired', 'unresolved')),
  attempt TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
INSERT INTO idempotency_records_next (id, fingerprint, state, attempt, result, created_at, expires_at)
  SELECT id, fingerprint, state, attempt, result, created_at, expires_at FROM idempotency_records;
DROP TABLE idempotency_records;
ALTER TABLE idempotency_records_next RENAME TO idempotency_records;
CREATE INDEX idempotency_records_expiry ON idempotency_records (expires_at);
CREATE INDEX idempotency_records_state ON idempotency_records (state);
