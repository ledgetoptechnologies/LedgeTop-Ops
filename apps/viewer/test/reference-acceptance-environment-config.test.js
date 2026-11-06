'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const viewerRoot = path.resolve(__dirname, '..');
const probeSource = `
  const { config, validate } = require('./server/config');
  process.stdout.write(JSON.stringify({
    production: config.production,
    deploymentEnvironment: config.deploymentEnvironment,
    deploymentEnvironmentExplicit: config.deploymentEnvironmentExplicit,
    referenceAcceptanceEnvironment: config.referenceAcceptanceEnvironment,
    problems: validate(),
  }));
`;

function probe(overrides, unset = []) {
  const env = { ...process.env };
  for (const key of unset) delete env[key];
  Object.assign(env, overrides);
  const child = spawnSync(process.execPath, ['-e', probeSource], {
    cwd: viewerRoot,
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('staging accepted-copy environment works in the optimized production Node image', () => {
  const state = probe({
    NODE_ENV: 'production',
    VIEWER_DEPLOYMENT_ENVIRONMENT: 'staging',
    VIEWER_REFERENCE_ACCEPTANCE_ENVIRONMENT: '',
    VIEWER_REFERENCE_ACCEPTANCE_ENABLED: 'true',
  });

  assert.equal(state.production, true);
  assert.equal(state.deploymentEnvironment, 'staging');
  assert.equal(state.deploymentEnvironmentExplicit, true);
  assert.equal(state.referenceAcceptanceEnvironment, 'staging');
  assert.ok(!state.problems.some(problem => problem.includes('must match VIEWER_DEPLOYMENT_ENVIRONMENT')));
});

test('accepted-copy environment mismatch fails closed', () => {
  const state = probe({
    NODE_ENV: 'production',
    VIEWER_DEPLOYMENT_ENVIRONMENT: 'production',
    VIEWER_REFERENCE_ACCEPTANCE_ENVIRONMENT: 'staging',
    VIEWER_REFERENCE_ACCEPTANCE_ENABLED: 'true',
  });

  assert.ok(state.problems.includes(
    'VIEWER_REFERENCE_ACCEPTANCE_ENVIRONMENT must match VIEWER_DEPLOYMENT_ENVIRONMENT'));
});

test('enabled acceptance requires an explicit deployment environment', () => {
  const state = probe({
    NODE_ENV: 'production',
    VIEWER_REFERENCE_ACCEPTANCE_ENVIRONMENT: '',
    VIEWER_REFERENCE_ACCEPTANCE_ENABLED: 'true',
  }, ['VIEWER_DEPLOYMENT_ENVIRONMENT']);

  assert.equal(state.deploymentEnvironment, 'production');
  assert.equal(state.deploymentEnvironmentExplicit, false);
  assert.ok(state.problems.includes(
    'VIEWER_DEPLOYMENT_ENVIRONMENT must be set explicitly when Viewer reference acceptance is enabled'));
});
