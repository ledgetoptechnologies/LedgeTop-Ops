PRAGMA foreign_keys = ON;

-- Private topology publication only. These rows create no recipient identity,
-- home grant, folder grant, public link, route, or Client-side entitlement.
CREATE TABLE operations_portal_workspace_publication_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  target_revision INTEGER NOT NULL CHECK(target_revision>=1),
  directory_record_count INTEGER NOT NULL CHECK(directory_record_count BETWEEN 1 AND 500),
  project_count INTEGER NOT NULL CHECK(project_count BETWEEN 0 AND 1000),
  folder_reservation_count INTEGER NOT NULL CHECK(folder_reservation_count BETWEEN 0 AND 1000),
  directory_sha256 TEXT NOT NULL CHECK(length(directory_sha256)=64 AND directory_sha256 NOT GLOB '*[^0-9a-f]*'),
  project_sha256 TEXT NOT NULL CHECK(length(project_sha256)=64 AND project_sha256 NOT GLOB '*[^0-9a-f]*'),
  folder_sha256 TEXT NOT NULL CHECK(length(folder_sha256)=64 AND folder_sha256 NOT GLOB '*[^0-9a-f]*'),
  observed_at TEXT NOT NULL CHECK(length(observed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',observed_at) IS observed_at),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE operations_portal_workspace_publication_directory_sources (
  checkpoint_id TEXT NOT NULL REFERENCES operations_portal_workspace_publication_checkpoints(checkpoint_id) ON DELETE RESTRICT,
  record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  record_kind TEXT NOT NULL CHECK(record_kind IN ('organization','client')),
  record_version INTEGER NOT NULL CHECK(record_version>=1),
  parent_record_id TEXT,
  relationship_version INTEGER CHECK(relationship_version IS NULL OR relationship_version>=1),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 512 AND instr(display_name,char(0))=0),
  PRIMARY KEY(checkpoint_id,record_id),
  CHECK((record_kind='organization' AND parent_record_id IS NULL AND relationship_version IS NULL)
    OR (record_kind='client' AND relationship_version IS NOT NULL))
);

CREATE TABLE operations_portal_workspace_publication_project_sources (
  checkpoint_id TEXT NOT NULL REFERENCES operations_portal_workspace_publication_checkpoints(checkpoint_id) ON DELETE RESTRICT,
  external_project_id TEXT NOT NULL REFERENCES operations_shared_projects(external_project_id) ON DELETE RESTRICT,
  project_version INTEGER NOT NULL CHECK(project_version>=1),
  name TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('not_started','active','completed','cancelled')),
  planned_start TEXT,
  planned_end TEXT,
  completed_at TEXT,
  archived INTEGER NOT NULL CHECK(archived IN (0,1)),
  archived_at TEXT,
  overdue_warning INTEGER NOT NULL CHECK(overdue_warning IN (0,1)),
  published INTEGER NOT NULL CHECK(published=1),
  organization_record_id TEXT,
  client_record_id TEXT,
  PRIMARY KEY(checkpoint_id,external_project_id),
  CHECK(organization_record_id IS NOT NULL OR client_record_id IS NOT NULL)
);

CREATE TABLE operations_portal_workspace_publication_folder_sources (
  checkpoint_id TEXT NOT NULL REFERENCES operations_portal_workspace_publication_checkpoints(checkpoint_id) ON DELETE RESTRICT,
  reservation_id TEXT NOT NULL REFERENCES operations_portal_folder_reservation_heads(reservation_id) ON DELETE RESTRICT,
  external_project_id TEXT NOT NULL,
  ops_folder_project_id TEXT NOT NULL,
  division_id TEXT NOT NULL,
  client_folder_binding_id TEXT NOT NULL,
  binding_version INTEGER NOT NULL CHECK(binding_version>=1),
  r2_prefix TEXT NOT NULL,
  base_r2_prefix TEXT NOT NULL,
  base_match_method TEXT NOT NULL,
  base_confirmed_by TEXT NOT NULL,
  base_confirmed_at TEXT NOT NULL,
  PRIMARY KEY(checkpoint_id,reservation_id),
  UNIQUE(checkpoint_id,client_folder_binding_id),
  UNIQUE(checkpoint_id,r2_prefix),
  FOREIGN KEY(checkpoint_id,external_project_id)
    REFERENCES operations_portal_workspace_publication_project_sources(checkpoint_id,external_project_id) ON DELETE RESTRICT
);

