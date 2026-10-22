'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('new-tab session contract is versioned, removes grants, and isolates its exact controller', () => {
  assert.match(source, /SESSION_STORAGE_PREFIX\}\$\{session\.sessionId\}/);
  assert.match(source, /activeUrl\.pathname = `\/session\/active\/\$\{encodeURIComponent\(session\.sessionId\)\}`/);
  assert.match(source, /history\.replaceState\(null, '', `\$\{activeUrl\.pathname\}\$\{activeUrl\.search\}\$\{activeUrl\.hash\}`\)/);
  assert.match(source, /VIEW_MODE === 'session' \? 'view' : VIEW_MODE/);
  assert.match(source, /type: 'ltds-viewer:ready'/);
  assert.match(source, /new BroadcastChannel\(`ltds-viewer-review:\$\{REVIEW_CONTROLLER_ID\}`\)/);
  assert.match(source, /function sessionControllerOrigins\(\)/);
  assert.doesNotMatch(source, /window\.opener/);
  assert.match(source, /event\.source !== controller \|\| !sessionControllerOrigins\(\)\.includes\(event\.origin\)/);
  assert.match(source, /data\.version !== 1/);
  assert.match(source, /data\.requestId !== pendingReviewRenewalRequestId/);
});

test('retryable renewal failure preserves the current stable capability', () => {
  const renewalHandler = source.slice(source.indexOf('async function handleSessionRenewalMessage'));
  assert.match(renewalHandler, /const retryable =/);
  assert.match(renewalHandler, /if \(retryable\) retrySessionAccess\('redemption-failed'\)/);
  assert.doesNotMatch(renewalHandler, /sessionStorage\.removeItem/);
});

test('Viewer catches up after tab suspension and recovers failed authenticated tiles in place', () => {
  assert.match(source, /requestSessionRenewalIfDue\('focus'\)/);
  assert.match(source, /requestSessionRenewalIfDue\('pageshow'\)/);
  assert.match(source, /document\.visibilityState === 'visible'/);
  assert.match(source, /retrySessionAccess\('controller-timeout'\)/);
  assert.match(source, /function retrySessionAccess\(reason\)[\s\S]*?scheduleSessionRenewalRetry\(reason\)/);
  // Starting a request is not proof that one remains pending: an authoritative
  // denial must retain the blocked label, covered by the executed recovery tests.
  assert.match(source, /if \(!sessionRenewalPending\) requestSessionRenewal\('tile-authorization'\)/);
  assert.match(source, /dom\.lodStatus\.textContent = sessionAccessLabel\(\)/);
  assert.match(source, /SESSION_RENEWAL_BACKOFF_MS = \[10_000, 30_000, 60_000, 120_000, 300_000\]/);
  assert.match(source, /sessionRenewalAttempt !== attempt/);
  assert.match(source, /failure\.kind === 'authorization'[\s\S]*requestSessionRenewal\('tile-authorization'\)/);
  assert.match(source, /function recoverFailedLodTiles\(\)[\s\S]*tilesRenderer\.resetFailedTiles\(\)/);
  assert.match(source, /failure\.kind === 'transient'[\s\S]*scheduleLodTileRetry\(rendererInstance\)/);
});
