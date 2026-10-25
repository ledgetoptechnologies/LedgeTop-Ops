PRAGMA foreign_keys = ON;

-- Expand-only native-project assignment provenance. Existing v1/v2 proofs and
-- all historical rows remain byte-for-byte unchanged. Native projects have no
-- local Ops project ID: keep that fact explicit instead of forging a local ID
-- or weakening0179's legacy-project contract. This column is audit provenance;
-- current request/read/assignment guards still authorize every mutation.
-- The bounded backport may apply0239 directly after0234; unrelated0235-0238
-- Windows/Viewer migrations are not prerequisites for either added column.
-- NULL remains writable by old/general/legacy writers. An existing native v3
-- row cannot acquire a conflicting legacy proof during a rollback writer.

ALTER TABLE client_service_request_drafts
  ADD COLUMN native_project_assignment_proof_v3_json TEXT
  CHECK (native_project_assignment_proof_v3_json IS NULL
    OR coalesce(
    (((((service_assignment_policy_json IS NULL
              AND service_assignment_policy_v2_json IS NULL)
            AND (project_id IS NULL
              AND portal_workspace_id IS NOT NULL))
          AND ((portal_identity_id IS NOT NULL
              AND portal_project_public_id IS NOT NULL)
            AND (json_valid(native_project_assignment_proof_v3_json)
              AND json_type(native_project_assignment_proof_v3_json)='object')))
        AND (((json(native_project_assignment_proof_v3_json)=json(json_object('version',json_extract(native_project_assignment_proof_v3_json,'$.version'),
                  'sourceId',json_extract(native_project_assignment_proof_v3_json,'$.sourceId'),
                  'reviewId',json_extract(native_project_assignment_proof_v3_json,'$.reviewId'),
                  'reviewRevision',json_extract(native_project_assignment_proof_v3_json,'$.reviewRevision'),
                  'workspaceId',json_extract(native_project_assignment_proof_v3_json,'$.workspaceId'),
                  'localProjectId',json_extract(native_project_assignment_proof_v3_json,'$.localProjectId'),
                  'nativeProject',json('true'),
                  'subjectType',json_extract(native_project_assignment_proof_v3_json,'$.subjectType'),
                  'subjectPublicId',json_extract(native_project_assignment_proof_v3_json,'$.subjectPublicId'),
                  'generationId',json_extract(native_project_assignment_proof_v3_json,'$.generationId'),
                  'sourceGeneration',json_extract(native_project_assignment_proof_v3_json,'$.sourceGeneration'),
                  'sourceSequence',json_extract(native_project_assignment_proof_v3_json,'$.sourceSequence'),
                  'directoryGenerationId',json_extract(native_project_assignment_proof_v3_json,'$.directoryGenerationId'),
                  'directorySourceSequence',json_extract(native_project_assignment_proof_v3_json,'$.directorySourceSequence'),
                  'evaluatedAt',json_extract(native_project_assignment_proof_v3_json,'$.evaluatedAt'),
                  'expiresAt',json_extract(native_project_assignment_proof_v3_json,'$.expiresAt')))
              AND json_type(native_project_assignment_proof_v3_json,'$.version')='integer'
              AND json_extract(native_project_assignment_proof_v3_json,'$.version')=3)
            AND (json_type(native_project_assignment_proof_v3_json,'$.nativeProject')='true'
              AND json_type(native_project_assignment_proof_v3_json,'$.localProjectId')='null'))
          AND ((json_type(native_project_assignment_proof_v3_json,'$.subjectType')='text'
              AND json_extract(native_project_assignment_proof_v3_json,'$.subjectType')='project'
              AND json_extract(native_project_assignment_proof_v3_json,'$.sourceId')=catalog_source_id)
            AND (json_extract(native_project_assignment_proof_v3_json,'$.workspaceId')=portal_workspace_id
              AND (json_extract(native_project_assignment_proof_v3_json,'$.subjectPublicId')=portal_project_public_id
                AND (json_type(native_project_assignment_proof_v3_json,'$.sourceId')='text'
                  AND length(json_extract(native_project_assignment_proof_v3_json,'$.sourceId')) BETWEEN 1 AND 78
                  AND instr(json_extract(native_project_assignment_proof_v3_json,'$.sourceId'),char(0))=0))))))
      AND (((((json_type(native_project_assignment_proof_v3_json,'$.reviewId')='text'
                AND length(json_extract(native_project_assignment_proof_v3_json,'$.reviewId')) BETWEEN 1 AND 128
                AND instr(json_extract(native_project_assignment_proof_v3_json,'$.reviewId'),char(0))=0)
              AND (json_type(native_project_assignment_proof_v3_json,'$.workspaceId')='text'
                AND length(json_extract(native_project_assignment_proof_v3_json,'$.workspaceId')) BETWEEN 1 AND 128
                AND instr(json_extract(native_project_assignment_proof_v3_json,'$.workspaceId'),char(0))=0))
            AND ((json_type(native_project_assignment_proof_v3_json,'$.subjectPublicId')='text'
                AND length(json_extract(native_project_assignment_proof_v3_json,'$.subjectPublicId')) BETWEEN 1 AND 128
                AND instr(json_extract(native_project_assignment_proof_v3_json,'$.subjectPublicId'),char(0))=0)
              AND (json_type(native_project_assignment_proof_v3_json,'$.generationId')='text'
                AND length(json_extract(native_project_assignment_proof_v3_json,'$.generationId')) BETWEEN 1 AND 128
                AND instr(json_extract(native_project_assignment_proof_v3_json,'$.generationId'),char(0))=0)))
          AND (((json_type(native_project_assignment_proof_v3_json,'$.sourceGeneration')='text'
                AND length(json_extract(native_project_assignment_proof_v3_json,'$.sourceGeneration')) BETWEEN 1 AND 128
                AND instr(json_extract(native_project_assignment_proof_v3_json,'$.sourceGeneration'),char(0))=0)
              AND (json_type(native_project_assignment_proof_v3_json,'$.directoryGenerationId')='text'
                AND length(json_extract(native_project_assignment_proof_v3_json,'$.directoryGenerationId')) BETWEEN 1 AND 128
                AND instr(json_extract(native_project_assignment_proof_v3_json,'$.directoryGenerationId'),char(0))=0))
            AND (length(json_extract(native_project_assignment_proof_v3_json,'$.sourceId'))>=15
              AND substr(json_extract(native_project_assignment_proof_v3_json,'$.sourceId'),1,14)='project-alpha:')))
        AND (((substr(json_extract(native_project_assignment_proof_v3_json,'$.sourceId'),15,1) GLOB '[a-z0-9]'
              AND substr(json_extract(native_project_assignment_proof_v3_json,'$.sourceId'),15) NOT GLOB '*[^a-z0-9_-]*')
            AND ((json_type(native_project_assignment_proof_v3_json,'$.reviewRevision')='integer'
                AND json_extract(native_project_assignment_proof_v3_json,'$.reviewRevision') BETWEEN 1 AND 9007199254740991)
              AND (json_type(native_project_assignment_proof_v3_json,'$.sourceSequence')='integer'
                AND json_extract(native_project_assignment_proof_v3_json,'$.sourceSequence') BETWEEN 1 AND 9007199254740991)))
          AND (((json_type(native_project_assignment_proof_v3_json,'$.directorySourceSequence')='integer'
                AND json_extract(native_project_assignment_proof_v3_json,'$.directorySourceSequence') BETWEEN 1 AND 9007199254740991)
              AND (json_type(native_project_assignment_proof_v3_json,'$.evaluatedAt')='text'
                AND datetime(json_extract(native_project_assignment_proof_v3_json,'$.evaluatedAt')) IS NOT NULL))
            AND ((json_type(native_project_assignment_proof_v3_json,'$.expiresAt')='text'
                AND datetime(json_extract(native_project_assignment_proof_v3_json,'$.expiresAt')) IS NOT NULL)
              AND (datetime(json_extract(native_project_assignment_proof_v3_json,'$.expiresAt'))>datetime(json_extract(native_project_assignment_proof_v3_json,'$.evaluatedAt'))
                AND datetime(json_extract(native_project_assignment_proof_v3_json,'$.expiresAt'))<=datetime(json_extract(native_project_assignment_proof_v3_json,'$.evaluatedAt'),'+5 minutes'))))))),0)=1);