CREATE TABLE operations_portal_workspace_publication_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  checkpoint_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_workspace_publication_checkpoints(checkpoint_id) ON DELETE RESTRICT,
  target_id TEXT NOT NULL,
  source_sequence INTEGER NOT NULL CHECK(source_sequence>=1),
  snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256)=64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND length(CAST(snapshot_json AS BLOB))<=1900000),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE operations_portal_workspace_publication_commands (
  operation_id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL UNIQUE,
  operation_fingerprint TEXT NOT NULL UNIQUE CHECK(length(operation_fingerprint)=64 AND operation_fingerprint NOT GLOB '*[^0-9a-f]*'),
  canonical_publication_json TEXT NOT NULL CHECK(json_valid(canonical_publication_json)
    AND length(CAST(canonical_publication_json AS BLOB))<=1900000),
  target_id TEXT NOT NULL,
  target_revision INTEGER NOT NULL CHECK(target_revision>=1),
  client_authority_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  root_kind TEXT NOT NULL CHECK(root_kind IN ('organization','standalone_client')),
  root_record_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
  resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1),
  snapshot_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_workspace_publication_snapshots(snapshot_id) ON DELETE RESTRICT,
  checkpoint_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_workspace_publication_checkpoints(checkpoint_id) ON DELETE RESTRICT,
  source_sequence INTEGER NOT NULL CHECK(source_sequence=resulting_revision),
  snapshot_sha256 TEXT NOT NULL,
  authorized_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  authorized_access_subject TEXT NOT NULL,
  authorized_email TEXT NOT NULL,
  authorized_admission_version INTEGER NOT NULL CHECK(authorized_admission_version>=1),
  authorized_profile_version INTEGER NOT NULL CHECK(authorized_profile_version>=1),
  authorized_grant_generation INTEGER NOT NULL CHECK(authorized_grant_generation>=1),
  authorized_verified_until TEXT NOT NULL CHECK(length(authorized_verified_until)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',authorized_verified_until) IS authorized_verified_until),
  reason TEXT NOT NULL CHECK(length(reason)<=500 AND length(trim(reason)) BETWEEN 1 AND 500 AND instr(reason,char(0))=0),
  observed_at TEXT NOT NULL CHECK(length(observed_at)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',observed_at) IS observed_at),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE operations_portal_workspace_publication_outbox (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_workspace_publication_commands(operation_id) ON DELETE RESTRICT,
  target_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','retry','dispatching','acknowledged','dead','superseded')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  remote_attempted INTEGER NOT NULL DEFAULT 0 CHECK(remote_attempted IN (0,1)),
  next_attempt_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_error_code TEXT,
  claim_token TEXT,
  claim_until TEXT,
  acknowledged_claim_token TEXT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX operations_portal_workspace_publication_one_inflight
  ON operations_portal_workspace_publication_outbox(target_id)
  WHERE state IN ('pending','retry','dispatching');
CREATE INDEX operations_portal_workspace_publication_due
  ON operations_portal_workspace_publication_outbox(state,next_attempt_at,created_at,operation_id);

CREATE TABLE operations_portal_workspace_publication_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_workspace_publication_outbox(operation_id) ON DELETE RESTRICT,
  publication_id TEXT NOT NULL UNIQUE,
  operation_fingerprint TEXT NOT NULL UNIQUE,
  target_id TEXT NOT NULL,
  resulting_revision INTEGER NOT NULL CHECK(resulting_revision>=1),
  source_sequence INTEGER NOT NULL CHECK(source_sequence>=1),
  snapshot_id TEXT NOT NULL UNIQUE,
  snapshot_sha256 TEXT NOT NULL,
  acknowledged_claim_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE operations_portal_workspace_publication_heads (
  target_id TEXT PRIMARY KEY,
  publication_revision INTEGER NOT NULL CHECK(publication_revision>=1),
  target_revision INTEGER NOT NULL CHECK(target_revision>=1),
  client_authority_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL UNIQUE,
  root_kind TEXT NOT NULL,
  root_record_id TEXT NOT NULL,
  source_sequence INTEGER NOT NULL CHECK(source_sequence=publication_revision),
  snapshot_id TEXT NOT NULL UNIQUE,
  checkpoint_id TEXT NOT NULL UNIQUE,
  snapshot_sha256 TEXT NOT NULL,
  latest_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_workspace_publication_receipts(operation_id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE operations_portal_workspace_publication_audit (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_workspace_publication_commands(operation_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action='workspace.snapshot.enqueued'),
  authorized_by_staff_id TEXT NOT NULL,
  authorized_grant_generation INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Exact current source set. A profile edit changes the native record version
-- but never rewrites the workspace reservation's immutable creation version.
CREATE VIEW operations_portal_workspace_publication_current_checkpoints AS
SELECT checkpoint.checkpoint_id
FROM operations_portal_workspace_publication_checkpoints checkpoint
JOIN operations_portal_workspace_reservation_heads workspace
  ON workspace.target_id=checkpoint.target_id AND workspace.revision=checkpoint.target_revision AND workspace.state='active'
WHERE checkpoint.directory_record_count=(SELECT count(*) FROM operations_portal_workspace_publication_directory_sources source
    WHERE source.checkpoint_id=checkpoint.checkpoint_id)
  AND checkpoint.project_count=(SELECT count(*) FROM operations_portal_workspace_publication_project_sources source
    WHERE source.checkpoint_id=checkpoint.checkpoint_id)
  AND checkpoint.folder_reservation_count=(SELECT count(*) FROM operations_portal_workspace_publication_folder_sources source
    WHERE source.checkpoint_id=checkpoint.checkpoint_id)
  AND checkpoint.folder_reservation_count=(SELECT count(*) FROM operations_portal_folder_reservation_heads folder
    WHERE folder.target_id=workspace.target_id AND folder.state='active')
  AND checkpoint.project_count=(SELECT count(*) FROM operations_shared_projects project
    WHERE (workspace.root_kind='organization'
        AND (project.organization_record_id IS NOT NULL OR project.client_record_id IS NOT NULL)
        AND (project.organization_record_id IS NULL OR project.organization_record_id=workspace.root_record_id)
        AND (project.client_record_id IS NULL OR EXISTS(SELECT 1 FROM operations_directory_client_organizations relation
          WHERE relation.client_record_id=project.client_record_id
            AND relation.organization_record_id=workspace.root_record_id)))
      OR (workspace.root_kind='standalone_client' AND project.organization_record_id IS NULL
        AND project.client_record_id=workspace.root_record_id))
  AND ((workspace.root_kind='organization' AND checkpoint.directory_record_count=1+(SELECT count(*)
        FROM operations_directory_client_organizations relation WHERE relation.organization_record_id=workspace.root_record_id))
    OR (workspace.root_kind='standalone_client' AND checkpoint.directory_record_count=1))
  AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_directory_sources source
    LEFT JOIN operations_directory_records record ON record.record_id=source.record_id
    LEFT JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
    WHERE source.checkpoint_id=checkpoint.checkpoint_id AND (record.record_id IS NULL OR revision.record_id IS NULL
      OR source.record_kind<>record.record_kind OR source.record_version<>record.current_version
      OR source.display_name<>json_extract(revision.profile_json,'$.name')
      OR (source.record_kind='organization' AND (workspace.root_kind<>'organization' OR source.record_id<>workspace.root_record_id
        OR source.parent_record_id IS NOT NULL OR source.relationship_version IS NOT NULL))
      OR (source.record_kind='client' AND NOT EXISTS(SELECT 1 FROM operations_directory_client_organizations relation
        JOIN operations_directory_client_organization_history history ON history.client_record_id=relation.client_record_id
          AND history.relationship_version=relation.relationship_version
        WHERE relation.client_record_id=source.record_id AND relation.organization_record_id IS source.parent_record_id
          AND relation.relationship_version=source.relationship_version
          AND ((workspace.root_kind='organization' AND source.parent_record_id=workspace.root_record_id)
            OR (workspace.root_kind='standalone_client' AND source.record_id=workspace.root_record_id
              AND source.parent_record_id IS NULL))))))
  AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_folder_sources source
    LEFT JOIN operations_portal_folder_reservation_heads folder ON folder.reservation_id=source.reservation_id
    LEFT JOIN project_folders physical ON physical.project_id=source.ops_folder_project_id
    WHERE source.checkpoint_id=checkpoint.checkpoint_id AND (folder.reservation_id IS NULL OR folder.target_id<>workspace.target_id
      OR folder.state<>'active' OR folder.revision<>source.binding_version
      OR folder.external_project_id<>source.external_project_id OR folder.ops_folder_project_id<>source.ops_folder_project_id
      OR folder.ops_division_id<>source.division_id OR folder.client_folder_binding_id<>source.client_folder_binding_id
      OR folder.selected_r2_prefix<>source.r2_prefix OR folder.base_r2_prefix<>source.base_r2_prefix
      OR folder.base_match_method<>source.base_match_method OR folder.base_confirmed_by<>source.base_confirmed_by
      OR folder.base_confirmed_at<>source.base_confirmed_at OR physical.project_id IS NULL
      OR physical.division_id<>source.division_id OR physical.r2_prefix<>source.base_r2_prefix
      OR physical.match_method<>source.base_match_method OR physical.confirmed_by<>source.base_confirmed_by
      OR physical.confirmed_at<>source.base_confirmed_at))
  AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_project_sources source
    LEFT JOIN operations_shared_projects project ON project.external_project_id=source.external_project_id
    LEFT JOIN operations_shared_project_revisions revision ON revision.external_project_id=project.external_project_id
      AND revision.version=project.current_version
    WHERE source.checkpoint_id=checkpoint.checkpoint_id AND (project.external_project_id IS NULL OR revision.external_project_id IS NULL
      OR project.current_version<>source.project_version OR project.name<>source.name OR project.lifecycle<>source.lifecycle
      OR project.planned_start IS NOT source.planned_start OR project.planned_end IS NOT source.planned_end
      OR project.completed_at IS NOT source.completed_at OR project.archived<>source.archived
      OR project.archived_at IS NOT source.archived_at OR project.overdue_warning<>source.overdue_warning
      OR project.organization_record_id IS NOT source.organization_record_id OR project.client_record_id IS NOT source.client_record_id
      OR (workspace.root_kind='organization' AND (project.organization_record_id IS NULL
            AND project.client_record_id IS NULL
          OR project.organization_record_id IS NOT NULL AND project.organization_record_id<>workspace.root_record_id
          OR project.client_record_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM operations_directory_client_organizations relation
            WHERE relation.client_record_id=project.client_record_id AND relation.organization_record_id=workspace.root_record_id)))
      OR (workspace.root_kind='standalone_client' AND (project.organization_record_id IS NOT NULL
        OR project.client_record_id IS NOT workspace.root_record_id))))
  AND NOT EXISTS(SELECT 1 FROM operations_shared_projects project
    WHERE ((workspace.root_kind='organization'
          AND (project.organization_record_id IS NOT NULL OR project.client_record_id IS NOT NULL)
          AND (project.organization_record_id IS NULL OR project.organization_record_id=workspace.root_record_id)
          AND (project.client_record_id IS NULL OR EXISTS(SELECT 1 FROM operations_directory_client_organizations relation
            WHERE relation.client_record_id=project.client_record_id
              AND relation.organization_record_id=workspace.root_record_id)))
        OR (workspace.root_kind='standalone_client' AND project.organization_record_id IS NULL
          AND project.client_record_id=workspace.root_record_id))
      AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_project_sources source
        WHERE source.checkpoint_id=checkpoint.checkpoint_id
          AND source.external_project_id=project.external_project_id))
  AND NOT EXISTS(SELECT 1 FROM operations_portal_folder_reservation_heads folder
    WHERE folder.target_id=workspace.target_id AND folder.state='active' AND NOT EXISTS(
      SELECT 1 FROM operations_portal_workspace_publication_folder_sources source
      WHERE source.checkpoint_id=checkpoint.checkpoint_id AND source.reservation_id=folder.reservation_id));

