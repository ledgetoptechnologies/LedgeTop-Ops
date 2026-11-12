import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyDeliveryRouteMatches, manifest, validateManifest } from './legacy-public-routing-cutover.mjs';

test('manifest is a source-only staged proposal with bounded paths, unresolved live IDs, and rollback gates', () => {
  assert.deepEqual(validateManifest(), []);
  assert.equal(manifest.activation.automatic, false);
  assert.equal(manifest.activation.providerMutation, false);
  assert.equal(manifest.routing.legacyTechnologiesPortal.addOrRemoveWorkerRoute, false);
  assert.equal(manifest.redirectRules.length, 2);
  assert.ok(manifest.redirectRules.every(rule => rule.ruleId === null));
  assert.equal(manifest.staging.productionRuleChangesAllowed, false);
  assert.ok(manifest.gates.some(gate => gate.includes('SHA-256 hashes')));
  assert.ok(manifest.gates.some(gate => gate.includes('binding names/presence')));
  assert.ok(manifest.gates.some(gate => gate.includes('independent sessions')));
  assert.ok(manifest.gates.some(gate => gate.includes('browser does not send each __Host- cookie')));
  assert.ok(manifest.gates.some(gate => gate.includes('Do not claim the signed cookie payload is cryptographically hostname-bound')));
  assert.ok(manifest.gates.some(gate => gate.includes('add only the four exact legacy delivery Worker routes')));
  assert.ok(manifest.gates.some(gate => gate.includes('disable exactly the two reviewed broad redirect IDs')));
});

test('validator rejects arbitrary route hosts, mismatched zone roles, or broadened header policy', () => {
  const foreignHost = structuredClone(manifest);
  foreignHost.routing.legacyDelivery.patterns[0] = 'attacker.invalid/s/*';
  assert.ok(validateManifest(foreignHost).some(error => error.includes('exact production hostname')));
  const wrongZone = structuredClone(manifest);
  wrongZone.redirectRules[0].zone = 'ledgetoptechnologies.com';
  assert.ok(validateManifest(wrongZone).some(error => error.includes('zone/role')));
  const broadenedHeaders = structuredClone(manifest);
  broadenedHeaders.workerAdmission.headers.push('X-Forwarded-Host');
  assert.ok(validateManifest(broadenedHeaders).some(error => error.includes('header set')));
  const broadenedWorkerPaths = structuredClone(manifest);
  broadenedWorkerPaths.workerAdmission.legacyDeliveryHost.push('/admin/*');
  assert.ok(validateManifest(broadenedWorkerPaths).some(error => error.includes('Worker admission paths')));
  const falseBindingClaim = structuredClone(manifest);
  falseBindingClaim.gates = falseBindingClaim.gates.map(gate => gate.replace(
    'the browser does not send each __Host- cookie to the other host, and requests with no valid cookie are denied. Do not claim the signed cookie payload is cryptographically hostname-bound: a manually copied valid cookie may authenticate on another admitted host.',
    'a cookie/session from one host is denied on the other'));
  assert.ok(validateManifest(falseBindingClaim).some(error => error.includes('without asserting cryptographic host binding')));
});

test('validator enforces production route-add, route-readback, redirect-disable order and safe rollback order', () => {
  const reversed = structuredClone(manifest);
  const redirectGate = reversed.gates.findIndex(gate => gate.includes('disable exactly the two reviewed broad redirect IDs'));
  const routeGate = reversed.gates.findIndex(gate => gate.includes('add only the four exact legacy delivery Worker routes'));
  [reversed.gates[redirectGate], reversed.gates[routeGate]] = [reversed.gates[routeGate], reversed.gates[redirectGate]];
  assert.ok(validateManifest(reversed).some(error => error.includes('phase must precede')));
  const unsafeRollback = structuredClone(manifest);
  [unsafeRollback.rollback[0], unsafeRollback.rollback[1]] = [unsafeRollback.rollback[1], unsafeRollback.rollback[0]];
  assert.ok(validateManifest(unsafeRollback).some(error => error.includes('rollback must restore')));
});

test('exact legacy delivery public route prefixes include nested paths and arbitrary queries', () => {
  for (const prefix of ['/s/', '/client-share/', '/api/public/', '/assets/']) {
    assert.equal(legacyDeliveryRouteMatches(`https://delivery.ledgetopdroneservices.com${prefix}id`), true, prefix);
    assert.equal(legacyDeliveryRouteMatches(`https://delivery.ledgetopdroneservices.com${prefix}deep/path?token=capability&next=x`), true, `${prefix} query`);
  }
});

test('routes are exact-host and do not broaden into admin, private APIs, or other paths', () => {
  for (const path of ['/', '/admin', '/admin/users', '/portal', '/health', '/api/client/me', '/api/internal/x', '/_ui/release/client.js', '/uploads/file', '/assets', '/s'])
    assert.equal(legacyDeliveryRouteMatches(`https://delivery.ledgetopdroneservices.com${path}`), false, path);
  for (const host of ['portal.ledgetoptechnologies.com', 'client.ledgetopdroneservices.com', 'delivery.ledgetop.app', 'evil.invalid'])
    assert.equal(legacyDeliveryRouteMatches(`https://${host}/s/id?token=x`), false, host);
});

test('query wildcards never turn an unmatched path into a route match', () => {
  for (const query of ['?token=x', '?access_code=x', '?folder=a&cursor=b', '?redirect=https%3A%2F%2Fevil.invalid']) {
    assert.equal(legacyDeliveryRouteMatches(`https://delivery.ledgetopdroneservices.com/admin${query}`), false, query);
    assert.equal(legacyDeliveryRouteMatches(`https://delivery.ledgetopdroneservices.com/api/client/me${query}`), false, query);
    assert.equal(legacyDeliveryRouteMatches(`https://delivery.ledgetopdroneservices.com/api/public/shares/id/session${query}`), true, query);
  }
});
