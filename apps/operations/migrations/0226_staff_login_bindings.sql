PRAGMA foreign_keys = ON;

-- Additional login credentials belong to one existing Ops staff profile. They
-- never create staff, change its primary identity, roles, or PA records.
CREATE TABLE staff_login_binding_control (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL CHECK(schema_version=1)
);
INSERT INTO staff_login_binding_control VALUES(1,1);
CREATE TABLE staff_login_generations (
 staff_id TEXT PRIMARY KEY REFERENCES staff_users(id) ON DELETE RESTRICT,
 generation INTEGER NOT NULL DEFAULT 0 CHECK(typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740990)
);
CREATE TABLE staff_login_binding_intents (
 id TEXT PRIMARY KEY NOT NULL,staff_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
 canonical_email TEXT NOT NULL,canonical_subject TEXT NOT NULL,issuer TEXT NOT NULL,alternate_email TEXT NOT NULL COLLATE NOCASE,
 token_sha256 TEXT NOT NULL UNIQUE CHECK(length(token_sha256)=64 AND token_sha256 NOT GLOB '*[^0-9a-f]*'),
 generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>=0),
 created_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms=created_at_ms+900000),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','claimed')),binding_id TEXT,
 CHECK((status='pending' AND binding_id IS NULL) OR (status='claimed' AND binding_id IS NOT NULL)),
 CHECK(alternate_email=lower(trim(alternate_email)) COLLATE BINARY AND length(alternate_email) BETWEEN 3 AND 254
  AND instr(alternate_email,'@')>1 AND instr(alternate_email,char(0))=0 AND alternate_email<>canonical_email COLLATE NOCASE)
);
CREATE TABLE staff_login_bindings (
 id TEXT PRIMARY KEY NOT NULL,staff_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
 issuer TEXT NOT NULL,login_email TEXT NOT NULL COLLATE NOCASE,access_subject TEXT NOT NULL,
 intent_id TEXT NOT NULL UNIQUE REFERENCES staff_login_binding_intents(id) ON DELETE RESTRICT,
 version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740990),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','revoked')),
 created_at_ms INTEGER NOT NULL,revoked_at_ms INTEGER,revoked_by_staff_id TEXT,
 CHECK((status='active' AND version=1 AND revoked_at_ms IS NULL AND revoked_by_staff_id IS NULL)
  OR (status='revoked' AND version=2 AND revoked_at_ms IS NOT NULL AND revoked_by_staff_id=staff_id)),
 CHECK(login_email=lower(trim(login_email)) COLLATE BINARY AND length(login_email) BETWEEN 3 AND 254
  AND instr(login_email,'@')>1 AND instr(login_email,char(0))=0),
 CHECK(length(access_subject) BETWEEN 1 AND 191 AND instr(access_subject,char(0))=0)
);
CREATE UNIQUE INDEX staff_login_bindings_active_email ON staff_login_bindings(issuer,login_email) WHERE status='active';
CREATE UNIQUE INDEX staff_login_bindings_active_subject ON staff_login_bindings(issuer,access_subject) WHERE status='active';
CREATE TABLE staff_login_binding_audit (
 id TEXT PRIMARY KEY NOT NULL,staff_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
 intent_id TEXT NOT NULL REFERENCES staff_login_binding_intents(id) ON DELETE RESTRICT,
 binding_id TEXT,action TEXT NOT NULL CHECK(action IN('intent_created','linked','revoked')),
 occurred_at_ms INTEGER NOT NULL
);

