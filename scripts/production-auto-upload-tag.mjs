/** Exact tool-owned upload metadata shapes. These pure comparisons grant no
 * authority; provider/journal consumers require their own private ACK brands. */
const need = value => { if (!value) throw Error('production_auto_upload_tag_refused'); };
const SOURCE = /^[a-f0-9]{40}$/u, TAG = /^auto-[a-f0-9]{12}$/u;
function ownData(value, key) {
  const descriptor = value && Object.getOwnPropertyDescriptor(value, key);
  need(descriptor && Object.hasOwn(descriptor, 'value')); return descriptor.value;
}
export function validOwnedUploadTagBaseline(value) { return value === null || typeof value === 'string' && TAG.test(value); }
export function readOwnedUploadTagBaseline(state) {
  const settings = ownData(state, 'settings');
  const annotations = Object.hasOwn(settings, 'annotations') ? ownData(settings, 'annotations') : {};
  need(annotations && Object.getPrototypeOf(annotations) === Object.prototype);
  if (!Object.hasOwn(annotations, 'workers/tag')) return null;
  const tag = ownData(annotations, 'workers/tag'); need(typeof tag === 'string' && TAG.test(tag)); return tag;
}
export function expectedOwnedUploadAnnotations(workerName, sourceCommit) {
  need(['ledgetop-clients','ledgetop-ops','ledgetop-ops-sync'].includes(workerName) && SOURCE.test(sourceCommit ?? ''));
  return { 'workers/tag': `auto-${sourceCommit.slice(0, 12)}`,
    'workers/message': `${workerName === 'ledgetop-ops-sync' ? 'Ops Sync backend' : 'Retained assets'} release ${sourceCommit.slice(0, 12)}`,
    'workers/triggered_by': 'version_upload' };
}
export function assertOwnedUploadAnnotations(state, { workerName, sourceCommit, candidateVersionId }) {
  const expected = expectedOwnedUploadAnnotations(workerName, sourceCommit);
  need(state?.latest === candidateVersionId);
  const version = state.version?.id === candidateVersionId ? state.version : state.latestVersion;
  need(version?.id === candidateVersionId);
  const annotations = ownData(version, 'annotations'), settingsAnnotations = ownData(ownData(state, 'settings'), 'annotations');
  need(annotations && settingsAnnotations && Object.getPrototypeOf(annotations) === Object.prototype
    && Object.getPrototypeOf(settingsAnnotations) === Object.prototype);
  for (const [key, value] of Object.entries(expected))
    need(ownData(annotations, key) === value && ownData(settingsAnnotations, key) === value);
  return true;
}
export function projectOwnedUploadTagSettings(state, context, baselineTag) {
  need(validOwnedUploadTagBaseline(baselineTag));
  assertOwnedUploadAnnotations(state, context);
  const settings = structuredClone(state.settings);
  if (baselineTag === null) delete settings.annotations['workers/tag'];
  else settings.annotations['workers/tag'] = baselineTag;
  return settings;
}
