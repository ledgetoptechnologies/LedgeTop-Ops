PRAGMA foreign_keys = ON;

-- Read infrastructure only. No business, producer, credential, binding or data
-- is installed by this migration. 0226 is reserved for linked staff logins.
CREATE TABLE owner_intel_control (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 schema_version INTEGER NOT NULL CHECK(schema_version=1),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
 storage_accepted INTEGER NOT NULL DEFAULT 0 CHECK(storage_accepted IN(0,1)),
 CHECK(enabled=0 OR storage_accepted=1)
);
INSERT INTO owner_intel_control(singleton,schema_version) VALUES(1,1);

-- Internal businesses are not PA clients. A reviewed existing organization may
-- be associated in a future change; names, domains and NULL client IDs confer
-- no identity or authority here.
CREATE TABLE owner_intel_businesses (
 business_id TEXT PRIMARY KEY NOT NULL CHECK(length(business_id) BETWEEN 1 AND 191),
 display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
 status TEXT NOT NULL CHECK(status IN('reviewed','retired'))
);
CREATE TABLE owner_intel_business_aliases (
 route_key TEXT PRIMARY KEY NOT NULL CHECK(length(route_key) BETWEEN 1 AND 64 AND route_key NOT GLOB '*[^a-z0-9-]*'),
 business_id TEXT NOT NULL REFERENCES owner_intel_businesses(business_id) ON DELETE RESTRICT,
 status TEXT NOT NULL CHECK(status IN('active','retired'))
);
-- Dedicated permission domain: ordinary owner/admin roles never imply this
-- read. Every allow names an exact staff/business pair; explicit deny wins.
CREATE TABLE owner_intel_read_grants (
 grant_id TEXT PRIMARY KEY NOT NULL,
 staff_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
 business_id TEXT NOT NULL REFERENCES owner_intel_businesses(business_id) ON DELETE RESTRICT,
 permission_key TEXT NOT NULL CHECK(permission_key='intel.owner.read'),
 effect TEXT NOT NULL CHECK(effect IN('allow','deny')),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
 UNIQUE(staff_id,business_id,effect)
);
CREATE TRIGGER owner_intel_alias_identity BEFORE UPDATE ON owner_intel_business_aliases
WHEN NEW.route_key IS NOT OLD.route_key OR NEW.business_id IS NOT OLD.business_id
 OR (OLD.status='retired' AND NEW.status<>'retired')
BEGIN SELECT RAISE(ABORT,'owner_intel_alias_identity_immutable'); END;
CREATE TRIGGER owner_intel_alias_retained BEFORE DELETE ON owner_intel_business_aliases
BEGIN SELECT RAISE(ABORT,'owner_intel_alias_retained'); END;

CREATE TABLE owner_intel_bindings (
 binding_id TEXT PRIMARY KEY NOT NULL CHECK(length(binding_id) BETWEEN 1 AND 191),
 business_id TEXT NOT NULL UNIQUE REFERENCES owner_intel_businesses(business_id) ON DELETE RESTRICT,
 configuration_revision INTEGER NOT NULL CHECK(configuration_revision>=1),
 status TEXT NOT NULL CHECK(status IN('reviewed','paused','retired')),
 UNIQUE(binding_id,configuration_revision)
);
CREATE TRIGGER owner_intel_binding_identity BEFORE UPDATE ON owner_intel_bindings
WHEN NEW.binding_id IS NOT OLD.binding_id OR NEW.business_id IS NOT OLD.business_id
 OR NEW.configuration_revision<OLD.configuration_revision
BEGIN SELECT RAISE(ABORT,'owner_intel_binding_identity_immutable'); END;

-- Materialized READ DTO, not an alternative producer envelope or ingest API.
-- A future reviewed verifier/projector must build this from accepted frozen v1
-- observations. No route in this change can insert, accept or modify a row.
-- A revision is append-only; fresh acceptance requires a new revision.
CREATE TABLE owner_intel_competitor_projections (
 projection_id TEXT PRIMARY KEY NOT NULL,
 binding_id TEXT NOT NULL,
 configuration_revision INTEGER NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>=1),
 source_contract_sha256 TEXT NOT NULL CHECK(source_contract_sha256='a60a11ddd68df90da80a1e2eaf298434369653d8e8f390b814ed906e7b675b32'),
 read_schema TEXT NOT NULL CHECK(read_schema='ops.intel.competitors.v1'),
 dto_json TEXT NOT NULL CHECK(json_valid(dto_json) AND length(CAST(dto_json AS BLOB))<=262144),
 dto_sha256 TEXT NOT NULL CHECK(length(dto_sha256)=64 AND dto_sha256 NOT GLOB '*[^0-9a-f]*'),
 accepted_at TEXT NOT NULL CHECK(julianday(accepted_at) IS NOT NULL),
 -- Historical projections survive a later configuration revision; readers
 -- select only the binding's current revision.
 FOREIGN KEY(binding_id) REFERENCES owner_intel_bindings(binding_id) ON DELETE RESTRICT,
 UNIQUE(binding_id,configuration_revision,revision)
);
CREATE TRIGGER owner_intel_projection_immutable BEFORE UPDATE ON owner_intel_competitor_projections
BEGIN SELECT RAISE(ABORT,'owner_intel_projection_immutable'); END;
CREATE TRIGGER owner_intel_projection_retained BEFORE DELETE ON owner_intel_competitor_projections
BEGIN SELECT RAISE(ABORT,'owner_intel_projection_retained'); END;