CREATE TRIGGER staff_login_intent_insert BEFORE INSERT ON staff_login_binding_intents
WHEN NEW.status<>'pending' OR NEW.binding_id IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM staff_users s WHERE s.id=NEW.staff_id AND s.status='active'
  AND s.email=NEW.canonical_email COLLATE BINARY AND s.access_subject=NEW.canonical_subject
  AND EXISTS(SELECT 1 FROM staff_role_assignments r WHERE r.staff_id=s.id AND r.role_id='role-owner' AND r.scope='global')
  AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides d WHERE d.staff_id=s.id AND d.permission_key='administration.view' AND d.effect='deny' AND d.scope='global'))
 OR NOT EXISTS(SELECT 1 FROM staff_login_generations g WHERE g.staff_id=NEW.staff_id AND g.generation=NEW.generation)
 OR EXISTS(SELECT 1 FROM staff_users WHERE email=NEW.alternate_email COLLATE NOCASE)
 OR EXISTS(SELECT 1 FROM staff_login_bindings WHERE issuer=NEW.issuer AND login_email=NEW.alternate_email COLLATE NOCASE AND status='active')
BEGIN SELECT RAISE(ABORT,'staff_login_intent_denied'); END;
CREATE TRIGGER staff_login_intent_update BEFORE UPDATE ON staff_login_binding_intents
WHEN OLD.status<>'pending' OR NEW.status<>'claimed' OR NEW.binding_id IS NULL
 OR NEW.id IS NOT OLD.id OR NEW.staff_id IS NOT OLD.staff_id OR NEW.canonical_email IS NOT OLD.canonical_email
 OR NEW.canonical_subject IS NOT OLD.canonical_subject OR NEW.issuer IS NOT OLD.issuer OR NEW.alternate_email IS NOT OLD.alternate_email
 OR NEW.token_sha256 IS NOT OLD.token_sha256 OR NEW.generation IS NOT OLD.generation
 OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
 OR NOT EXISTS(SELECT 1 FROM staff_login_bindings b WHERE b.id=NEW.binding_id AND b.intent_id=OLD.id AND b.staff_id=OLD.staff_id)
BEGIN SELECT RAISE(ABORT,'staff_login_intent_immutable'); END;
CREATE TRIGGER staff_login_intent_no_delete BEFORE DELETE ON staff_login_binding_intents
BEGIN SELECT RAISE(ABORT,'staff_login_intent_durable'); END;

CREATE TRIGGER staff_login_binding_insert BEFORE INSERT ON staff_login_bindings
WHEN NEW.status<>'active' OR NEW.version<>1
 OR (SELECT count(*) FROM staff_login_bindings b WHERE b.staff_id=NEW.staff_id AND b.status='active')>=10
 OR NOT EXISTS(SELECT 1 FROM staff_login_binding_intents i JOIN staff_users s ON s.id=i.staff_id
  JOIN staff_login_generations g ON g.staff_id=s.id AND g.generation=i.generation
  WHERE i.id=NEW.intent_id AND i.status='pending' AND i.staff_id=NEW.staff_id AND i.issuer=NEW.issuer
   AND i.alternate_email=NEW.login_email COLLATE BINARY AND i.expires_at_ms>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
   AND s.status='active' AND s.email=i.canonical_email COLLATE BINARY AND s.access_subject=i.canonical_subject
   AND EXISTS(SELECT 1 FROM staff_role_assignments r WHERE r.staff_id=s.id AND r.role_id='role-owner' AND r.scope='global')
   AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides d WHERE d.staff_id=s.id AND d.permission_key='administration.view' AND d.effect='deny' AND d.scope='global'))
 OR EXISTS(SELECT 1 FROM staff_users s WHERE s.email=NEW.login_email COLLATE NOCASE OR s.access_subject=NEW.access_subject)
BEGIN SELECT RAISE(ABORT,'staff_login_binding_denied'); END;
CREATE TRIGGER staff_login_binding_update BEFORE UPDATE ON staff_login_bindings
WHEN OLD.status<>'active' OR NEW.status<>'revoked' OR NEW.version<>OLD.version+1
 OR NEW.revoked_at_ms IS NULL OR NEW.revoked_by_staff_id IS NOT OLD.staff_id
 OR NEW.id IS NOT OLD.id OR NEW.staff_id IS NOT OLD.staff_id OR NEW.issuer IS NOT OLD.issuer
 OR NEW.login_email IS NOT OLD.login_email OR NEW.access_subject IS NOT OLD.access_subject
 OR NEW.intent_id IS NOT OLD.intent_id OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN SELECT RAISE(ABORT,'staff_login_binding_immutable'); END;
