-- A lost upstream response must retry the same bounded authorization deadline.
CREATE TABLE viewer_direct_client_session_intents (
 actor_identity_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 grant_id TEXT NOT NULL, grant_version INTEGER NOT NULL CHECK(grant_version>=1),
 request_fingerprint TEXT NOT NULL, authorization_expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 PRIMARY KEY(actor_identity_id,idempotency_key),
 FOREIGN KEY(grant_id) REFERENCES viewer_direct_client_grants(id) ON DELETE RESTRICT
);
CREATE INDEX viewer_direct_session_intents_expiry ON viewer_direct_client_session_intents(authorization_expires_at);
CREATE TRIGGER viewer_direct_session_intents_immutable BEFORE UPDATE ON viewer_direct_client_session_intents
BEGIN SELECT RAISE(ABORT,'direct-viewer-session-intent-immutable'); END;
