import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Pin the local populated-D1 candidate, not a production release approval.
// A changed migration must be reviewed and its populated acceptance rerun;
// updating these hashes alone is not acceptance evidence.
const candidates = [
  ['apps/operations/migrations/0158_operations_portal_native_delivery_authority.sql',
    '034c830a00eab4ac259493e4af36d2eab2ab4f91883278fc1cbf578fffefb35b'],
  ['apps/client/migrations/0227_operations_portal_native_delivery_authority.sql',
    '1ad80368d40f9fac270a60cbb8833f9a7e647679dbccd2424af55ca18921e07d'],
  ['apps/client/migrations/0228_operations_portal_native_content_start_audit.sql',
    '441a11ca0992479f953de662de42041d35c9e41342bc345d59396fdcde569040'],
];

for (const [path, expected] of candidates) {
  test(`native delivery populated acceptance candidate remains byte-pinned: ${path}`, () => {
    const bytes = readFileSync(new URL(`../${path}`, import.meta.url));
    assert.equal(bytes.includes(13), false, 'SQL candidate must remain LF-only');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected,
      'Migration changed: review the delta and rerun populated acceptance before re-pinning');
  });
}