CREATE VIEW operations_portal_workspace_publication_live_commands AS
SELECT command.operation_id
FROM operations_portal_workspace_publication_commands command
JOIN operations_portal_workspace_reservation_heads workspace ON workspace.target_id=command.target_id
  AND workspace.revision=command.target_revision AND workspace.state='active'
JOIN native_staff_admissions admission ON admission.staff_id=command.authorized_by_staff_id
  AND admission.active=1 AND admission.bound_access_subject=command.authorized_access_subject
  AND admission.version=command.authorized_admission_version
JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.login_email=command.authorized_email
  AND profile.version=command.authorized_profile_version
JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
  AND generation.generation=command.authorized_grant_generation
WHERE command.authorized_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=command.authorized_by_staff_id
    AND role.role_id='role-owner' AND role.scope='global')
  AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
    WHERE permission.staff_id=command.authorized_by_staff_id AND permission.record_id=workspace.root_record_id AND permission.effect='allow')
  AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
    WHERE permission.staff_id=command.authorized_by_staff_id AND permission.record_id=workspace.root_record_id AND permission.effect='deny')
  AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
    WHERE permission.staff_id=command.authorized_by_staff_id AND permission.permission_key='projects.view'
      AND permission.effect='allow' AND permission.scope='global')
  AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
    WHERE permission.staff_id=command.authorized_by_staff_id AND permission.permission_key='projects.view'
      AND permission.effect='deny' AND permission.scope='global')
  AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_folder_sources folder
    WHERE folder.checkpoint_id=command.checkpoint_id AND ((SELECT count(DISTINCT permission.permission_key)
      FROM operations_portal_workspace_effective_permissions permission WHERE permission.staff_id=command.authorized_by_staff_id
        AND permission.effect='allow' AND permission.permission_key IN ('projects.view','delivery.browse')
        AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=folder.division_id)))<>2
      OR EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
        WHERE permission.staff_id=command.authorized_by_staff_id AND permission.effect='deny'
          AND permission.permission_key IN ('projects.view','delivery.browse')
          AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=folder.division_id)))));

