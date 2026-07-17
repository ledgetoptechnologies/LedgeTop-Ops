ALTER TABLE sua_reservations
ADD COLUMN missing_snapshots INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_sua_reservation_retention
ON sua_reservations(status, missing_snapshots, ends_at, updated_at);
