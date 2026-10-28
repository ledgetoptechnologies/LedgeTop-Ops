import test from 'node:test';
import assert from 'node:assert/strict';
import { clientPortalTarget, renderClientNavigation } from '../viewer-client-navigation.mjs';

const session = { audience: 'client', clientPortalOrigin: 'https://portal.example.test' };
const context = { viewMode: 'session', topLevel: true };

test('only top-level authenticated client sessions receive a fixed portal destination', () => {
  assert.equal(clientPortalTarget(session, context), 'https://portal.example.test/portal');
  for (const audience of ['ops', 'public', undefined])
    assert.equal(clientPortalTarget({ ...session, audience }, context), null);
  for (const viewMode of ['public', 'project', 'embed', undefined])
    assert.equal(clientPortalTarget(session, { ...context, viewMode }), null);
  assert.equal(clientPortalTarget(session, { ...context, topLevel: false }), null);
  assert.equal(clientPortalTarget(null, context), null);
});

test('return origin rejects paths, credentials and executable or insecure schemes', () => {
  for (const origin of ['https://portal.example.test/evil', 'https://portal.example.test/?next=evil',
    'https://portal.example.test/#evil', 'https://user:secret@portal.example.test',
    'http://portal.example.test', 'javascript:alert(1)', 'file:///portal', '//portal.example.test', ''])
    assert.equal(clientPortalTarget({ ...session, clientPortalOrigin: origin }, context), null, origin);
  assert.equal(clientPortalTarget({ ...session, clientPortalOrigin: 'http://localhost:3000' }, context),
    'http://localhost:3000/portal');
});

test('audience changes clear stale navigation and restore it only from current server metadata', () => {
  const container = { hidden: true };
  const portal = { removeAttribute(name) { if (name === 'href') delete this.href; } };
  assert.equal(renderClientNavigation({ container, portal }, session, context), true);
  assert.equal(portal.href, 'https://portal.example.test/portal');
  assert.equal(container.hidden, false);
  assert.equal(renderClientNavigation({ container, portal }, { ...session, audience: 'ops' }, context), false);
  assert.equal(container.hidden, true);
  assert.equal(portal.href, undefined);
  assert.equal(renderClientNavigation({ container, portal }, session, context), true);
  assert.equal(renderClientNavigation({ container: null, portal }, session, context), false);
});