CREATE TRIGGER operations_portal_workspace_publication_checkpoint_no_update BEFORE UPDATE
ON operations_portal_workspace_publication_checkpoints BEGIN SELECT RAISE(ABORT,'publication checkpoints are immutable'); END;
CREATE TRIGGER operations_portal_workspace_publication_directory_no_update BEFORE UPDATE
ON operations_portal_workspace_publication_directory_sources BEGIN SELECT RAISE(ABORT,'publication directory sources are immutable'); END;
CREATE TRIGGER operations_portal_workspace_publication_project_no_update BEFORE UPDATE
ON operations_portal_workspace_publication_project_sources BEGIN SELECT RAISE(ABORT,'publication project sources are immutable'); END;
CREATE TRIGGER operations_portal_workspace_publication_folder_no_update BEFORE UPDATE
ON operations_portal_workspace_publication_folder_sources BEGIN SELECT RAISE(ABORT,'publication folder sources are immutable'); END;
CREATE TRIGGER operations_portal_workspace_publication_snapshot_no_update BEFORE UPDATE
ON operations_portal_workspace_publication_snapshots BEGIN SELECT RAISE(ABORT,'publication snapshots are immutable'); END;
CREATE TRIGGER operations_portal_workspace_publication_command_no_update BEFORE UPDATE
ON operations_portal_workspace_publication_commands BEGIN SELECT RAISE(ABORT,'publication commands are immutable'); END;
CREATE TRIGGER operations_portal_workspace_publication_receipt_no_update BEFORE UPDATE
ON operations_portal_workspace_publication_receipts BEGIN SELECT RAISE(ABORT,'publication receipts are immutable'); END;
CREATE TRIGGER operations_portal_workspace_publication_audit_no_update BEFORE UPDATE
ON operations_portal_workspace_publication_audit BEGIN SELECT RAISE(ABORT,'publication audit is immutable'); END;

CREATE TRIGGER operations_portal_workspace_publication_checkpoint_no_delete BEFORE DELETE
ON operations_portal_workspace_publication_checkpoints BEGIN SELECT RAISE(ABORT,'publication checkpoints are durable'); END;
CREATE TRIGGER operations_portal_workspace_publication_directory_no_delete BEFORE DELETE
ON operations_portal_workspace_publication_directory_sources BEGIN SELECT RAISE(ABORT,'publication directory sources are durable'); END;
CREATE TRIGGER operations_portal_workspace_publication_project_no_delete BEFORE DELETE
ON operations_portal_workspace_publication_project_sources BEGIN SELECT RAISE(ABORT,'publication project sources are durable'); END;
CREATE TRIGGER operations_portal_workspace_publication_folder_no_delete BEFORE DELETE
ON operations_portal_workspace_publication_folder_sources BEGIN SELECT RAISE(ABORT,'publication folder sources are durable'); END;
CREATE TRIGGER operations_portal_workspace_publication_snapshot_no_delete BEFORE DELETE
ON operations_portal_workspace_publication_snapshots BEGIN SELECT RAISE(ABORT,'publication snapshots are durable'); END;
CREATE TRIGGER operations_portal_workspace_publication_command_no_delete BEFORE DELETE
ON operations_portal_workspace_publication_commands BEGIN SELECT RAISE(ABORT,'publication commands are durable'); END;
CREATE TRIGGER operations_portal_workspace_publication_outbox_no_delete BEFORE DELETE
ON operations_portal_workspace_publication_outbox BEGIN SELECT RAISE(ABORT,'publication outbox is durable'); END;
CREATE TRIGGER operations_portal_workspace_publication_receipt_no_delete BEFORE DELETE
ON operations_portal_workspace_publication_receipts BEGIN SELECT RAISE(ABORT,'publication receipts are durable'); END;
CREATE TRIGGER operations_portal_workspace_publication_head_no_delete BEFORE DELETE
ON operations_portal_workspace_publication_heads BEGIN SELECT RAISE(ABORT,'publication heads are durable'); END;
CREATE TRIGGER operations_portal_workspace_publication_audit_no_delete BEFORE DELETE
ON operations_portal_workspace_publication_audit BEGIN SELECT RAISE(ABORT,'publication audit is durable'); END;

CREATE TRIGGER operations_portal_workspace_publication_command_guard AFTER INSERT
ON operations_portal_workspace_publication_commands
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_current_checkpoints current
    WHERE current.checkpoint_id=NEW.checkpoint_id)
 OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_live_commands live WHERE live.operation_id=NEW.operation_id)
 OR EXISTS(SELECT 1 FROM operations_portal_workspace_publication_outbox outbox
    WHERE outbox.target_id=NEW.target_id AND outbox.state IN ('pending','retry','dispatching'))
 OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_reservation_heads workspace
    WHERE workspace.target_id=NEW.target_id AND workspace.revision=NEW.target_revision AND workspace.state='active'
      AND workspace.client_authority_id=NEW.client_authority_id AND workspace.workspace_id=NEW.workspace_id
      AND workspace.root_kind=NEW.root_kind AND workspace.root_record_id=NEW.root_record_id)
 OR NOT ((NEW.expected_revision=0 AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_heads head
      WHERE head.target_id=NEW.target_id)) OR EXISTS(SELECT 1 FROM operations_portal_workspace_publication_heads head
      WHERE head.target_id=NEW.target_id AND head.publication_revision=NEW.expected_revision
        AND head.target_revision=NEW.target_revision AND head.source_sequence=NEW.expected_revision))
BEGIN SELECT RAISE(ABORT,'publication command is not current and authorized'); END;

