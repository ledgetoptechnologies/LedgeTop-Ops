import assert from 'node:assert/strict';
import test from 'node:test';
import { staffNavigationTargets, renderStaffNavigation } from '../viewer-staff-navigation.mjs';

const context = { viewMode: 'session', topLevel: true };
const staff = { audience: 'ops', operationsOrigin: 'https://ops.example.test' };

test('staff navigation uses only fixed same-tab application destinations', () => {
  assert.deepEqual(staffNavigationTargets(staff, context), {
    dashboard: 'https://ops.example.test/', models: 'https://ops.example.test/viewer',
  });
  // URL/referrer/hash-derived destinations have no input in this contract.
  assert.deepEqual(staffNavigationTargets({ ...staff, returnUrl: 'https://attacker.test/', referrer: 'https://attacker.test/' }, context),
    staffNavigationTargets(staff, context));
  assert.deepEqual(staffNavigationTargets({ ...staff, operationsOrigin: 'http://127.0.0.1:8091' }, context), {
    dashboard: 'http://127.0.0.1:8091/', models: 'http://127.0.0.1:8091/viewer',
  });
});

test('public, client, embedded and older server sessions never acquire staff navigation', () => {
  for (const viewMode of ['view', 'project', 'embed', 'admin', undefined])
    assert.equal(staffNavigationTargets(staff, { ...context, viewMode }), null);
  assert.equal(staffNavigationTargets(staff, { ...context, topLevel: false }), null);
  assert.equal(staffNavigationTargets({ ...staff, audience: 'client' }, context), null);
  assert.equal(staffNavigationTargets({ audience: 'ops' }, context), null);
  assert.equal(staffNavigationTargets(null, context), null);
});

test('malformed origins cannot introduce a destination, credential, query or fragment', () => {
  for (const operationsOrigin of [undefined, null, '', 12, 'javascript:alert(1)', '//ops.example.test',
    'http://ops.example.test', 'ftp://localhost', 'https://user:pass@ops.example.test',
    'https://ops.example.test/', 'https://ops.example.test/viewer',
    'https://ops.example.test?returnUrl=https://attacker.test', 'https://ops.example.test#dashboard',
    'https://ops.example.test\\@attacker.test/', 'https://ops.example.test\n'])
    assert.equal(staffNavigationTargets({ ...staff, operationsOrigin }, context), null, String(operationsOrigin));
});

test('rendering hides and clears stale staff destinations when the current session is ineligible', () => {
  const anchor = () => ({ href: undefined, removeAttribute(name) { assert.equal(name, 'href'); delete this.href; } });
  const nodes = { container: { hidden: true }, dashboard: anchor(), models: anchor() };
  assert.equal(renderStaffNavigation(nodes, staff, context), true);
  assert.equal(nodes.container.hidden, false);
  assert.equal(nodes.dashboard.href, 'https://ops.example.test/');
  assert.equal(nodes.models.href, 'https://ops.example.test/viewer');
  assert.equal(renderStaffNavigation(nodes, { audience: 'client' }, context), false);
  assert.equal(nodes.container.hidden, true);
  assert.equal(nodes.dashboard.href, undefined);
  assert.equal(nodes.models.href, undefined);
  assert.equal(renderStaffNavigation({ container: null }, staff, context), false);
});
