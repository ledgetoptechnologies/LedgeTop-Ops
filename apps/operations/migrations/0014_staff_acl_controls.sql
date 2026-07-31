PRAGMA foreign_keys = ON;

-- This is a visibility-only surface.  It does not make any Project Alpha
-- account eligible to sign in; that remains controlled by the existing sync.
INSERT OR IGNORE INTO permissions(key,description) VALUES
  ('administration.view','View Operations administration status');

-- Existing owners retain their intentionally global administration capability.
INSERT OR IGNORE INTO role_permissions(role_id,permission_key)
SELECT 'role-owner',key FROM permissions WHERE key='administration.view';