CREATE TRIGGER operations_portal_workspace_publication_json_guard BEFORE INSERT
ON operations_portal_workspace_publication_commands
WHEN json_type(NEW.canonical_publication_json) IS NOT 'object'
 OR (SELECT count(*) FROM json_each(NEW.canonical_publication_json))<>11
 OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_publication_json) member WHERE member.key NOT IN
    ('protocol','protocolVersion','action','publicationId','operationId','expectedRevision','resultingRevision','target',
      'snapshot','actorProof','observedAt'))
 OR json_type(NEW.canonical_publication_json,'$.target') IS NOT 'object'
 OR (SELECT count(*) FROM json_each(NEW.canonical_publication_json,'$.target'))<>6
 OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_publication_json,'$.target') member WHERE member.key NOT IN
    ('targetId','targetRevision','clientAuthorityId','workspaceId','rootKind','rootRecordId'))
 OR json_type(NEW.canonical_publication_json,'$.snapshot') IS NOT 'object'
 OR (SELECT count(*) FROM json_each(NEW.canonical_publication_json,'$.snapshot'))<>11
 OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_publication_json,'$.snapshot') member WHERE member.key NOT IN
    ('snapshotId','checkpointId','sourceSequence','complete','counts','snapshotSha256','directoryRecords','projects',
      'folderReservations','recipientAuthorityHeads','deliveryAuthorityHeads'))
 OR json_type(NEW.canonical_publication_json,'$.snapshot.counts') IS NOT 'object'
 OR (SELECT count(*) FROM json_each(NEW.canonical_publication_json,'$.snapshot.counts'))<>5
 OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_publication_json,'$.snapshot.counts') member WHERE member.key NOT IN
    ('directoryRecords','projects','folderReservations','recipientAuthorityHeads','deliveryAuthorityHeads'))
 OR json_type(NEW.canonical_publication_json,'$.actorProof') IS NOT 'object'
 OR (SELECT count(*) FROM json_each(NEW.canonical_publication_json,'$.actorProof'))<>6
 OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_publication_json,'$.actorProof') member WHERE member.key NOT IN
    ('staffId','verifiedAccessSubject','admissionVersion','profileVersion','grantGeneration','verifiedUntil'))
 OR json_extract(NEW.canonical_publication_json,'$.protocol') IS NOT 'operations-portal-workspace-publication'
 OR json_type(NEW.canonical_publication_json,'$.protocolVersion') IS NOT 'integer'
 OR json_extract(NEW.canonical_publication_json,'$.protocolVersion') IS NOT 1
 OR json_extract(NEW.canonical_publication_json,'$.action') IS NOT 'publish'
 OR json_extract(NEW.canonical_publication_json,'$.publicationId') IS NOT NEW.publication_id
 OR json_extract(NEW.canonical_publication_json,'$.operationId') IS NOT NEW.operation_id
 OR json_extract(NEW.canonical_publication_json,'$.expectedRevision') IS NOT CAST(NEW.expected_revision AS TEXT)
 OR json_extract(NEW.canonical_publication_json,'$.resultingRevision') IS NOT CAST(NEW.resulting_revision AS TEXT)
 OR json_extract(NEW.canonical_publication_json,'$.target.targetId') IS NOT NEW.target_id
 OR json_extract(NEW.canonical_publication_json,'$.target.targetRevision') IS NOT CAST(NEW.target_revision AS TEXT)
 OR json_extract(NEW.canonical_publication_json,'$.target.clientAuthorityId') IS NOT NEW.client_authority_id
 OR json_extract(NEW.canonical_publication_json,'$.target.workspaceId') IS NOT NEW.workspace_id
 OR json_extract(NEW.canonical_publication_json,'$.target.rootKind') IS NOT NEW.root_kind
 OR json_extract(NEW.canonical_publication_json,'$.target.rootRecordId') IS NOT NEW.root_record_id
 OR json_extract(NEW.canonical_publication_json,'$.snapshot.snapshotId') IS NOT NEW.snapshot_id
 OR json_extract(NEW.canonical_publication_json,'$.snapshot.checkpointId') IS NOT NEW.checkpoint_id
 OR json_extract(NEW.canonical_publication_json,'$.snapshot.sourceSequence') IS NOT CAST(NEW.source_sequence AS TEXT)
 OR json_type(NEW.canonical_publication_json,'$.snapshot.complete') IS NOT 'true'
 OR json_extract(NEW.canonical_publication_json,'$.snapshot.complete') IS NOT 1
 OR json_extract(NEW.canonical_publication_json,'$.snapshot.snapshotSha256') IS NOT NEW.snapshot_sha256
 OR json_array_length(json_extract(NEW.canonical_publication_json,'$.snapshot.recipientAuthorityHeads')) IS NOT 0
 OR json_array_length(json_extract(NEW.canonical_publication_json,'$.snapshot.deliveryAuthorityHeads')) IS NOT 0
 OR json_extract(NEW.canonical_publication_json,'$.actorProof.staffId') IS NOT NEW.authorized_by_staff_id
 OR json_extract(NEW.canonical_publication_json,'$.actorProof.verifiedAccessSubject') IS NOT NEW.authorized_access_subject
 OR json_extract(NEW.canonical_publication_json,'$.actorProof.admissionVersion') IS NOT CAST(NEW.authorized_admission_version AS TEXT)
 OR json_extract(NEW.canonical_publication_json,'$.actorProof.profileVersion') IS NOT CAST(NEW.authorized_profile_version AS TEXT)
 OR json_extract(NEW.canonical_publication_json,'$.actorProof.grantGeneration') IS NOT CAST(NEW.authorized_grant_generation AS TEXT)
 OR json_extract(NEW.canonical_publication_json,'$.actorProof.verifiedUntil') IS NOT NEW.authorized_verified_until
 OR json_extract(NEW.canonical_publication_json,'$.observedAt') IS NOT NEW.observed_at
 OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_snapshots snapshot
    JOIN operations_portal_workspace_publication_checkpoints checkpoint ON checkpoint.checkpoint_id=snapshot.checkpoint_id
    WHERE snapshot.snapshot_id=NEW.snapshot_id AND snapshot.checkpoint_id=NEW.checkpoint_id
      AND snapshot.target_id=NEW.target_id AND snapshot.source_sequence=NEW.source_sequence
      AND snapshot.snapshot_sha256=NEW.snapshot_sha256
      AND snapshot.snapshot_json=json_extract(NEW.canonical_publication_json,'$.snapshot')
      AND checkpoint.observed_at=NEW.observed_at)
BEGIN SELECT RAISE(ABORT,'publication canonical document is inconsistent'); END;

