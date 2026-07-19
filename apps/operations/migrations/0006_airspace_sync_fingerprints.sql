ALTER TABLE airspace_source_health
ADD COLUMN content_fingerprint TEXT;

ALTER TABLE tfr_notices
ADD COLUMN content_fingerprint TEXT;

ALTER TABLE sua_reservations
ADD COLUMN content_fingerprint TEXT;
