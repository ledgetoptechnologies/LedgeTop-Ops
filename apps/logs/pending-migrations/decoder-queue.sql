-- PENDING: no migration number is reserved yet. This file deliberately lives OUTSIDE migrations/ so no tool or
-- helper applies or counts it. When Merger reserves a number it moves to migrations/<NNNN>_decoder_queue.sql
-- unchanged. 0004 is reserved for controller pairing.
--
-- Durable state for the local decoder queue (see DECODER.md). Additive only: no backfill, no data rewrite.
ALTER TABLE raw_logs ADD COLUMN lease_reclaims INTEGER NOT NULL DEFAULT 0;   -- claims taken over after a lease expired (crash, outage, power-off); never counts against parse_attempts
ALTER TABLE raw_logs ADD COLUMN next_attempt_at TEXT;                        -- durable not-before for deferred or retried rows (DJI/network/rate-limit backoff)
ALTER TABLE raw_logs ADD COLUMN claim_request_id TEXT;                       -- the runner's idempotency key for the current claim (a lost claim reply is safe to repeat)
ALTER TABLE raw_logs ADD COLUMN committed_attempt_token TEXT;                -- the attempt whose result was committed (completion receipt identity)
ALTER TABLE raw_logs ADD COLUMN result_fingerprint TEXT;                     -- sha256 of the canonical summary and the track bytes' sha256, committed atomically with the flight
ALTER TABLE raw_logs ADD COLUMN decoder_version TEXT;                        -- parser and output schema identity of the committed result
CREATE INDEX raw_logs_queue ON raw_logs (parse_status, next_attempt_at);
CREATE UNIQUE INDEX raw_logs_claim_request ON raw_logs (claim_request_id) WHERE claim_request_id IS NOT NULL;