CREATE TRIGGER operations_portal_workspace_publication_snapshot_guard BEFORE INSERT
ON operations_portal_workspace_publication_snapshots
WHEN json_type(NEW.snapshot_json) IS NOT 'object'
 OR (SELECT count(*) FROM json_each(NEW.snapshot_json))<>11
 OR EXISTS(SELECT 1 FROM json_each(NEW.snapshot_json) member WHERE member.key NOT IN
    ('snapshotId','checkpointId','sourceSequence','complete','counts','snapshotSha256','directoryRecords','projects',
      'folderReservations','recipientAuthorityHeads','deliveryAuthorityHeads'))
 OR json_type(NEW.snapshot_json,'$.counts') IS NOT 'object'
 OR (SELECT count(*) FROM json_each(NEW.snapshot_json,'$.counts'))<>5
 OR EXISTS(SELECT 1 FROM json_each(NEW.snapshot_json,'$.counts') member WHERE member.key NOT IN
    ('directoryRecords','projects','folderReservations','recipientAuthorityHeads','deliveryAuthorityHeads'))
 OR json_type(NEW.snapshot_json,'$.complete') IS NOT 'true'
 OR json_type(NEW.snapshot_json,'$.counts.directoryRecords') IS NOT 'integer'
 OR json_type(NEW.snapshot_json,'$.counts.projects') IS NOT 'integer'
 OR json_type(NEW.snapshot_json,'$.counts.folderReservations') IS NOT 'integer'
 OR json_type(NEW.snapshot_json,'$.counts.recipientAuthorityHeads') IS NOT 'integer'
 OR json_type(NEW.snapshot_json,'$.counts.deliveryAuthorityHeads') IS NOT 'integer'
 OR json_type(NEW.snapshot_json,'$.directoryRecords') IS NOT 'array'
 OR json_type(NEW.snapshot_json,'$.projects') IS NOT 'array'
 OR json_type(NEW.snapshot_json,'$.folderReservations') IS NOT 'array'
 OR json_type(NEW.snapshot_json,'$.recipientAuthorityHeads') IS NOT 'array'
 OR json_type(NEW.snapshot_json,'$.deliveryAuthorityHeads') IS NOT 'array'
 OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_checkpoints checkpoint
  WHERE checkpoint.checkpoint_id=NEW.checkpoint_id AND checkpoint.target_id=NEW.target_id
    AND json_extract(NEW.snapshot_json,'$.snapshotId') IS NEW.snapshot_id
    AND json_extract(NEW.snapshot_json,'$.checkpointId') IS NEW.checkpoint_id
    AND json_extract(NEW.snapshot_json,'$.sourceSequence') IS CAST(NEW.source_sequence AS TEXT)
    AND json_extract(NEW.snapshot_json,'$.complete')=1
    AND json_extract(NEW.snapshot_json,'$.snapshotSha256') IS NEW.snapshot_sha256
    AND json_extract(NEW.snapshot_json,'$.counts.directoryRecords')=checkpoint.directory_record_count
    AND json_extract(NEW.snapshot_json,'$.counts.projects')=checkpoint.project_count
    AND json_extract(NEW.snapshot_json,'$.counts.folderReservations')=checkpoint.folder_reservation_count
    AND json_extract(NEW.snapshot_json,'$.counts.recipientAuthorityHeads')=0
    AND json_extract(NEW.snapshot_json,'$.counts.deliveryAuthorityHeads')=0
    AND json_array_length(json_extract(NEW.snapshot_json,'$.directoryRecords'))=checkpoint.directory_record_count
    AND json_array_length(json_extract(NEW.snapshot_json,'$.projects'))=checkpoint.project_count
    AND json_array_length(json_extract(NEW.snapshot_json,'$.folderReservations'))=checkpoint.folder_reservation_count
    AND (SELECT count(DISTINCT json_extract(value,'$.recordId'))
      FROM json_each(NEW.snapshot_json,'$.directoryRecords'))=checkpoint.directory_record_count
    AND (SELECT count(DISTINCT json_extract(value,'$.externalProjectId'))
      FROM json_each(NEW.snapshot_json,'$.projects'))=checkpoint.project_count
    AND (SELECT count(DISTINCT json_extract(value,'$.reservationId'))
      FROM json_each(NEW.snapshot_json,'$.folderReservations'))=checkpoint.folder_reservation_count
    AND json_array_length(json_extract(NEW.snapshot_json,'$.recipientAuthorityHeads'))=0
    AND json_array_length(json_extract(NEW.snapshot_json,'$.deliveryAuthorityHeads'))=0)
 OR EXISTS(SELECT 1 FROM json_each(NEW.snapshot_json,'$.directoryRecords') value
    WHERE json_type(value.value) IS NOT 'object' OR (SELECT count(*) FROM json_each(value.value))<>7
      OR EXISTS(SELECT 1 FROM json_each(value.value) member WHERE member.key NOT IN
        ('recordId','kind','version','parentRecordId','relationshipVersion','displayName','externalFences'))
      OR json_type(value.value,'$.recordId') IS NOT 'text'
      OR json_type(value.value,'$.kind') IS NOT 'text'
      OR json_type(value.value,'$.version') IS NOT 'text'
      OR (json_type(value.value,'$.parentRecordId') IS NOT 'null'
        AND json_type(value.value,'$.parentRecordId') IS NOT 'text')
      OR (json_type(value.value,'$.relationshipVersion') IS NOT 'null'
        AND json_type(value.value,'$.relationshipVersion') IS NOT 'text')
      OR json_type(value.value,'$.displayName') IS NOT 'text'
      OR json_type(value.value,'$.externalFences') IS NOT 'array'
      OR json_array_length(json_extract(value.value,'$.externalFences')) IS NOT 0
      OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_directory_sources source
      WHERE source.checkpoint_id=NEW.checkpoint_id AND source.record_id=json_extract(value.value,'$.recordId')
        AND source.record_kind=json_extract(value.value,'$.kind')
        AND json_extract(value.value,'$.version') IS CAST(source.record_version AS TEXT)
        AND source.parent_record_id IS json_extract(value.value,'$.parentRecordId')
        AND ((source.relationship_version IS NULL AND json_type(value.value,'$.relationshipVersion')='null')
          OR (source.relationship_version IS NOT NULL
            AND json_extract(value.value,'$.relationshipVersion') IS CAST(source.relationship_version AS TEXT)))
        AND source.display_name=json_extract(value.value,'$.displayName')
        AND json_array_length(json_extract(value.value,'$.externalFences'))=0))
 OR EXISTS(SELECT 1 FROM json_each(NEW.snapshot_json,'$.projects') value
    WHERE json_type(value.value) IS NOT 'object' OR (SELECT count(*) FROM json_each(value.value))<>14
      OR EXISTS(SELECT 1 FROM json_each(value.value) member WHERE member.key NOT IN
        ('externalProjectId','version','name','lifecycle','plannedStart','plannedEnd','completedAt','archived','archivedAt',
          'overdueWarning','published','organizationRecordId','clientRecordId','externalFence'))
      OR json_type(value.value,'$.externalProjectId') IS NOT 'text'
      OR json_type(value.value,'$.version') IS NOT 'text'
      OR json_type(value.value,'$.name') IS NOT 'text'
      OR json_type(value.value,'$.lifecycle') IS NOT 'text'
      OR (json_type(value.value,'$.plannedStart') IS NOT 'null' AND json_type(value.value,'$.plannedStart') IS NOT 'text')
      OR (json_type(value.value,'$.plannedEnd') IS NOT 'null' AND json_type(value.value,'$.plannedEnd') IS NOT 'text')
      OR (json_type(value.value,'$.completedAt') IS NOT 'null' AND json_type(value.value,'$.completedAt') IS NOT 'text')
      OR (json_type(value.value,'$.archived') IS NOT 'true' AND json_type(value.value,'$.archived') IS NOT 'false')
      OR (json_type(value.value,'$.archivedAt') IS NOT 'null' AND json_type(value.value,'$.archivedAt') IS NOT 'text')
      OR (json_type(value.value,'$.overdueWarning') IS NOT 'true'
        AND json_type(value.value,'$.overdueWarning') IS NOT 'false')
      OR (json_type(value.value,'$.published') IS NOT 'true' AND json_type(value.value,'$.published') IS NOT 'false')
      OR (json_type(value.value,'$.organizationRecordId') IS NOT 'null'
        AND json_type(value.value,'$.organizationRecordId') IS NOT 'text')
      OR (json_type(value.value,'$.clientRecordId') IS NOT 'null'
        AND json_type(value.value,'$.clientRecordId') IS NOT 'text')
      OR json_type(value.value,'$.externalFence') IS NOT 'null'
      OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_project_sources source
      WHERE source.checkpoint_id=NEW.checkpoint_id AND source.external_project_id=json_extract(value.value,'$.externalProjectId')
        AND json_extract(value.value,'$.version') IS CAST(source.project_version AS TEXT)
        AND source.name=json_extract(value.value,'$.name') AND source.lifecycle=json_extract(value.value,'$.lifecycle')
        AND source.planned_start IS json_extract(value.value,'$.plannedStart')
        AND source.planned_end IS json_extract(value.value,'$.plannedEnd')
        AND source.completed_at IS json_extract(value.value,'$.completedAt')
        AND source.archived=(json_extract(value.value,'$.archived') IS 1)
        AND source.archived_at IS json_extract(value.value,'$.archivedAt')
        AND source.overdue_warning=(json_extract(value.value,'$.overdueWarning') IS 1)
        AND source.published=(json_extract(value.value,'$.published') IS 1)
        AND source.organization_record_id IS json_extract(value.value,'$.organizationRecordId')
        AND source.client_record_id IS json_extract(value.value,'$.clientRecordId')
        AND json_type(value.value,'$.externalFence')='null'))
 OR EXISTS(SELECT 1 FROM json_each(NEW.snapshot_json,'$.folderReservations') value
    WHERE json_type(value.value) IS NOT 'object' OR (SELECT count(*) FROM json_each(value.value))<>8
      OR EXISTS(SELECT 1 FROM json_each(value.value) member WHERE member.key NOT IN
        ('reservationId','externalProjectId','opsFolderProjectId','divisionId','clientFolderBindingId','bindingVersion',
          'r2Prefix','state'))
      OR json_type(value.value,'$.reservationId') IS NOT 'text'
      OR json_type(value.value,'$.externalProjectId') IS NOT 'text'
      OR json_type(value.value,'$.opsFolderProjectId') IS NOT 'text'
      OR json_type(value.value,'$.divisionId') IS NOT 'text'
      OR json_type(value.value,'$.clientFolderBindingId') IS NOT 'text'
      OR json_type(value.value,'$.bindingVersion') IS NOT 'text'
      OR json_type(value.value,'$.r2Prefix') IS NOT 'text'
      OR json_type(value.value,'$.state') IS NOT 'text'
      OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_folder_sources source
      WHERE source.checkpoint_id=NEW.checkpoint_id AND source.reservation_id=json_extract(value.value,'$.reservationId')
        AND source.external_project_id=json_extract(value.value,'$.externalProjectId')
        AND source.ops_folder_project_id=json_extract(value.value,'$.opsFolderProjectId')
        AND source.division_id=json_extract(value.value,'$.divisionId')
        AND source.client_folder_binding_id=json_extract(value.value,'$.clientFolderBindingId')
        AND json_extract(value.value,'$.bindingVersion') IS CAST(source.binding_version AS TEXT)
        AND source.r2_prefix=json_extract(value.value,'$.r2Prefix') AND json_extract(value.value,'$.state')='active'))