CREATE TRIGGER staff_login_binding_no_delete BEFORE DELETE ON staff_login_bindings
BEGIN SELECT RAISE(ABORT,'staff_login_binding_durable'); END;

CREATE TRIGGER staff_login_binding_linked AFTER INSERT ON staff_login_bindings
BEGIN
 UPDATE staff_login_binding_intents SET status='claimed',binding_id=NEW.id WHERE id=NEW.intent_id;
 UPDATE staff_login_generations SET generation=generation+1 WHERE staff_id=NEW.staff_id;
 -- Invalidate ephemeral native contexts without changing the admission version
 -- pinned by durable employee grants. Identity, profile data and roles stay put.
 UPDATE native_staff_profiles SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE staff_id=NEW.staff_id;
 INSERT INTO staff_login_binding_audit VALUES('linked:'||NEW.id,NEW.staff_id,NEW.intent_id,NEW.id,'linked',NEW.created_at_ms);
END;
CREATE TRIGGER staff_login_binding_revoked AFTER UPDATE ON staff_login_bindings
BEGIN
 UPDATE staff_login_generations SET generation=generation+1 WHERE staff_id=NEW.staff_id;
 UPDATE native_staff_profiles SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE staff_id=NEW.staff_id;
 INSERT INTO staff_login_binding_audit VALUES('revoked:'||NEW.id,NEW.staff_id,NEW.intent_id,NEW.id,'revoked',NEW.revoked_at_ms);
END;
CREATE TRIGGER staff_login_canonical_insert_collision BEFORE INSERT ON staff_users
WHEN EXISTS(SELECT 1 FROM staff_login_bindings b WHERE b.status='active' AND (b.login_email=NEW.email COLLATE NOCASE OR b.access_subject=NEW.access_subject))
BEGIN SELECT RAISE(ABORT,'staff_login_identity_collision'); END;
CREATE TRIGGER staff_login_canonical_update_collision BEFORE UPDATE ON staff_users
WHEN EXISTS(SELECT 1 FROM staff_login_bindings b WHERE b.status='active' AND (b.login_email=NEW.email COLLATE NOCASE OR b.access_subject=NEW.access_subject))
BEGIN SELECT RAISE(ABORT,'staff_login_identity_collision'); END;
CREATE TRIGGER staff_login_generation_update BEFORE UPDATE ON staff_login_generations
WHEN NEW.staff_id IS NOT OLD.staff_id OR NEW.generation<>OLD.generation+1
BEGIN SELECT RAISE(ABORT,'staff_login_generation_invalid'); END;
CREATE TRIGGER staff_login_generation_no_delete BEFORE DELETE ON staff_login_generations
BEGIN SELECT RAISE(ABORT,'staff_login_generation_durable'); END;
CREATE TRIGGER staff_login_audit_no_update BEFORE UPDATE ON staff_login_binding_audit
BEGIN SELECT RAISE(ABORT,'staff_login_audit_immutable'); END;
CREATE TRIGGER staff_login_audit_no_delete BEFORE DELETE ON staff_login_binding_audit
BEGIN SELECT RAISE(ABORT,'staff_login_audit_durable'); END;
CREATE TRIGGER staff_login_control_no_update BEFORE UPDATE ON staff_login_binding_control
BEGIN SELECT RAISE(ABORT,'staff_login_control_immutable'); END;
CREATE TRIGGER staff_login_control_no_delete BEFORE DELETE ON staff_login_binding_control
BEGIN SELECT RAISE(ABORT,'staff_login_control_durable'); END;
