'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const viewerRoot = path.resolve(__dirname, '..');
const probeSource = `
  const { config, validate } = require('./server/config');
  const problems = validate();
  process.stdout.write(JSON.stringify({enabled:config.referenceSourceIntake.enabled, environment:config.referenceSourceIntake.environment,
    origin:config.referenceSourceIntake.origin, problems:problems.filter(item=>item.includes('SOURCE_INTAKE')||item.includes('COORDINATOR')||item.includes('SOURCE_ATTESTATION')||item.includes('SOURCE_SNAPSHOT')||item.includes('REFERENCE_COPY')||item.includes('PRINCIPAL_ID')||item.includes('reference source intake'))}));
`;

function probe(overrides = {}, unset = []) {
  const env = { ...process.env, NODE_ENV: 'production', VIEWER_DEPLOYMENT_ENVIRONMENT: 'staging',
    SESSION_SECRET: 'a'.repeat(64), PROCESSING_PLATFORM_ENABLED: 'true' };
  for (const key of unset) delete env[key];
  Object.assign(env, overrides);
  const child = spawnSync(process.execPath, ['-e', probeSource], { cwd: viewerRoot, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('reference source intake remains disabled unless explicitly configured', () => {
  const state = probe({}, ['VIEWER_REFERENCE_SOURCE_INTAKE_ENABLED']);
  assert.equal(state.enabled, false);
  assert.deepEqual(state.problems, []);
});

test('enabled source intake requires distinct scoped keys and exact staging HTTPS identity', () => {
  const signer = crypto.generateKeyPairSync('ed25519');
  const snapshot = crypto.generateKeyPairSync('ed25519');
  const copy = crypto.generateKeyPairSync('ed25519');
  const state = probe({
    VIEWER_REFERENCE_SOURCE_INTAKE_ENABLED: 'true',
    VIEWER_REFERENCE_SOURCE_INTAKE_ENVIRONMENT: 'staging',
    VIEWER_REFERENCE_COORDINATOR_ORIGIN: 'https://processing.staging.example',
    VIEWER_REFERENCE_COORDINATOR_BEARER_TOKEN: 'b'.repeat(48),
    VIEWER_REFERENCE_COORDINATOR_PROVIDER_ID: 'processing-coordinator-staging',
    VIEWER_REFERENCE_COORDINATOR_AUTHORITY_ID: '11111111-1111-4111-8111-111111111111',
    VIEWER_REFERENCE_SOURCE_PRINCIPAL_ID: 'viewer-staging',
    VIEWER_REFERENCE_SOURCE_ATTESTATION_ISSUER_ID: 'viewer-staging',
    VIEWER_REFERENCE_SOURCE_ATTESTATION_KEY_ID: 'preclaim-v1',
    VIEWER_REFERENCE_SOURCE_ATTESTATION_PRIVATE_KEY_PEM: signer.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    VIEWER_SOURCE_SNAPSHOT_ISSUER_ID: 'snapshot-authority',
    VIEWER_SOURCE_SNAPSHOT_KEY_ID: 'snapshot-v1',
    VIEWER_SOURCE_SNAPSHOT_PRIVATE_KEY_PEM: snapshot.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    VIEWER_SOURCE_SNAPSHOT_PUBLIC_KEY_PEM: snapshot.publicKey.export({ type: 'spki', format: 'pem' }),
    VIEWER_REFERENCE_COPY_ISSUER_ID: 'viewer-staging-copy',
    VIEWER_REFERENCE_COPY_KEY_ID: 'accepted-copy-v2',
    VIEWER_REFERENCE_COPY_PRIVATE_KEY_PEM: copy.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    VIEWER_REFERENCE_COPY_PUBLIC_KEY_PEM: copy.publicKey.export({ type: 'spki', format: 'pem' }),
  });
  assert.equal(state.enabled, true);
  assert.equal(state.environment, 'staging');
  assert.equal(state.origin, 'https://processing.staging.example');
  assert.deepEqual(state.problems, []);
});

test('enabled source intake fails closed for missing credentials, keys, or deployment binding', () => {
  const state = probe({ VIEWER_REFERENCE_SOURCE_INTAKE_ENABLED: 'true' }, ['VIEWER_DEPLOYMENT_ENVIRONMENT']);
  assert.equal(state.enabled, true);
  assert.ok(state.problems.length >= 7);
  assert.ok(state.problems.some(problem => problem.includes('VIEWER_DEPLOYMENT_ENVIRONMENT')));
  assert.ok(state.problems.some(problem => problem.includes('VIEWER_REFERENCE_COORDINATOR_BEARER_TOKEN')));
  assert.ok(state.problems.some(problem => problem.includes('VIEWER_SOURCE_SNAPSHOT_PUBLIC_KEY_PEM')));
  assert.ok(state.problems.some(problem => problem.includes('VIEWER_SOURCE_SNAPSHOT_PRIVATE_KEY_PEM')));
  assert.ok(state.problems.some(problem => problem.includes('VIEWER_REFERENCE_COORDINATOR_PROVIDER_ID')));
  assert.ok(state.problems.some(problem => problem.includes('VIEWER_REFERENCE_COPY_PRIVATE_KEY_PEM')));
  assert.ok(state.problems.some(problem => problem.includes('VIEWER_REFERENCE_COPY_PUBLIC_KEY_PEM')));
});
