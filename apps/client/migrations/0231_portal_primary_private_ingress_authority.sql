-- Private Ops Sync primary proof is independent of former direct HTTP keys.
-- Registration is empty until validated private ingress; browser reads never enroll.
CREATE TABLE pa_portal_primary_private_authority (
  source_id TEXT PRIMARY KEY CHECK(source_id='project-alpha:primary'),
  application_key TEXT NOT NULL CHECK(length(application_key) BETWEEN 1 AND 128
    AND instr(application_key,char(0))=0
    AND substr(application_key,1,1) GLOB '[A-Za-z0-9]'
    AND application_key NOT GLOB '*[^A-Za-z0-9_.:-]*'),
  state TEXT NOT NULL CHECK(state IN ('active','suspended','retired')),
  version INTEGER NOT NULL CHECK(version>0),
  created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE TRIGGER pa_portal_primary_private_insert_guard BEFORE INSERT ON pa_portal_primary_private_authority
WHEN EXISTS(SELECT 1 FROM pa_portal_primary_private_authority)
  OR NEW.state<>'active' OR NEW.version<>1
BEGIN SELECT RAISE(ABORT,'portal-primary-private-conflict'); END;
CREATE TRIGGER pa_portal_primary_private_update_guard BEFORE UPDATE ON pa_portal_primary_private_authority
WHEN NEW.source_id IS NOT OLD.source_id OR NEW.application_key IS NOT OLD.application_key
  OR NEW.created_at IS NOT OLD.created_at OR OLD.state='retired' OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'portal-primary-private-conflict'); END;
CREATE TRIGGER pa_portal_primary_private_no_delete BEFORE DELETE ON pa_portal_primary_private_authority
BEGIN SELECT RAISE(ABORT,'portal-primary-private-immutable'); END;
