import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Checks that a release attestation written by publish-viewer.yml on a main push
// describes exactly the commit, digest and run an operator asked to promote.
// Promotion to `latest` refuses anything this script does not accept.

const VERIFICATION = Object.freeze({
  repositoryChecks: 'passed',
  pullByDigest: 'passed',
  runtimeUser: '568:568',
  revisionLabel: 'passed',
  sourceStamp: 'passed',
  runtimeSchema: 'passed',
  obj2TilesRuntime: 'passed',
  potreeRuntime: 'passed',
});

export function verifyPromotionAttestation(record, expected) {
  const fail = message => { throw new Error(`promotion refused: ${message}`); };
  const { repository, commit, digest, runId, image } = expected;
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) fail('commit must be a full lowercase 40-character SHA');
  if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) fail('digest must be sha256:<64 hex>');
  if (!/^\d+$/.test(runId ?? '')) fail('run id must be numeric');
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('attestation must be a JSON object');
  if (record.attestationSchemaVersion !== 1) fail('unsupported attestation schema');
  if (record.repository !== repository) fail('attestation repository mismatch');
  if (record.commit !== commit) fail('attestation commit mismatch');
  if (record.image !== image) fail('attestation image mismatch');
  if (record.digest !== digest) fail('attestation digest mismatch');
  if (record.digestQualifiedImage !== `${image}@${digest}`) fail('digest-qualified image mismatch');
  const run = record.run ?? {};
  if (run.id !== runId) fail('attestation run mismatch');
  if (run.ref !== 'refs/heads/main') fail('candidate was not built from main');
  if (run.workflowRef !== `${repository}/.github/workflows/publish-viewer.yml@refs/heads/main`) fail('candidate was not built by publish-viewer.yml on main');
  if (run.workflowSha !== commit) fail('workflow revision does not match the candidate commit');
  if (!Number.isSafeInteger(record.viewerSchemaVersion) || record.viewerSchemaVersion < 1) fail('invalid Viewer schema version');
  const verification = record.verification ?? {};
  const keys = Object.keys(verification).sort();
  if (JSON.stringify(keys) !== JSON.stringify(Object.keys(VERIFICATION).sort())) fail('unexpected verification evidence fields');
  for (const [key, value] of Object.entries(VERIFICATION)) {
    if (verification[key] !== value) fail(`verification ${key} did not pass`);
  }
  return { commit, digest, viewerSchemaVersion: record.viewerSchemaVersion };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) throw new Error('attestation path is required');
  const required = name => {
    const value = process.env[name];
    if (!value) throw new Error(`missing ${name}`);
    return value;
  };
  const result = verifyPromotionAttestation(JSON.parse(fs.readFileSync(file, 'utf8')), {
    repository: required('GITHUB_REPOSITORY'),
    commit: required('PROMOTE_COMMIT'),
    digest: required('PROMOTE_DIGEST'),
    runId: required('CANDIDATE_RUN_ID'),
    image: required('IMAGE_NAME'),
  });
  process.stdout.write(`schema-version=${result.viewerSchemaVersion}\n`);
}
