PRAGMA foreign_keys = ON;

-- Expand-only proof storage. The v1 column added by 0174 remains readable and
-- writable during the rolling deploy, while new writers persist the exact,
-- source-qualified review provenance in this v2 column. No existing row is
-- rewritten: a v1 proof cannot be promoted because it never recorded review
-- identity or revision.
ALTER TABLE client_service_request_drafts
  ADD COLUMN service_assignment_policy_v2_json TEXT
  CHECK(service_assignment_policy_v2_json IS NULL OR (
    service_assignment_policy_json IS NULL
    AND json_valid(service_assignment_policy_v2_json)
    AND json_type(service_assignment_policy_v2_json)='object'
    AND json(service_assignment_policy_v2_json)=json(json_object(
      'version',json_extract(service_assignment_policy_v2_json,'$.version'),
      'sourceId',json_extract(service_assignment_policy_v2_json,'$.sourceId'),
      'reviewId',json_extract(service_assignment_policy_v2_json,'$.reviewId'),
      'reviewRevision',json_extract(service_assignment_policy_v2_json,'$.reviewRevision'),
      'workspaceId',json_extract(service_assignment_policy_v2_json,'$.workspaceId'),
      'localProjectId',json_extract(service_assignment_policy_v2_json,'$.localProjectId'),
      'subjectType',json_extract(service_assignment_policy_v2_json,'$.subjectType'),
      'subjectPublicId',json_extract(service_assignment_policy_v2_json,'$.subjectPublicId'),
      'generationId',json_extract(service_assignment_policy_v2_json,'$.generationId'),
      'sourceGeneration',json_extract(service_assignment_policy_v2_json,'$.sourceGeneration'),
      'sourceSequence',json_extract(service_assignment_policy_v2_json,'$.sourceSequence'),
      'directoryGenerationId',json_extract(service_assignment_policy_v2_json,'$.directoryGenerationId'),
      'directorySourceSequence',json_extract(service_assignment_policy_v2_json,'$.directorySourceSequence'),
      'evaluatedAt',json_extract(service_assignment_policy_v2_json,'$.evaluatedAt'),
      'expiresAt',json_extract(service_assignment_policy_v2_json,'$.expiresAt')))
    AND json_type(service_assignment_policy_v2_json,'$.version')='integer'
    AND json_extract(service_assignment_policy_v2_json,'$.version')=2
    AND json_type(service_assignment_policy_v2_json,'$.sourceId')='text'
    AND length(json_extract(service_assignment_policy_v2_json,'$.sourceId')) BETWEEN 15 AND 78
    AND substr(json_extract(service_assignment_policy_v2_json,'$.sourceId'),1,14)='project-alpha:'
    AND substr(json_extract(service_assignment_policy_v2_json,'$.sourceId'),15,1) GLOB '[a-z0-9]'
    AND substr(json_extract(service_assignment_policy_v2_json,'$.sourceId'),15) NOT GLOB '*[^a-z0-9_-]*'
    AND instr(json_extract(service_assignment_policy_v2_json,'$.sourceId'),char(0))=0
    AND json_type(service_assignment_policy_v2_json,'$.reviewId')='text'
    AND length(json_extract(service_assignment_policy_v2_json,'$.reviewId')) BETWEEN 1 AND 128
    AND instr(json_extract(service_assignment_policy_v2_json,'$.reviewId'),char(0))=0
    AND json_type(service_assignment_policy_v2_json,'$.reviewRevision')='integer'
    AND json_extract(service_assignment_policy_v2_json,'$.reviewRevision') BETWEEN 1 AND 9007199254740991
    AND ((json_extract(service_assignment_policy_v2_json,'$.subjectType')='project'
      AND json_type(service_assignment_policy_v2_json,'$.localProjectId')='text'
      AND length(json_extract(service_assignment_policy_v2_json,'$.localProjectId')) BETWEEN 1 AND 128)
      OR (json_extract(service_assignment_policy_v2_json,'$.subjectType') IN ('organization','standalone_client')
        AND json_type(service_assignment_policy_v2_json,'$.localProjectId')='null'))
    AND length(json_extract(service_assignment_policy_v2_json,'$.workspaceId')) BETWEEN 1 AND 128
    AND json_type(service_assignment_policy_v2_json,'$.workspaceId')='text'
    AND json_extract(service_assignment_policy_v2_json,'$.subjectType') IN ('organization','standalone_client','project')
    AND json_type(service_assignment_policy_v2_json,'$.subjectType')='text'
    AND length(json_extract(service_assignment_policy_v2_json,'$.subjectPublicId')) BETWEEN 1 AND 128
    AND json_type(service_assignment_policy_v2_json,'$.subjectPublicId')='text'
    AND length(json_extract(service_assignment_policy_v2_json,'$.generationId')) BETWEEN 1 AND 128
    AND json_type(service_assignment_policy_v2_json,'$.generationId')='text'
    AND length(json_extract(service_assignment_policy_v2_json,'$.sourceGeneration')) BETWEEN 1 AND 128
    AND json_type(service_assignment_policy_v2_json,'$.sourceGeneration')='text'
    AND json_type(service_assignment_policy_v2_json,'$.sourceSequence')='integer'
    AND json_extract(service_assignment_policy_v2_json,'$.sourceSequence') BETWEEN 1 AND 9007199254740991
    AND length(json_extract(service_assignment_policy_v2_json,'$.directoryGenerationId')) BETWEEN 1 AND 128
    AND json_type(service_assignment_policy_v2_json,'$.directoryGenerationId')='text'
    AND json_type(service_assignment_policy_v2_json,'$.directorySourceSequence')='integer'
    AND json_extract(service_assignment_policy_v2_json,'$.directorySourceSequence') BETWEEN 1 AND 9007199254740991
    AND json_type(service_assignment_policy_v2_json,'$.evaluatedAt')='text'
    AND json_type(service_assignment_policy_v2_json,'$.expiresAt')='text'
    AND datetime(json_extract(service_assignment_policy_v2_json,'$.evaluatedAt')) IS NOT NULL
    AND datetime(json_extract(service_assignment_policy_v2_json,'$.expiresAt')) IS NOT NULL
    AND datetime(json_extract(service_assignment_policy_v2_json,'$.expiresAt'))>datetime(json_extract(service_assignment_policy_v2_json,'$.evaluatedAt'))
    AND datetime(json_extract(service_assignment_policy_v2_json,'$.expiresAt'))<=datetime(json_extract(service_assignment_policy_v2_json,'$.evaluatedAt'),'+5 minutes')
  ));

