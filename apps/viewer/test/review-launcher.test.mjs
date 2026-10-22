import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = fs.readFileSync(path.join(root, 'workspace-projects.js'), 'utf8');
const viewer = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

test('workspace launches Viewer tabs with noopener and an unguessable isolated channel', () => {
  const launchers = workspace.slice(workspace.indexOf('async function viewPublishedOutput'), workspace.indexOf('async function downloadOutputAsset'));
  const review = workspace.slice(workspace.indexOf('async function openReview'), workspace.indexOf('async function publishAttempt'));
  assert.match(workspace, /import \{ beginIsolatedViewerLaunch \} from '\.\/isolated-viewer-launch\.mjs'/);
  assert.match(workspace, /async function readyViewerLauncher\(\)\{const launch=beginIsolatedViewerLaunch\(\);if\(!await launch\.waitUntilReady\(\)\)throw new Error\('Viewer popup was blocked or failed to initialize'\)/);
  assert.ok(review.indexOf('launch=await readyViewerLauncher()') < review.indexOf('await api('), 'review API is not called before launcher readiness');
  assert.match(workspace, /reviewSessionController\.track\(launch\.channelId,\{attemptId:result\.attemptId,modelId:result\.modelId,modelVersionId:result\.modelVersionId,sessionTtlSeconds:result\.sessionTtlSeconds\}\)/);
  assert.match(workspace, /launch\.navigate\(result\.embedUrl,\{renewable:true\}\)/);
  assert.doesNotMatch(launchers, /window\.open\('about:blank'|target\.opener|\.opener\s*=/);
});

test('isolated launcher and Viewer communicate only through the random review BroadcastChannel', () => {
  const launcher = fs.readFileSync(path.join(root, 'review-launch.html'), 'utf8');
  assert.match(launcher, /new BroadcastChannel\(`ltds-viewer-review:\$\{channelId\}`\)/);
  assert.match(launcher, /type:'ltds-viewer:launcher-ready',channelId/);
  assert.match(launcher, /type !== 'ltds-viewer:navigate'/);
  assert.match(launcher, /parsed\.origin !== location\.origin/);
  assert.match(viewer, /new BroadcastChannel\(`ltds-viewer-review:\$\{REVIEW_CONTROLLER_ID\}`\)/);
  assert.match(viewer, /const requestId = reviewSessionChannel \? crypto\.randomUUID\(\) : null/);
  assert.match(viewer, /pendingReviewRenewalRequestId = requestId/);
  assert.doesNotMatch(viewer, /window\.opener/);
});
