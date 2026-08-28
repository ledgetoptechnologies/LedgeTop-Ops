PRAGMA foreign_keys = ON;

-- A request keeps the exact source/target/checkpoint policy that was proven at
-- its last mutation. These fields are evidence only: they never create portal,
-- project, file, pricing, or request authority. NULL is the pre-policy/default-
-- off state and preserves compatibility while rollout remains disabled.
ALTER TABLE client_service_request_drafts
  ADD COLUMN service_assignment_policy_json TEXT
  CHECK(service_assignment_policy_json IS NULL OR (
    json_valid(service_assignment_policy_json)
    AND json_type(service_assignment_policy_json)='object'
    AND json(service_assignment_policy_json)=json(json_object(
      'version',json_extract(service_assignment_policy_json,'$.version'),
      'sourceId',json_extract(service_assignment_policy_json,'$.sourceId'),
      'workspaceId',json_extract(service_assignment_policy_json,'$.workspaceId'),
      'localProjectId',json_extract(service_assignment_policy_json,'$.localProjectId'),
      'subjectType',json_extract(service_assignment_policy_json,'$.subjectType'),
      'subjectPublicId',json_extract(service_assignment_policy_json,'$.subjectPublicId'),
      'generationId',json_extract(service_assignment_policy_json,'$.generationId'),
      'sourceGeneration',json_extract(service_assignment_policy_json,'$.sourceGeneration'),
      'sourceSequence',json_extract(service_assignment_policy_json,'$.sourceSequence'),
      'directoryGenerationId',json_extract(service_assignment_policy_json,'$.directoryGenerationId'),
      'directorySourceSequence',json_extract(service_assignment_policy_json,'$.directorySourceSequence'),
      'evaluatedAt',json_extract(service_assignment_policy_json,'$.evaluatedAt'),
      'expiresAt',json_extract(service_assignment_policy_json,'$.expiresAt')))
    AND json_type(service_assignment_policy_json,'$.version')='integer'
    AND json_extract(service_assignment_policy_json,'$.version')=1
    AND json_extract(service_assignment_policy_json,'$.sourceId')='project-alpha:primary'
    AND json_type(service_assignment_policy_json,'$.sourceId')='text'
    AND ((json_extract(service_assignment_policy_json,'$.subjectType')='project'
      AND json_type(service_assignment_policy_json,'$.localProjectId')='text'
      AND length(json_extract(service_assignment_policy_json,'$.localProjectId')) BETWEEN 1 AND 128)
      OR (json_extract(service_assignment_policy_json,'$.subjectType') IN ('organization','standalone_client')
        AND json_type(service_assignment_policy_json,'$.localProjectId')='null'))
    AND length(json_extract(service_assignment_policy_json,'$.workspaceId')) BETWEEN 1 AND 128
    AND json_type(service_assignment_policy_json,'$.workspaceId')='text'
    AND json_extract(service_assignment_policy_json,'$.subjectType') IN ('organization','standalone_client','project')
    AND json_type(service_assignment_policy_json,'$.subjectType')='text'
    AND length(json_extract(service_assignment_policy_json,'$.subjectPublicId')) BETWEEN 1 AND 128
    AND json_type(service_assignment_policy_json,'$.subjectPublicId')='text'
    AND length(json_extract(service_assignment_policy_json,'$.generationId')) BETWEEN 1 AND 128
    AND json_type(service_assignment_policy_json,'$.generationId')='text'
    AND length(json_extract(service_assignment_policy_json,'$.sourceGeneration')) BETWEEN 1 AND 128
    AND json_type(service_assignment_policy_json,'$.sourceGeneration')='text'
    AND json_extract(service_assignment_policy_json,'$.sourceSequence')>=1
    AND length(json_extract(service_assignment_policy_json,'$.directoryGenerationId')) BETWEEN 1 AND 128
    AND json_type(service_assignment_policy_json,'$.directoryGenerationId')='text'
    AND json_extract(service_assignment_policy_json,'$.directorySourceSequence')>=1
    AND json_type(service_assignment_policy_json,'$.sourceSequence')='integer'
    AND json_type(service_assignment_policy_json,'$.directorySourceSequence')='integer'
    AND json_type(service_assignment_policy_json,'$.evaluatedAt')='text'
    AND json_type(service_assignment_policy_json,'$.expiresAt')='text'
    AND datetime(json_extract(service_assignment_policy_json,'$.evaluatedAt')) IS NOT NULL
    AND datetime(json_extract(service_assignment_policy_json,'$.expiresAt')) IS NOT NULL
    AND datetime(json_extract(service_assignment_policy_json,'$.expiresAt'))>datetime(json_extract(service_assignment_policy_json,'$.evaluatedAt'))
    AND datetime(json_extract(service_assignment_policy_json,'$.expiresAt'))<=datetime(json_extract(service_assignment_policy_json,'$.evaluatedAt'),'+5 minutes')
  ));

