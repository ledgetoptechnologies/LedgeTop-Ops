PRAGMA foreign_keys=ON;

-- Add capabilities without granting them to any existing identity.
DROP TRIGGER native_staff_authority_capabilities_no_insert;
INSERT INTO native_staff_authority_capabilities VALUES
 (1,'staff_admin','staff.documents.read'),(1,'staff_admin','staff.documents.upload'),
 (1,'staff_admin','staff.documents.manage'),(1,'staff_admin','staff.profile.archive'),
 (1,'staff_admin','staff.profile.restore');
CREATE TRIGGER native_staff_authority_capabilities_no_insert BEFORE INSERT ON native_staff_authority_capabilities
BEGIN SELECT RAISE(ABORT,'native staff authority capability catalog is frozen'); END;

CREATE TABLE staff_personnel_profiles(
 staff_id TEXT PRIMARY KEY REFERENCES native_staff_profiles(staff_id) ON DELETE RESTRICT,
 archived_at TEXT, version INTEGER NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740990)
);
INSERT INTO staff_personnel_profiles(staff_id) SELECT staff_id FROM native_staff_profiles;
CREATE TRIGGER staff_personnel_profile_created AFTER INSERT ON native_staff_profiles
BEGIN INSERT INTO staff_personnel_profiles(staff_id) VALUES(NEW.staff_id); END;
CREATE TRIGGER staff_personnel_profiles_no_delete BEFORE DELETE ON staff_personnel_profiles
BEGIN SELECT RAISE(ABORT,'personnel profiles are retained'); END;
CREATE TRIGGER native_staff_profiles_no_delete BEFORE DELETE ON native_staff_profiles
BEGIN SELECT RAISE(ABORT,'staff profiles must be archived'); END;
CREATE TRIGGER staff_personnel_archived_no_admission BEFORE UPDATE ON native_staff_admissions
WHEN NEW.active=1 AND EXISTS(SELECT 1 FROM staff_personnel_profiles WHERE staff_id=NEW.staff_id AND archived_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'archived staff cannot be admitted'); END;

-- No PA/legacy role or self-service access. Explicit native personnel delegation
-- is required. Denies across every matching scope win over global/exact allows.
CREATE VIEW staff_personnel_authority_candidates AS
SELECT actor.staff_id actor_staff_id,actor.bound_access_subject,target.staff_id target_staff_id,cap.capability
FROM native_staff_admissions actor
JOIN native_staff_profiles actor_profile ON actor_profile.staff_id=actor.staff_id
CROSS JOIN native_staff_profiles target
JOIN native_staff_authority_capabilities cap ON cap.authority_domain='staff_admin'
 AND cap.capability IN ('staff.documents.read','staff.documents.upload','staff.documents.manage','staff.profile.archive','staff.profile.restore')
WHERE actor.active=1
 AND EXISTS(SELECT 1 FROM native_staff_management_delegations d WHERE d.actor_staff_id=actor.staff_id
  AND d.capability=cap.capability AND d.contract_version=1 AND d.active=1 AND d.effect='allow'
  AND (d.scope_kind='global' OR (d.scope_kind='exact_staff' AND d.target_staff_id=target.staff_id)))
 AND NOT EXISTS(SELECT 1 FROM native_staff_management_delegations d WHERE d.actor_staff_id=actor.staff_id
  AND d.capability=cap.capability AND d.contract_version=1 AND d.active=1 AND d.effect='deny'
  AND (d.scope_kind='global' OR (d.scope_kind='exact_staff' AND d.target_staff_id=target.staff_id)
   OR EXISTS(SELECT 1 FROM native_staff_target_memberships m WHERE m.staff_id=target.staff_id AND m.active=1
    AND m.business_area_id=d.business_area_id AND (d.scope_kind='business_area' OR (d.scope_kind='division' AND m.division_id=d.division_id)))))
 AND NOT EXISTS(SELECT 1 FROM native_staff_target_memberships m
  LEFT JOIN native_business_areas a ON a.id=m.business_area_id
  LEFT JOIN native_business_divisions b ON b.id=m.division_id AND b.business_area_id=m.business_area_id
  WHERE m.staff_id=target.staff_id AND m.active=1 AND (coalesce(a.active,0)<>1 OR (m.scope_kind='division' AND coalesce(b.active,0)<>1)));