ALTER TABLE client_service_requests
  ADD COLUMN native_project_assignment_proof_v3_json TEXT
  CHECK (native_project_assignment_proof_v3_json IS NULL
    OR coalesce(
    (((((service_assignment_policy_json IS NULL
              AND service_assignment_policy_v2_json IS NULL)
            AND (project_id IS NULL
              AND portal_workspace_id IS NOT NULL))
          AND ((portal_identity_id IS NOT NULL
              AND portal_project_public_id IS NOT NULL)
            AND (json_valid(native_project_assignment_proof_v3_json)
              AND json_type(native_project_assignment_proof_v3_json)='object')))
        AND (((json(native_project_assignment_proof_v3_json)=json(json_object('version',json_extract(native_project_assignment_proof_v3_json,'$.version'),
                  'sourceId',json_extract(native_project_assignment_proof_v3_json,'$.sourceId'),
                  'reviewId',json_extract(native_project_assignment_proof_v3_json,'$.reviewId'),
                  'reviewRevision',json_extract(native_project_assignment_proof_v3_json,'$.reviewRevision'),
                  'workspaceId',json_extract(native_project_assignment_proof_v3_json,'$.workspaceId'),
                  'localProjectId',json_extract(native_project_assignment_proof_v3_json,'$.localProjectId'),
                  'nativeProject',json('true'),
                  'subjectType',json_extract(native_project_assignment_proof_v3_json,'$.subjectType'),
                  'subjectPublicId',json_extract(native_project_assignment_proof_v3_json,'$.subjectPublicId'),
                  'generationId',json_extract(native_project_assignment_proof_v3_json,'$.generationId'),
                  'sourceGeneration',json_extract(native_project_assignment_proof_v3_json,'$.sourceGeneration'),
                  'sourceSequence',json_extract(native_project_assignment_proof_v3_json,'$.sourceSequence'),
                  'directoryGenerationId',json_extract(native_project_assignment_proof_v3_json,'$.directoryGenerationId'),
                  'directorySourceSequence',json_extract(native_project_assignment_proof_v3_json,'$.directorySourceSequence'),
                  'evaluatedAt',json_extract(native_project_assignment_proof_v3_json,'$.evaluatedAt'),
                  'expiresAt',json_extract(native_project_assignment_proof_v3_json,'$.expiresAt')))
              AND json_type(native_project_assignment_proof_v3_json,'$.version')='integer'
              AND json_extract(native_project_assignment_proof_v3_json,'$.version')=3)
            AND (json_type(native_project_assignment_proof_v3_json,'$.nativeProject')='true'
              AND json_type(native_project_assignment_proof_v3_json,'$.localProjectId')='null'))
          AND ((json_type(native_project_assignment_proof_v3_json,'$.subjectType')='text'
              AND json_extract(native_project_assignment_proof_v3_json,'$.subjectType')='project'
              AND json_extract(native_project_assignment_proof_v3_json,'$.sourceId')=catalog_source_id)
            AND (json_extract(native_project_assignment_proof_v3_json,'$.workspaceId')=portal_workspace_id
              AND (json_extract(native_project_assignment_proof_v3_json,'$.subjectPublicId')=portal_project_public_id
                AND (json_type(native_project_assignment_proof_v3_json,'$.sourceId')='text'
                  AND length(json_extract(native_project_assignment_proof_v3_json,'$.sourceId')) BETWEEN 1 AND 78
                  AND instr(json_extract(native_project_assignment_proof_v3_json,'$.sourceId'),char(0))=0))))))
      AND (((((json_type(native_project_assignment_proof_v3_json,'$.reviewId')='text'
                AND length(json_extract(native_project_assignment_proof_v3_json,'$.reviewId')) BETWEEN 1 AND 128
                AND instr(json_extract(native_project_assignment_proof_v3_json,'$.reviewId'),char(0))=0)
              AND (json_type(native_project_assignment_proof_v3_json,'$.workspaceId')='text'
                AND length(json_extract(native_project_assignment_proof_v3_json,'$.workspaceId')) BETWEEN 1 AND 128
                AND instr(json_extract(native_project_assignment_proof_v3_json,'$.workspaceId'),char(0))=0))
            AND ((json_type(native_project_assignment_proof_v3_json,'$.subjectPublicId')='text'
                AND length(json_extract(native_project_assignment_proof_v3_json,'$.subjectPublicId')) BETWEEN 1 AND 128
                AND instr(json_extract(native_project_assignment_proof_v3_json,'$.subjectPublicId'),char(0))=0)
              AND (json_type(native_project_assignment_proof_v3_json,'$.generationId')='text'
                AND length(json_extract(native_project_assignment_proof_v3_json,'$.generationId')) BETWEEN 1 AND 128
                AND instr(json_extract(native_project_assignment_proof_v3_json,'$.generationId'),char(0))=0)))
          AND (((json_type(native_project_assignment_proof_v3_json,'$.sourceGeneration')='text'
                AND length(json_extract(native_project_assignment_proof_v3_json,'$.sourceGeneration')) BETWEEN 1 AND 128
                AND instr(json_extract(native_project_assignment_proof_v3_json,'$.sourceGeneration'),char(0))=0)
              AND (json_type(native_project_assignment_proof_v3_json,'$.directoryGenerationId')='text'
                AND length(json_extract(native_project_assignment_proof_v3_json,'$.directoryGenerationId')) BETWEEN 1 AND 128
                AND instr(json_extract(native_project_assignment_proof_v3_json,'$.directoryGenerationId'),char(0))=0))
            AND (length(json_extract(native_project_assignment_proof_v3_json,'$.sourceId'))>=15
              AND substr(json_extract(native_project_assignment_proof_v3_json,'$.sourceId'),1,14)='project-alpha:')))
        AND (((substr(json_extract(native_project_assignment_proof_v3_json,'$.sourceId'),15,1) GLOB '[a-z0-9]'
              AND substr(json_extract(native_project_assignment_proof_v3_json,'$.sourceId'),15) NOT GLOB '*[^a-z0-9_-]*')
            AND ((json_type(native_project_assignment_proof_v3_json,'$.reviewRevision')='integer'
                AND json_extract(native_project_assignment_proof_v3_json,'$.reviewRevision') BETWEEN 1 AND 9007199254740991)
              AND (json_type(native_project_assignment_proof_v3_json,'$.sourceSequence')='integer'
                AND json_extract(native_project_assignment_proof_v3_json,'$.sourceSequence') BETWEEN 1 AND 9007199254740991)))
          AND (((json_type(native_project_assignment_proof_v3_json,'$.directorySourceSequence')='integer'
                AND json_extract(native_project_assignment_proof_v3_json,'$.directorySourceSequence') BETWEEN 1 AND 9007199254740991)
              AND (json_type(native_project_assignment_proof_v3_json,'$.evaluatedAt')='text'
                AND datetime(json_extract(native_project_assignment_proof_v3_json,'$.evaluatedAt')) IS NOT NULL))
            AND ((json_type(native_project_assignment_proof_v3_json,'$.expiresAt')='text'
                AND datetime(json_extract(native_project_assignment_proof_v3_json,'$.expiresAt')) IS NOT NULL)
              AND (datetime(json_extract(native_project_assignment_proof_v3_json,'$.expiresAt'))>datetime(json_extract(native_project_assignment_proof_v3_json,'$.evaluatedAt'))
                AND datetime(json_extract(native_project_assignment_proof_v3_json,'$.expiresAt'))<=datetime(json_extract(native_project_assignment_proof_v3_json,'$.evaluatedAt'),'+5 minutes'))))))),0)=1);
