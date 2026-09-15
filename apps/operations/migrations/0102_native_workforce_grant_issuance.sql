PRAGMA foreign_keys = ON;

-- Inactive issuance evidence. The audit guard is deliberately evaluated after
-- the grant insert, in the same D1 batch, so a failed proof rolls that insert back.
CREATE TABLE native_workforce_grant_issuances (
  command_id TEXT NOT NULL PRIMARY KEY,
  grant_id TEXT NOT NULL UNIQUE REFERENCES native_workforce_authority_grants(id) ON DELETE RESTRICT,
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL,
  actor_admission_version INTEGER NOT NULL CHECK(actor_admission_version>=1),
  target_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  target_admission_version INTEGER NOT NULL CHECK(target_admission_version>=1),
  manager_delegation_id TEXT NOT NULL REFERENCES native_workforce_grant_manager_delegations(id) ON DELETE RESTRICT,
  manager_delegation_version INTEGER NOT NULL CHECK(manager_delegation_version>=1),
  issuer_ceiling_id TEXT NOT NULL REFERENCES native_workforce_grant_issuer_ceilings(id) ON DELETE RESTRICT,
  issuer_ceiling_version INTEGER NOT NULL CHECK(issuer_ceiling_version>=1),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER native_workforce_grant_issuances_insert_guard BEFORE INSERT ON native_workforce_grant_issuances
WHEN NOT EXISTS (
  SELECT 1 FROM native_workforce_authority_grants grant_row
  JOIN native_staff_admissions actor ON actor.staff_id=NEW.actor_staff_id
  JOIN native_staff_admissions target ON target.staff_id=NEW.target_staff_id
  JOIN native_workforce_grant_manager_delegations manager ON manager.id=NEW.manager_delegation_id
  JOIN native_workforce_grant_issuer_ceilings ceiling ON ceiling.id=NEW.issuer_ceiling_id
  WHERE grant_row.id=NEW.grant_id AND grant_row.staff_id=NEW.target_staff_id
    AND grant_row.granted_by=NEW.actor_staff_id AND grant_row.active=1 AND grant_row.version=1
    AND actor.active=1 AND actor.bound_access_subject=NEW.actor_access_subject AND actor.version=NEW.actor_admission_version
    AND target.active=1 AND target.version=NEW.target_admission_version
    AND manager.actor_staff_id=NEW.actor_staff_id AND manager.actor_access_subject=NEW.actor_access_subject
    AND manager.target_staff_id=NEW.target_staff_id AND manager.effect='allow' AND manager.active=1
    AND manager.contract_version=1 AND manager.version=NEW.manager_delegation_version
    AND NOT EXISTS (SELECT 1 FROM native_workforce_grant_manager_delegations denial
      WHERE denial.actor_staff_id=NEW.actor_staff_id AND denial.actor_access_subject=NEW.actor_access_subject
        AND denial.target_staff_id=NEW.target_staff_id AND denial.contract_version=1 AND denial.effect='deny' AND denial.active=1)
    AND ceiling.parent_delegation_id=manager.id AND ceiling.contract_version=1 AND ceiling.operation='create'
    AND ceiling.grant_effect=grant_row.effect AND ceiling.capability=grant_row.capability
    AND ceiling.effect='allow' AND ceiling.active=1 AND ceiling.version=NEW.issuer_ceiling_version
    AND (ceiling.scope_kind=grant_row.scope_kind
      AND ceiling.business_area_id IS grant_row.business_area_id AND ceiling.division_id IS grant_row.division_id
      AND ceiling.native_project_id IS grant_row.native_project_id
      OR ceiling.scope_kind='business_area' AND grant_row.scope_kind='division'
        AND ceiling.business_area_id=grant_row.business_area_id)
    AND NOT EXISTS (SELECT 1 FROM native_workforce_grant_issuer_ceilings denial
      JOIN native_workforce_grant_manager_delegations parent ON parent.id=denial.parent_delegation_id
      WHERE parent.actor_staff_id=NEW.actor_staff_id AND parent.actor_access_subject=NEW.actor_access_subject
        AND parent.target_staff_id=NEW.target_staff_id AND parent.contract_version=1 AND parent.effect='allow' AND parent.active=1
        AND denial.contract_version=1 AND denial.operation='create' AND denial.grant_effect=grant_row.effect
        AND denial.capability=grant_row.capability AND denial.effect='deny' AND denial.active=1
        AND (denial.scope_kind=grant_row.scope_kind
          AND denial.business_area_id IS grant_row.business_area_id AND denial.division_id IS grant_row.division_id
          AND denial.native_project_id IS grant_row.native_project_id
          OR denial.scope_kind='business_area' AND grant_row.scope_kind='division' AND denial.business_area_id=grant_row.business_area_id
          OR denial.scope_kind='division' AND grant_row.scope_kind='business_area' AND denial.business_area_id=grant_row.business_area_id))
)
BEGIN SELECT RAISE(ABORT,'native workforce grant issuance is invalid'); END;
-- Keep the live-scope proof independent of the delegation/ceiling expression.
-- Both aborting guards run inside the same D1 batch as the grant insert.
CREATE TRIGGER native_workforce_grant_issuances_scope_guard BEFORE INSERT ON native_workforce_grant_issuances
WHEN NOT EXISTS (
  SELECT 1 FROM native_workforce_authority_grants grant_row
  WHERE grant_row.id=NEW.grant_id AND (grant_row.scope_kind='internal'
      OR grant_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_business_areas area WHERE area.id=grant_row.business_area_id AND area.active=1)
      OR grant_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_business_divisions division JOIN native_business_areas area ON area.id=division.business_area_id
        WHERE division.id=grant_row.division_id AND division.business_area_id=grant_row.business_area_id AND division.active=1 AND area.active=1)
      OR grant_row.scope_kind='native_project' AND EXISTS(SELECT 1 FROM operations_shared_projects project
        WHERE project.external_project_id=grant_row.native_project_id AND project.lifecycle='active'
          AND json_type(project.scopes_json)='array' AND json_array_length(project.scopes_json) BETWEEN 1 AND 128
          AND NOT EXISTS(SELECT 1 FROM json_each(project.scopes_json) project_scope
            WHERE CASE WHEN project_scope.type IS NOT 'object' THEN 1 ELSE (
                (SELECT count(*) FROM json_each(project_scope.value))<>3
                OR json_type(project_scope.value,'$.scopeKind') IS NOT 'text'
                OR json_type(project_scope.value,'$.businessAreaId') IS NOT 'text'
                OR (json_extract(project_scope.value,'$.scopeKind')='business_area'
                  AND (json_type(project_scope.value,'$.divisionId') IS NOT 'null'
                    OR NOT EXISTS(SELECT 1 FROM native_business_areas area
                      WHERE area.id=json_extract(project_scope.value,'$.businessAreaId') AND area.active=1)))
                OR (json_extract(project_scope.value,'$.scopeKind')='division'
                  AND (json_type(project_scope.value,'$.divisionId') IS NOT 'text'
                    OR NOT EXISTS(SELECT 1 FROM native_business_divisions division JOIN native_business_areas area ON area.id=division.business_area_id
                    WHERE division.id=json_extract(project_scope.value,'$.divisionId')
                      AND division.business_area_id=json_extract(project_scope.value,'$.businessAreaId')
                      AND division.active=1 AND area.active=1)))
                OR (json_extract(project_scope.value,'$.scopeKind') IS NOT 'business_area'
                  AND json_extract(project_scope.value,'$.scopeKind') IS NOT 'division')
              ) END))
))
BEGIN SELECT RAISE(ABORT,'native workforce grant issuance is invalid'); END;
CREATE TRIGGER native_workforce_grant_issuances_no_update BEFORE UPDATE ON native_workforce_grant_issuances
BEGIN SELECT RAISE(ABORT,'native workforce grant issuance is immutable'); END;
CREATE TRIGGER native_workforce_grant_issuances_no_delete BEFORE DELETE ON native_workforce_grant_issuances
BEGIN SELECT RAISE(ABORT,'native workforce grant issuance is durable'); END;