CREATE TABLE staff_personnel_documents(
 id TEXT PRIMARY KEY, staff_id TEXT NOT NULL REFERENCES staff_personnel_profiles(staff_id) ON DELETE RESTRICT,
 actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id), actor_access_subject TEXT NOT NULL, command_id TEXT NOT NULL,
 request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
 filename TEXT NOT NULL CHECK(length(filename) BETWEEN 1 AND 160),
 category TEXT NOT NULL CHECK(category IN ('agreement','tax','onboarding','other')),
 content_type TEXT NOT NULL CHECK(content_type IN ('application/pdf','image/jpeg','image/png','text/plain',
 'application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
 size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 26214400),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'), object_key TEXT NOT NULL UNIQUE CHECK(object_key='personnel/'||id||'/content'),
 object_etag TEXT, object_version TEXT, status TEXT NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','quarantined','accepted','rejected')),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 scanned_at TEXT, UNIQUE(actor_staff_id,command_id), UNIQUE(id,staff_id)
);
CREATE INDEX staff_personnel_documents_profile ON staff_personnel_documents(staff_id,created_at DESC,id);
CREATE TRIGGER staff_personnel_documents_authority BEFORE INSERT ON staff_personnel_documents
WHEN NOT EXISTS(SELECT 1 FROM staff_personnel_authority_candidates a
 JOIN staff_personnel_profiles p ON p.staff_id=a.target_staff_id
 WHERE a.actor_staff_id=NEW.actor_staff_id AND a.bound_access_subject=NEW.actor_access_subject
 AND a.target_staff_id=NEW.staff_id AND a.capability='staff.documents.upload' AND p.archived_at IS NULL)
BEGIN SELECT RAISE(ABORT,'personnel upload authority changed'); END;
CREATE TRIGGER staff_personnel_document_quota BEFORE INSERT ON staff_personnel_documents
WHEN (SELECT count(*) FROM staff_personnel_documents WHERE staff_id=NEW.staff_id)>=100
 OR (SELECT coalesce(sum(size_bytes),0) FROM staff_personnel_documents WHERE staff_id=NEW.staff_id)+NEW.size_bytes>536870912
BEGIN SELECT RAISE(ABORT,'personnel document quota reached'); END;
CREATE TRIGGER staff_personnel_documents_identity BEFORE UPDATE ON staff_personnel_documents
WHEN NEW.id IS NOT OLD.id OR NEW.staff_id IS NOT OLD.staff_id OR NEW.actor_staff_id IS NOT OLD.actor_staff_id
 OR NEW.actor_access_subject IS NOT OLD.actor_access_subject OR NEW.command_id IS NOT OLD.command_id OR NEW.request_sha256 IS NOT OLD.request_sha256
 OR NEW.filename IS NOT OLD.filename OR NEW.category IS NOT OLD.category OR NEW.content_type IS NOT OLD.content_type
 OR NEW.size_bytes IS NOT OLD.size_bytes OR NEW.sha256 IS NOT OLD.sha256 OR NEW.object_key IS NOT OLD.object_key
 OR NEW.created_at IS NOT OLD.created_at OR (OLD.object_etag IS NOT NULL AND NEW.object_etag IS NOT OLD.object_etag)
 OR (OLD.object_version IS NOT NULL AND NEW.object_version IS NOT OLD.object_version)
 OR NOT ((OLD.status='uploading' AND NEW.status='quarantined' AND NEW.object_etag IS NOT NULL AND NEW.object_version IS NOT NULL AND NEW.scanned_at IS NULL)
  OR (OLD.status='quarantined' AND NEW.status IN ('accepted','rejected') AND NEW.scanned_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'invalid personnel document transition'); END;
CREATE TRIGGER staff_personnel_documents_no_delete BEFORE DELETE ON staff_personnel_documents
BEGIN SELECT RAISE(ABORT,'personnel documents are retained'); END;

CREATE TABLE staff_personnel_retention(
 document_id TEXT PRIMARY KEY REFERENCES staff_personnel_documents(id) ON DELETE RESTRICT,
 hold INTEGER NOT NULL DEFAULT 0 CHECK(hold IN (0,1)), review_after TEXT,
 review_note TEXT NOT NULL DEFAULT '' CHECK(length(review_note)<=500),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740990)
);
CREATE TRIGGER staff_personnel_retention_created AFTER INSERT ON staff_personnel_documents
BEGIN INSERT INTO staff_personnel_retention(document_id) VALUES(NEW.id); END;
CREATE TRIGGER staff_personnel_retention_no_delete BEFORE DELETE ON staff_personnel_retention
BEGIN SELECT RAISE(ABORT,'retention metadata is retained'); END;
CREATE TRIGGER staff_personnel_retention_version BEFORE UPDATE ON staff_personnel_retention
WHEN NEW.document_id IS NOT OLD.document_id OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'retention version changed'); END;
CREATE TRIGGER staff_personnel_profile_version BEFORE UPDATE ON staff_personnel_profiles
WHEN NEW.staff_id IS NOT OLD.staff_id OR NEW.version<>OLD.version+1
 OR (NEW.archived_at IS NOT NULL AND EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=NEW.staff_id AND active=1))
BEGIN SELECT RAISE(ABORT,'personnel lifecycle version changed'); END;

