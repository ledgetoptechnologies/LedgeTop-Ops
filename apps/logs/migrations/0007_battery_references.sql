-- Names belong to the aircraft/battery pair, never to flight identity or the global serial.
-- 0004 remains reserved for controller pairing.
CREATE TABLE battery_references (
  aircraft_id TEXT NOT NULL REFERENCES aircraft(id),
  battery_id TEXT NOT NULL REFERENCES batteries(id),
  reference_name TEXT NOT NULL CHECK (length(reference_name) BETWEEN 1 AND 40),
  normalized_name TEXT NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 40),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (aircraft_id, battery_id),
  UNIQUE (aircraft_id, normalized_name)
);