BEGIN SELECT RAISE(ABORT,'publication snapshot is not the exact normalized checkpoint'); END;

CREATE TRIGGER operations_portal_workspace_publication_outbox_insert_guard BEFORE INSERT
ON operations_portal_workspace_publication_outbox
WHEN NEW.state<>'pending' OR NEW.attempt_count<>0 OR NEW.remote_attempted<>0
 OR NEW.claim_token IS NOT NULL OR NEW.claim_until IS NOT NULL
 OR NEW.acknowledged_claim_token IS NOT NULL OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_commands command
    JOIN operations_portal_workspace_publication_audit audit ON audit.operation_id=command.operation_id
    WHERE command.operation_id=NEW.operation_id AND command.target_id=NEW.target_id AND command.checkpoint_id=NEW.checkpoint_id)
BEGIN SELECT RAISE(ABORT,'publication outbox requires exact audited command'); END;

CREATE TRIGGER operations_portal_workspace_publication_outbox_transition_guard BEFORE UPDATE OF state
ON operations_portal_workspace_publication_outbox
WHEN NOT ((OLD.state IN ('pending','retry') AND NEW.state='dispatching'
      AND OLD.next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND (OLD.remote_attempted=1 OR (EXISTS(SELECT 1 FROM operations_portal_workspace_publication_current_checkpoints current
        WHERE current.checkpoint_id=OLD.checkpoint_id)
        AND EXISTS(SELECT 1 FROM operations_portal_workspace_publication_live_commands live
          WHERE live.operation_id=OLD.operation_id))))
  OR (OLD.state='dispatching' AND NEW.state='dispatching' AND OLD.claim_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  OR (OLD.state='dispatching' AND NEW.state IN ('retry','acknowledged'))
  OR (OLD.state='dispatching' AND OLD.remote_attempted=0 AND NEW.state='dead')
  OR (OLD.state='dispatching' AND OLD.remote_attempted=0 AND NEW.state='superseded'
      AND ((NEW.last_error_code='source-drift'
          AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_current_checkpoints current
            WHERE current.checkpoint_id=OLD.checkpoint_id))
        OR (NEW.last_error_code='authority-not-current'
          AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_live_commands live
            WHERE live.operation_id=OLD.operation_id))))
  OR (OLD.state IN ('pending','retry') AND OLD.remote_attempted=0 AND NEW.state='superseded'
      AND ((NEW.last_error_code='source-drift'
          AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_current_checkpoints current
            WHERE current.checkpoint_id=OLD.checkpoint_id))
        OR (NEW.last_error_code='authority-not-current'
          AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_live_commands live
            WHERE live.operation_id=OLD.operation_id)))))