CREATE TABLE staff_personnel_events(
 id TEXT PRIMARY KEY, actor_staff_id TEXT REFERENCES native_staff_admissions(staff_id),
 actor_access_subject TEXT, staff_id TEXT NOT NULL REFERENCES staff_personnel_profiles(staff_id),
 document_id TEXT REFERENCES staff_personnel_documents(id),
 capability TEXT NOT NULL CHECK(capability IN ('staff.documents.read','staff.documents.upload','staff.documents.manage','staff.profile.archive','staff.profile.restore','scanner')),
 command_id TEXT NOT NULL, request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
 expected_version INTEGER, details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(details_json) AND length(details_json)<=2048),
 event_kind TEXT NOT NULL CHECK(event_kind IN ('uploaded','downloaded','retention_updated','profile_archived','profile_restored','scan_accepted','scan_rejected')),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(actor_staff_id,command_id), FOREIGN KEY(document_id,staff_id) REFERENCES staff_personnel_documents(id,staff_id)
);
CREATE TRIGGER staff_personnel_events_authority BEFORE INSERT ON staff_personnel_events
WHEN NEW.capability<>'scanner' AND NOT EXISTS(SELECT 1 FROM staff_personnel_authority_candidates a
 WHERE a.actor_staff_id=NEW.actor_staff_id AND a.bound_access_subject=NEW.actor_access_subject
  AND a.target_staff_id=NEW.staff_id AND a.capability=NEW.capability)
BEGIN SELECT RAISE(ABORT,'personnel authority changed'); END;
CREATE TRIGGER staff_personnel_upload_completion_lifecycle BEFORE INSERT ON staff_personnel_events
WHEN NEW.event_kind='uploaded' AND (NEW.capability<>'staff.documents.upload'
 OR NOT EXISTS(SELECT 1 FROM staff_personnel_profiles WHERE staff_id=NEW.staff_id AND archived_at IS NULL))
BEGIN SELECT RAISE(ABORT,'personnel upload target is archived'); END;
CREATE UNIQUE INDEX staff_personnel_scan_once ON staff_personnel_events(document_id) WHERE capability='scanner';
CREATE TRIGGER staff_personnel_events_lifecycle BEFORE INSERT ON staff_personnel_events
WHEN NEW.event_kind IN ('profile_archived','profile_restored') AND (
 NEW.document_id IS NOT NULL OR NEW.actor_staff_id=NEW.staff_id
 OR NEW.capability<>CASE NEW.event_kind WHEN 'profile_archived' THEN 'staff.profile.archive' ELSE 'staff.profile.restore' END
 OR NOT EXISTS(SELECT 1 FROM staff_personnel_profiles p WHERE p.staff_id=NEW.staff_id AND p.version=NEW.expected_version
 AND CASE NEW.event_kind WHEN 'profile_archived' THEN p.archived_at IS NULL ELSE p.archived_at IS NOT NULL END))
BEGIN SELECT RAISE(ABORT,'personnel lifecycle conflict'); END;
CREATE TRIGGER staff_personnel_events_archive AFTER INSERT ON staff_personnel_events
WHEN NEW.event_kind='profile_archived'
BEGIN
 UPDATE native_staff_admissions SET active=0,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE staff_id=NEW.staff_id AND active=1;
 UPDATE staff_personnel_profiles SET archived_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1 WHERE staff_id=NEW.staff_id AND version=NEW.expected_version;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM native_staff_control_plane_candidates) THEN RAISE(ABORT,'personnel archive requires surviving administrator') END;
END;
CREATE TRIGGER staff_personnel_events_restore AFTER INSERT ON staff_personnel_events
WHEN NEW.event_kind='profile_restored'
BEGIN UPDATE staff_personnel_profiles SET archived_at=NULL,version=version+1 WHERE staff_id=NEW.staff_id AND version=NEW.expected_version; END;
CREATE TRIGGER staff_personnel_events_retention BEFORE INSERT ON staff_personnel_events
WHEN NEW.event_kind='retention_updated' AND (NEW.capability<>'staff.documents.manage'
 OR NOT EXISTS(SELECT 1 FROM staff_personnel_retention WHERE document_id=NEW.document_id AND version=NEW.expected_version)
 OR json_type(NEW.details_json,'$.hold') NOT IN ('true','false') OR json_type(NEW.details_json,'$.reviewNote')<>'text')
BEGIN SELECT RAISE(ABORT,'personnel retention conflict'); END;
CREATE TRIGGER staff_personnel_events_retention_apply AFTER INSERT ON staff_personnel_events
WHEN NEW.event_kind='retention_updated'
BEGIN UPDATE staff_personnel_retention SET hold=json_extract(NEW.details_json,'$.hold'),
 review_after=json_extract(NEW.details_json,'$.reviewAfter'),review_note=json_extract(NEW.details_json,'$.reviewNote'),version=version+1
 WHERE document_id=NEW.document_id AND version=NEW.expected_version; END;
CREATE TRIGGER staff_personnel_events_no_update BEFORE UPDATE ON staff_personnel_events
BEGIN SELECT RAISE(ABORT,'personnel audit is immutable'); END;
CREATE TRIGGER staff_personnel_events_no_delete BEFORE DELETE ON staff_personnel_events
BEGIN SELECT RAISE(ABORT,'personnel audit is retained'); END;