ALTER TABLE client_service_requests
  ADD COLUMN service_assignment_policy_v2_json TEXT
  CHECK(service_assignment_policy_v2_json IS NULL OR (
    service_assignment_policy_json IS NULL
    AND json_valid(service_assignment_policy_v2_json)
    AND json_type(service_assignment_policy_v2_json)='object'
    AND json(service_assignment_policy_v2_json)=json(json_object(
      'version',json_extract(service_assignment_policy_v2_json,'$.version'),
      'sourceId',json_extract(service_assignment_policy_v2_json,'$.sourceId'),
      'reviewId',json_extract(service_assignment_policy_v2_json,'$.reviewId'),
      'reviewRevision',json_extract(service_assignment_policy_v2_json,'$.reviewRevision'),
      'workspaceId',json_extract(service_assignment_policy_v2_json,'$.workspaceId'),
      'localProjectId',json_extract(service_assignment_policy_v2_json,'$.localProjectId'),
      'subjectType',json_extract(service_assignment_policy_v2_json,'$.subjectType'),
      'subjectPublicId',json_extract(service_assignment_policy_v2_json,'$.subjectPublicId'),
      'generationId',json_extract(service_assignment_policy_v2_json,'$.generationId'),
      'sourceGeneration',json_extract(service_assignment_policy_v2_json,'$.sourceGeneration'),
      'sourceSequence',json_extract(service_assignment_policy_v2_json,'$.sourceSequence'),
      'directoryGenerationId',json_extract(service_assignment_policy_v2_json,'$.directoryGenerationId'),
      'directorySourceSequence',json_extract(service_assignment_policy_v2_json,'$.directorySourceSequence'),
      'evaluatedAt',json_extract(service_assignment_policy_v2_json,'$.evaluatedAt'),
      'expiresAt',json_extract(service_assignment_policy_v2_json,'$.expiresAt')))
    AND json_type(service_assignment_policy_v2_json,'$.version')='integer'
    AND json_extract(service_assignment_policy_v2_json,'$.version')=2
    AND json_type(service_assignment_policy_v2_json,'$.sourceId')='text'
    AND length(json_extract(service_assignment_policy_v2_json,'$.sourceId')) BETWEEN 15 AND 78
    AND substr(json_extract(service_assignment_policy_v2_json,'$.sourceId'),1,14)='project-alpha:'
    AND substr(json_extract(service_assignment_policy_v2_json,'$.sourceId'),15,1) GLOB '[a-z0-9]'
    AND substr(json_extract(service_assignment_policy_v2_json,'$.sourceId'),15) NOT GLOB '*[^a-z0-9_-]*'
    AND instr(json_extract(service_assignment_policy_v2_json,'$.sourceId'),char(0))=0
    AND json_type(service_assignment_policy_v2_json,'$.reviewId')='text'
    AND length(json_extract(service_assignment_policy_v2_json,'$.reviewId')) BETWEEN 1 AND 128
    AND instr(json_extract(service_assignment_policy_v2_json,'$.reviewId'),char(0))=0
    AND json_type(service_assignment_policy_v2_json,'$.reviewRevision')='integer'
    AND json_extract(service_assignment_policy_v2_json,'$.reviewRevision') BETWEEN 1 AND 9007199254740991
    AND ((json_extract(service_assignment_policy_v2_json,'$.subjectType')='project'
      AND json_type(service_assignment_policy_v2_json,'$.localProjectId')='text'
      AND length(json_extract(service_assignment_policy_v2_json,'$.localProjectId')) BETWEEN 1 AND 128)
      OR (json_extract(service_assignment_policy_v2_json,'$.subjectType') IN ('organization','standalone_client')
        AND json_type(service_assignment_policy_v2_json,'$.localProjectId')='null'))
    AND length(json_extract(service_assignment_policy_v2_json,'$.workspaceId')) BETWEEN 1 AND 128
    AND json_type(service_assignment_policy_v2_json,'$.workspaceId')='text'
    AND json_extract(service_assignment_policy_v2_json,'$.subjectType') IN ('organization','standalone_client','project')
    AND json_type(service_assignment_policy_v2_json,'$.subjectType')='text'
    AND length(json_extract(service_assignment_policy_v2_json,'$.subjectPublicId')) BETWEEN 1 AND 128
    AND json_type(service_assignment_policy_v2_json,'$.subjectPublicId')='text'
    AND length(json_extract(service_assignment_policy_v2_json,'$.generationId')) BETWEEN 1 AND 128
    AND json_type(service_assignment_policy_v2_json,'$.generationId')='text'
    AND length(json_extract(service_assignment_policy_v2_json,'$.sourceGeneration')) BETWEEN 1 AND 128
    AND json_type(service_assignment_policy_v2_json,'$.sourceGeneration')='text'
    AND json_type(service_assignment_policy_v2_json,'$.sourceSequence')='integer'
    AND json_extract(service_assignment_policy_v2_json,'$.sourceSequence') BETWEEN 1 AND 9007199254740991
    AND length(json_extract(service_assignment_policy_v2_json,'$.directoryGenerationId')) BETWEEN 1 AND 128
    AND json_type(service_assignment_policy_v2_json,'$.directoryGenerationId')='text'
    AND json_type(service_assignment_policy_v2_json,'$.directorySourceSequence')='integer'
    AND json_extract(service_assignment_policy_v2_json,'$.directorySourceSequence') BETWEEN 1 AND 9007199254740991
    AND json_type(service_assignment_policy_v2_json,'$.evaluatedAt')='text'
    AND json_type(service_assignment_policy_v2_json,'$.expiresAt')='text'
    AND datetime(json_extract(service_assignment_policy_v2_json,'$.evaluatedAt')) IS NOT NULL
    AND datetime(json_extract(service_assignment_policy_v2_json,'$.expiresAt')) IS NOT NULL
    AND datetime(json_extract(service_assignment_policy_v2_json,'$.expiresAt'))>datetime(json_extract(service_assignment_policy_v2_json,'$.evaluatedAt'))
    AND datetime(json_extract(service_assignment_policy_v2_json,'$.expiresAt'))<=datetime(json_extract(service_assignment_policy_v2_json,'$.evaluatedAt'),'+5 minutes')
  ));