BEGIN SELECT RAISE(ABORT,'publication outbox transition denied'); END;

CREATE TRIGGER operations_portal_workspace_publication_remote_attempt_guard
BEFORE UPDATE OF remote_attempted ON operations_portal_workspace_publication_outbox
WHEN NOT (OLD.remote_attempted=0 AND NEW.remote_attempted=1 AND OLD.state='dispatching' AND NEW.state='dispatching'
    AND OLD.claim_token IS NOT NULL AND NEW.claim_token IS OLD.claim_token
    AND EXISTS(SELECT 1 FROM operations_portal_workspace_publication_current_checkpoints current
      WHERE current.checkpoint_id=OLD.checkpoint_id)
    AND EXISTS(SELECT 1 FROM operations_portal_workspace_publication_live_commands live
      WHERE live.operation_id=OLD.operation_id))
BEGIN SELECT RAISE(ABORT,'publication remote-attempt marker is invalid'); END;

CREATE TRIGGER operations_portal_workspace_publication_outbox_command_immutable BEFORE UPDATE
ON operations_portal_workspace_publication_outbox
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.target_id IS NOT OLD.target_id OR NEW.checkpoint_id IS NOT OLD.checkpoint_id
BEGIN SELECT RAISE(ABORT,'publication outbox command is immutable'); END;

CREATE TRIGGER operations_portal_workspace_publication_receipt_guard BEFORE INSERT
ON operations_portal_workspace_publication_receipts
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_outbox outbox
  JOIN operations_portal_workspace_publication_commands command ON command.operation_id=outbox.operation_id
  WHERE outbox.operation_id=NEW.operation_id AND outbox.state='dispatching' AND outbox.remote_attempted=1
    AND outbox.claim_token=NEW.acknowledged_claim_token
    AND command.publication_id=NEW.publication_id AND command.operation_fingerprint=NEW.operation_fingerprint
    AND command.target_id=NEW.target_id AND command.resulting_revision=NEW.resulting_revision
    AND command.source_sequence=NEW.source_sequence AND command.snapshot_id=NEW.snapshot_id
    AND command.snapshot_sha256=NEW.snapshot_sha256)
BEGIN SELECT RAISE(ABORT,'publication receipt is not exact'); END;

CREATE TRIGGER operations_portal_workspace_publication_head_insert_guard BEFORE INSERT
ON operations_portal_workspace_publication_heads
WHEN NEW.publication_revision<>1 OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_receipts receipt
  JOIN operations_portal_workspace_publication_commands command ON command.operation_id=receipt.operation_id
  WHERE receipt.operation_id=NEW.latest_operation_id AND receipt.target_id=NEW.target_id
    AND receipt.resulting_revision=NEW.publication_revision AND receipt.source_sequence=NEW.source_sequence
    AND receipt.snapshot_id=NEW.snapshot_id AND receipt.snapshot_sha256=NEW.snapshot_sha256
    AND command.target_revision=NEW.target_revision AND command.client_authority_id=NEW.client_authority_id
    AND command.workspace_id=NEW.workspace_id AND command.root_kind=NEW.root_kind
    AND command.root_record_id=NEW.root_record_id AND command.checkpoint_id=NEW.checkpoint_id)
BEGIN SELECT RAISE(ABORT,'initial publication head is not exact'); END;

CREATE TRIGGER operations_portal_workspace_publication_head_update_guard BEFORE UPDATE
ON operations_portal_workspace_publication_heads
WHEN NEW.target_id IS NOT OLD.target_id OR NEW.publication_revision<>OLD.publication_revision+1
 OR NEW.target_revision<>OLD.target_revision OR NEW.client_authority_id IS NOT OLD.client_authority_id
 OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.root_kind IS NOT OLD.root_kind OR NEW.root_record_id IS NOT OLD.root_record_id
 OR NEW.source_sequence<>OLD.source_sequence+1 OR NEW.snapshot_id IS OLD.snapshot_id
 OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_receipts receipt
    JOIN operations_portal_workspace_publication_commands command ON command.operation_id=receipt.operation_id
    WHERE receipt.operation_id=NEW.latest_operation_id AND receipt.target_id=NEW.target_id
      AND receipt.resulting_revision=NEW.publication_revision AND receipt.source_sequence=NEW.source_sequence
      AND receipt.snapshot_id=NEW.snapshot_id AND receipt.snapshot_sha256=NEW.snapshot_sha256
      AND command.expected_revision=OLD.publication_revision AND command.target_revision=NEW.target_revision
      AND command.checkpoint_id=NEW.checkpoint_id)
BEGIN SELECT RAISE(ABORT,'publication head transition is not exact'); END;

CREATE TRIGGER operations_portal_workspace_publication_ack_guard BEFORE UPDATE OF state
ON operations_portal_workspace_publication_outbox
WHEN NEW.state='acknowledged' AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_receipts receipt
  JOIN operations_portal_workspace_publication_heads head ON head.latest_operation_id=receipt.operation_id
  WHERE receipt.operation_id=OLD.operation_id AND receipt.acknowledged_claim_token=OLD.claim_token
    AND NEW.acknowledged_claim_token=OLD.claim_token AND head.target_id=OLD.target_id)
BEGIN SELECT RAISE(ABORT,'publication acknowledgement requires exact receipt and head'); END;
