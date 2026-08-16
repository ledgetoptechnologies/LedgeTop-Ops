PRAGMA foreign_keys = ON;

-- role-admin was created in 0005 with every permission that existed then.
-- administration.view was added later in 0014 but was only granted to the
-- owner role, leaving Project Alpha administrators unable to open the page.
INSERT OR IGNORE INTO role_permissions(role_id,permission_key)
SELECT id,'administration.view'
FROM roles
WHERE id IN ('role-owner','role-admin');