ALTER TABLE client_service_requests
  ADD COLUMN service_assignment_policy_json TEXT
  CHECK(service_assignment_policy_json IS NULL OR (
    json_valid(service_assignment_policy_json)
    AND json_type(service_assignment_policy_json)='object'
    AND json(service_assignment_policy_json)=json(json_object(
      'version',json_extract(service_assignment_policy_json,'$.version'),
      'sourceId',json_extract(service_assignment_policy_json,'$.sourceId'),
      'workspaceId',json_extract(service_assignment_policy_json,'$.workspaceId'),
      'localProjectId',json_extract(service_assignment_policy_json,'$.localProjectId'),
      'subjectType',json_extract(service_assignment_policy_json,'$.subjectType'),
      'subjectPublicId',json_extract(service_assignment_policy_json,'$.subjectPublicId'),
      'generationId',json_extract(service_assignment_policy_json,'$.generationId'),
      'sourceGeneration',json_extract(service_assignment_policy_json,'$.sourceGeneration'),
      'sourceSequence',json_extract(service_assignment_policy_json,'$.sourceSequence'),
      'directoryGenerationId',json_extract(service_assignment_policy_json,'$.directoryGenerationId'),
      'directorySourceSequence',json_extract(service_assignment_policy_json,'$.directorySourceSequence'),
      'evaluatedAt',json_extract(service_assignment_policy_json,'$.evaluatedAt'),
      'expiresAt',json_extract(service_assignment_policy_json,'$.expiresAt')))
    AND json_type(service_assignment_policy_json,'$.version')='integer'
    AND json_extract(service_assignment_policy_json,'$.version')=1
    AND json_extract(service_assignment_policy_json,'$.sourceId')='project-alpha:primary'
    AND json_type(service_assignment_policy_json,'$.sourceId')='text'
    AND ((json_extract(service_assignment_policy_json,'$.subjectType')='project'
      AND json_type(service_assignment_policy_json,'$.localProjectId')='text'
      AND length(json_extract(service_assignment_policy_json,'$.localProjectId')) BETWEEN 1 AND 128)
      OR (json_extract(service_assignment_policy_json,'$.subjectType') IN ('organization','standalone_client')
        AND json_type(service_assignment_policy_json,'$.localProjectId')='null'))
    AND length(json_extract(service_assignment_policy_json,'$.workspaceId')) BETWEEN 1 AND 128
    AND json_type(service_assignment_policy_json,'$.workspaceId')='text'
    AND json_extract(service_assignment_policy_json,'$.subjectType') IN ('organization','standalone_client','project')
    AND json_type(service_assignment_policy_json,'$.subjectType')='text'
    AND length(json_extract(service_assignment_policy_json,'$.subjectPublicId')) BETWEEN 1 AND 128
    AND json_type(service_assignment_policy_json,'$.subjectPublicId')='text'
    AND length(json_extract(service_assignment_policy_json,'$.generationId')) BETWEEN 1 AND 128
    AND json_type(service_assignment_policy_json,'$.generationId')='text'
    AND length(json_extract(service_assignment_policy_json,'$.sourceGeneration')) BETWEEN 1 AND 128
    AND json_type(service_assignment_policy_json,'$.sourceGeneration')='text'
    AND json_extract(service_assignment_policy_json,'$.sourceSequence')>=1
    AND length(json_extract(service_assignment_policy_json,'$.directoryGenerationId')) BETWEEN 1 AND 128
    AND json_type(service_assignment_policy_json,'$.directoryGenerationId')='text'
    AND json_extract(service_assignment_policy_json,'$.directorySourceSequence')>=1
    AND json_type(service_assignment_policy_json,'$.sourceSequence')='integer'
    AND json_type(service_assignment_policy_json,'$.directorySourceSequence')='integer'
    AND json_type(service_assignment_policy_json,'$.evaluatedAt')='text'
    AND json_type(service_assignment_policy_json,'$.expiresAt')='text'
    AND datetime(json_extract(service_assignment_policy_json,'$.evaluatedAt')) IS NOT NULL
    AND datetime(json_extract(service_assignment_policy_json,'$.expiresAt')) IS NOT NULL
    AND datetime(json_extract(service_assignment_policy_json,'$.expiresAt'))>datetime(json_extract(service_assignment_policy_json,'$.evaluatedAt'))
    AND datetime(json_extract(service_assignment_policy_json,'$.expiresAt'))<=datetime(json_extract(service_assignment_policy_json,'$.evaluatedAt'),'+5 minutes')
  ));

CREATE INDEX idx_pa_service_assignment_request_policy
  ON pa_service_assignments(source_id,service_public_id,service_source_version,subject_type,subject_public_id,
    active,source_generation,source_sequence,effective_from,effective_until);
