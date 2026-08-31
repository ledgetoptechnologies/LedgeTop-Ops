PRAGMA foreign_keys = ON;

-- Contract phase. Abort deterministically before removing any bearer from a
-- notification that may still be sent unless the referenced share can
-- reconstruct that URL from its encrypted secret.
CREATE TABLE migration_0178_delivery_notification_guard (
  ok INTEGER NOT NULL CHECK (ok=1)
);

INSERT INTO migration_0178_delivery_notification_guard(ok)
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM delivery_notifications notification
  LEFT JOIN shares share ON share.id=notification.share_id
  WHERE notification.status IN ('queued','sending','failed')
    AND (
      json_valid(notification.payload_json)=0
      OR json_type(notification.payload_json)<>'object'
      OR (
        json_type(notification.payload_json, '$.shareUrl') IS NOT NULL
        AND (share.public_id IS NULL OR share.secret_ciphertext IS NULL OR share.secret_iv IS NULL)
      )
    )
) THEN 0 ELSE 1 END;

DROP TABLE migration_0178_delivery_notification_guard;

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
