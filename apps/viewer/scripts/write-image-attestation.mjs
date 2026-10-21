import fs from 'node:fs';

const output = process.argv[2];
if (!output) throw new Error('attestation output path is required');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const repository = required('GITHUB_REPOSITORY');
const commit = required('GITHUB_SHA');
const expectedRevision = required('EXPECTED_REVISION');
const image = required('IMAGE_NAME');
const digest = required('IMAGE_DIGEST');
const digestQualifiedImage = required('PUBLISHED_IMAGE');
const runId = required('GITHUB_RUN_ID');
const runAttemptText = required('GITHUB_RUN_ATTEMPT');
const workflow = required('GITHUB_WORKFLOW');
const workflowRef = required('GITHUB_WORKFLOW_REF');
const workflowSha = required('GITHUB_WORKFLOW_SHA');
const ref = required('GITHUB_REF');
const serverUrl = required('GITHUB_SERVER_URL');
const viewerSchemaText = required('VIEWER_SCHEMA_VERSION');
const expectedSchemaText = required('EXPECTED_SCHEMA_VERSION');
const obj2Tiles = required('EXPECTED_OBJ2TILES_VERSION');
const potree = required('EXPECTED_POTREE_VERSION');

if (!/^[0-9a-f]{40}$/.test(commit) || expectedRevision !== commit) throw new Error('invalid source revision');
if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('invalid image digest');
if (digestQualifiedImage !== `${image}@${digest}`) throw new Error('digest-qualified image mismatch');
if (!/^\d+$/.test(runId)) throw new Error('invalid run id');
const runAttempt = Number(runAttemptText);
if (!Number.isSafeInteger(runAttempt) || runAttempt < 1) throw new Error('invalid run attempt');
if (!/^[0-9a-f]{40}$/.test(workflowSha)) throw new Error('invalid workflow revision');
const viewerSchemaVersion = Number(viewerSchemaText);
const expectedSchemaVersion = Number(expectedSchemaText);
if (!Number.isSafeInteger(viewerSchemaVersion) || viewerSchemaVersion < 1 || viewerSchemaVersion !== expectedSchemaVersion) {
  throw new Error('invalid Viewer schema version');
}
if (!/^\d+\.\d+\.\d+$/.test(obj2Tiles) || !/^\d+\.\d+\.\d+$/.test(potree)) throw new Error('invalid component version');

const record = {
  attestationSchemaVersion: 1,
  repository,
  commit,
  image,
  digest,
  digestQualifiedImage,
  run: {
    id: runId,
    attempt: runAttempt,
    url: `${serverUrl}/${repository}/actions/runs/${runId}`,
    workflow,
    workflowRef,
    workflowSha,
    ref,
  },
  viewerSchemaVersion,
  components: {
    obj2Tiles,
    potree,
    classicEptPatchVerified: true,
  },
  verification: {
    repositoryChecks: 'passed',
    pullByDigest: 'passed',
    runtimeUser: '568:568',
    revisionLabel: 'passed',
    sourceStamp: 'passed',
    runtimeSchema: 'passed',
    obj2TilesRuntime: 'passed',
    potreeRuntime: 'passed',
  },
};

fs.writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
