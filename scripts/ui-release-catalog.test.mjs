import test from 'node:test';
import assert from 'node:assert/strict';
import catalog from '../packages/shared/src/ui-release-catalog.generated.json' with { type: 'json' };
import { findUiReleaseManifest, uiReleaseForRequest } from '../packages/shared/src/ui-release-catalog.ts';

const id = 'cfcf5cf992084f7b3658763cdf362fbc37101665';
test('catalog registers exact independently reproduced candidates with immutable policy copies', () => {
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.releases.length, 2);
  for (const application of ['operations', 'client']) {
    const manifest = findUiReleaseManifest(application, id);
    assert.ok(manifest);
    assert.equal(manifest.files.length, application === 'operations' ? 237 : 21);
    assert.ok(Object.isFrozen(manifest) && Object.isFrozen(manifest.files) && manifest.files.every(Object.isFrozen));
    assert.ok(!manifest.files.some(file => file.path === '/.assetsignore'));
    const url = `https://example.test/_ui/${application}/${id}/index.html`;
    assert.equal(uiReleaseForRequest(application, url), manifest);
    assert.equal(uiReleaseForRequest(application === 'operations' ? 'client' : 'operations', url), null);
    for (const suffix of ['missing.js', '.assetsignore', 'INDEX.html', '%69ndex.html', '../index.html']) {
      assert.equal(uiReleaseForRequest(application, `https://example.test/_ui/${application}/${id}/${suffix}`), null);
    }
  }
});
test('unregistered or malformed selectors cannot silently choose a release', () => {
  for (const selector of [undefined, null, '', ' '+id, id+' ', id.toUpperCase(), 'a'.repeat(40), {}, 1]) {
    assert.equal(findUiReleaseManifest('operations', selector), null);
    assert.equal(findUiReleaseManifest('client', selector), null);
  }
});
