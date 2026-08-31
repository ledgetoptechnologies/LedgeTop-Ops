PRAGMA foreign_keys = ON;

-- Delivery URLs contain a fragment bearer. Keep only source identity and
-- presentation snapshots in the outbox; Operations recovers the encrypted
-- share bearer and materializes the configured public origin immediately
-- before handing a message to the mail provider.
UPDATE delivery_notifications
SET payload_json = CASE
  WHEN json_valid(payload_json) AND json_type(payload_json)='object' THEN json_set(
    json_remove(payload_json, '$.shareUrl'),
    '$.publicId', COALESCE(
      json_extract(payload_json, '$.publicId'),
      (SELECT public_id FROM shares WHERE shares.id=delivery_notifications.share_id)
    )
  )
  ELSE json_object(
    'publicId', (SELECT public_id FROM shares WHERE shares.id=delivery_notifications.share_id)
  )
END;

CREATE TRIGGER delivery_notifications_payload_json_insert
BEFORE INSERT ON delivery_notifications
WHEN CASE
  WHEN json_valid(NEW.payload_json)=0 THEN 1
  WHEN json_type(NEW.payload_json)<>'object' THEN 1
  ELSE 0
END
BEGIN
  SELECT RAISE(ABORT, 'delivery notification payload must be a JSON object');
END;

CREATE TRIGGER delivery_notifications_payload_json_update
BEFORE UPDATE OF payload_json ON delivery_notifications
WHEN CASE
  WHEN json_valid(NEW.payload_json)=0 THEN 1
  WHEN json_type(NEW.payload_json)<>'object' THEN 1
  ELSE 0
END
BEGIN
  SELECT RAISE(ABORT, 'delivery notification payload must be a JSON object');
END;

CREATE TRIGGER delivery_notifications_no_stored_share_url_insert
BEFORE INSERT ON delivery_notifications
WHEN CASE
  WHEN json_valid(NEW.payload_json)=0 THEN 0
  ELSE json_type(NEW.payload_json, '$.shareUrl') IS NOT NULL
END
BEGIN
  SELECT RAISE(ABORT, 'delivery notification URLs must be materialized at send time');
END;

CREATE TRIGGER delivery_notifications_no_stored_share_url_update
BEFORE UPDATE OF payload_json ON delivery_notifications
WHEN CASE
  WHEN json_valid(NEW.payload_json)=0 THEN 0
  ELSE json_type(NEW.payload_json, '$.shareUrl') IS NOT NULL
END
BEGIN
  SELECT RAISE(ABORT, 'delivery notification URLs must be materialized at send time');
END;