CREATE TABLE native_workforce_grant_issuance_receipts (
  command_id TEXT NOT NULL PRIMARY KEY REFERENCES native_workforce_grant_issuances(command_id) ON DELETE RESTRICT,
  grant_id TEXT NOT NULL UNIQUE REFERENCES native_workforce_authority_grants(id) ON DELETE RESTRICT,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER native_workforce_grant_issuance_receipts_insert_guard BEFORE INSERT ON native_workforce_grant_issuance_receipts
WHEN NOT EXISTS(SELECT 1 FROM native_workforce_grant_issuances issuance JOIN native_staff_admissions actor ON actor.staff_id=NEW.actor_staff_id
  WHERE issuance.command_id=NEW.command_id AND issuance.grant_id=NEW.grant_id AND issuance.actor_staff_id=NEW.actor_staff_id
    AND issuance.actor_access_subject=NEW.actor_access_subject AND actor.active=1 AND actor.bound_access_subject=NEW.actor_access_subject)
BEGIN SELECT RAISE(ABORT,'native workforce grant issuance receipt is invalid'); END;
CREATE TRIGGER native_workforce_grant_issuance_receipts_no_update BEFORE UPDATE ON native_workforce_grant_issuance_receipts
BEGIN SELECT RAISE(ABORT,'native workforce grant issuance receipt is immutable'); END;
CREATE TRIGGER native_workforce_grant_issuance_receipts_no_delete BEFORE DELETE ON native_workforce_grant_issuance_receipts
BEGIN SELECT RAISE(ABORT,'native workforce grant issuance receipt is durable'); END;
