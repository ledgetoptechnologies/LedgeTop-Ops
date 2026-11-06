import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareStagingInquiryBindings, verifyStagingInquiryVersionBindings } from './staging-inquiry-window-bindings.mjs';

const omitted = ['CLIENT_HUB_PA_CONTACT_ASSIGNMENTS_ENABLED', 'CLIENT_DELEGATED_SHARE_SIGNER_ENABLED'];
const added = ['CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED', 'OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED'];
const fixture = () => ({ account_id: '846c924bf17bf4f3dd15c97a4c5d1d51', name: 'ledgetop-ops-staging', main: 'fixture.js', keep_vars: false,
  unsafe: { metadata: { unchanged: true, keep_bindings: [] }, bindings: [...omitted.map(name => ({ name, type: 'inherit' })), { name: 'SECRET', type: 'inherit' }] } });
const flags = () => ({ textAndSecretBindings: 128, flags: Object.fromEntries([...omitted.map(name => [name, 'false']), ...added.map(name => [name, null])]) });
test('prepares the two exact flag substitutions without changing source or unrelated bindings', () => {
  const source = fixture(), before = structuredClone(source), result = prepareStagingInquiryBindings(source, flags());
  assert.deepEqual(source, before); assert.deepEqual(result.unsafe.metadata, before.unsafe.metadata);
  assert.deepEqual(result.unsafe.bindings.find(row => row.name === 'SECRET'), { name: 'SECRET', type: 'inherit' });
  assert.equal(result.unsafe.bindings.length, before.unsafe.bindings.length);
  for (const name of omitted) assert.equal(result.unsafe.bindings.some(row => row.name === name), false);
  for (const name of added) assert.deepEqual(result.unsafe.bindings.find(row => row.name === name), { name, type: 'plain_text', text: 'true' });
});
test('version readback must preserve every unrelated binding and the exact flag transition', () => {
  const before = [...omitted.map(name => ({ name, type: 'plain_text', text: 'false' })), { name: 'SERVICE', type: 'service', service: 'client', environment: 'staging' }];
  const after = [...added.map(name => ({ name, type: 'plain_text', text: 'true' })), before[2]];
  assert.equal(verifyStagingInquiryVersionBindings(before, after), true);
  const changed = structuredClone(after); changed[2].service = 'other'; assert.throws(() => verifyStagingInquiryVersionBindings(before, changed), /bindings_drift/);
  const dropped = after.slice(0, 2); assert.throws(() => verifyStagingInquiryVersionBindings(before, dropped), /bindings_drift/);
  const falseFlag = structuredClone(after); falseFlag[0].text = 'false'; assert.throws(() => verifyStagingInquiryVersionBindings(before, falseFlag), /flags_mismatch/);
  assert.throws(() => verifyStagingInquiryVersionBindings(before, [...after, after[2]]), /bindings_invalid/);
});
test('fails closed for target, baseline and binding drift', () => {
  const wrong = fixture(); wrong.name = 'ledgetop-ops'; assert.throws(() => prepareStagingInquiryBindings(wrong, flags()));
  const changed = flags(); changed.flags[omitted[0]] = 'true'; assert.throws(() => prepareStagingInquiryBindings(fixture(), changed));
  const duplicate = fixture(); duplicate.unsafe.bindings.push({ name: 'SECRET', type: 'inherit' }); assert.throws(() => prepareStagingInquiryBindings(duplicate, flags()));
  const present = fixture(); present.unsafe.bindings.push({ name: added[0], type: 'inherit' }); assert.throws(() => prepareStagingInquiryBindings(present, flags()));
  const keep = fixture(); keep.unsafe.metadata.keep_bindings = ['plain_text']; assert.throws(() => prepareStagingInquiryBindings(keep, flags()));
  const keepVars = fixture(); keepVars.keep_vars = true; assert.throws(() => prepareStagingInquiryBindings(keepVars, flags()));
  const budget = flags(); budget.textAndSecretBindings = 127; assert.throws(() => prepareStagingInquiryBindings(fixture(), budget));
});
