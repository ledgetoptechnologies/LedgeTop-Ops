ALTER TABLE integration_health ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE integration_health ADD COLUMN circuit_open_until TEXT;

ALTER TABLE integration_reconciliation ADD COLUMN access_consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE integration_reconciliation ADD COLUMN access_circuit_open_until TEXT;
