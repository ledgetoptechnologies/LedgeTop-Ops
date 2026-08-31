PRAGMA foreign_keys = ON;

-- Expand phase: new code stores only publicId, but old Operations writers can
-- continue inserting shareUrl during a rolling deployment. Preserve legacy
-- fragment bearers until the compatible sender has drained them.
UPDATE delivery_notifications
SET payload_json = json_set(
  payload_json,
  '$.publicId', COALESCE(
    json_extract(payload_json, '$.publicId'),
    (SELECT public_id FROM shares WHERE shares.id=delivery_notifications.share_id)
  )
)
WHERE json_valid(payload_json)
  AND json_type(payload_json)='object'
  AND json_type(payload_json, '$.shareUrl') IS NOT NULL;
