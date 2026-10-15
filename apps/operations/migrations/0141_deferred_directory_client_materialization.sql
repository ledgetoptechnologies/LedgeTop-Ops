PRAGMA foreign_keys = ON;

-- Linked client creates may intentionally remain waiting until their pinned
-- organization intent is acknowledged and exposes its PA public identifier.
-- Keep the scheduler scan bounded without weakening any 0132 evidence guard.
CREATE INDEX operations_directory_intents_waiting_source
  ON operations_directory_intents(state,source_id,created_at,intent_id);

-- Advancing past examined rows prevents a permanently invalid oldest intent
-- from starving later work. An empty scan wraps to the beginning, so blocked
-- rows are retried without becoming mutable or losing their authority record.
CREATE TABLE operations_directory_client_materialization_cursor (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),
  after_created_at TEXT NOT NULL,
  after_intent_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO operations_directory_client_materialization_cursor(singleton,after_created_at,after_intent_id)
VALUES(1,'','');
