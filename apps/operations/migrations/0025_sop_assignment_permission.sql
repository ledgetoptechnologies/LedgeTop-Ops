PRAGMA foreign_keys = ON;

-- Assigning an immutable published SOP revision to visible work is narrower
-- than authoring SOPs or editing the rest of a job brief. Keep that authority
-- independently grantable and explicitly denyable.
INSERT OR IGNORE INTO permissions(key,description) VALUES
  ('sops.assign','Assign published SOP revisions to visible work');

INSERT OR IGNORE INTO role_permissions(role_id,permission_key)
SELECT id,'sops.assign'
FROM roles
WHERE id IN ('role-owner','role-admin');
