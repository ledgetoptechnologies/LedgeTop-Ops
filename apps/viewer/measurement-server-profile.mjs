import {measurementGeometryHash} from './measurement-surface-client.mjs';
import {surfaceCalculationError} from './measurement-server-surface.mjs';
import {validateNativeProfile} from './measurement-native-profile.mjs';

const stopped = () => Object.assign(new Error('Stopped watching this section. Its calculation may still be running; reopen the same section to resume.'), {name: 'AbortError'});
const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(stopped());
  const abort = () => { clearTimeout(timer); reject(stopped()); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, {once: true});
});

// A profile is read-only with respect to the saved polygon and volume. It uses
// the same scoped queue, never an admin credential or browser raster fallback.
export function createServerProfileCalculator({request, getRecord, isCurrent = () => true, pollMs = 3000, wait = pause}) {
  return async function calculateProfile(record, {line, signal, onProgress = () => {}, onJob = () => {}} = {}) {
    record = structuredClone(getRecord?.() || record);
    const original = structuredClone(record), parentCalculationId = record.results?.calculationJobId;
    if (!parentCalculationId || !['surface-cut-fill','point-surface-cut-fill'].includes(record.results?.method)) throw new Error('Calculate and save this polygon’s surface volume before requesting a cross-section.');
    const fingerprint = r => JSON.stringify([r?.id, r?.modelVersionId, r?.revision, r?.collection, r?.vertices, r?.coordinateReference, r?.results?.calculationJobId]);
    const current = () => {
      if (signal?.aborted) throw stopped();
      if (!isCurrent() || (getRecord && fingerprint(getRecord()) !== fingerprint(original))) throw new Error('Measurement access, geometry, or saved result changed. Reopen the section from the current measurement.');
    };
    const send = async (operation, payload) => { current(); let response; try { response = await request(operation, payload, record); } catch (error) { throw surfaceCalculationError(error); } current(); return response; };
    onProgress('Checking access to the saved volume and original elevation data…');
    const caps = await send('capabilities', {});
    if (caps?.capabilities?.transectCalculations !== true) throw new Error('Cross-section calculations are not available for this model or your current access.');
    const temporary = caps.capabilities.temporaryCalculations === true;
    const geometryHash = temporary ? await measurementGeometryHash(record) : null; current();
    if (temporary) {
      if (!caps.modelVersionId || (record.modelVersionId && record.modelVersionId !== caps.modelVersionId)) throw new Error('The model version changed. Reopen this measurement.');
      record = {...record, revision: 1, modelVersionId: caps.modelVersionId};
    }
    const parent = (await send('status', {measurementId: record.id, jobId: parentCalculationId}))?.calculation;
    if (parent?.id !== parentCalculationId || parent.measurementId !== record.id || parent.status !== 'complete' || parent.result?.method !== record.results.method || (parent.revision !== record.revision && parent.attachmentRevision !== record.revision) || (temporary && parent.geometryHash !== geometryHash)) throw new Error('The saved volume is no longer available for this polygon revision. Calculate the surface again before requesting a section.');
    const source = parent.result.source;
    if (!source?.sha256 || source.modelVersionId !== record.modelVersionId) throw new Error('The saved volume does not identify this immutable elevation source.');
    const body = {revision: record.revision, method: 'surface-transect', parentCalculationId, line: structuredClone(line)};
    const matches = job => job?.measurementId === record.id && job.revision === record.revision && (!temporary || job.geometryHash === geometryHash) && job.parameters?.method === body.method && job.parameters?.parentCalculationId === parentCalculationId && JSON.stringify(job.parameters?.line) === JSON.stringify(body.line);
    const exposeCancel = job => onJob({cancel: () => send('cancel', {measurementId: record.id, jobId: job.id})});
    const recover = async () => {
      const response = await send('list', {measurementId: record.id});
      if (!Array.isArray(response?.calculations)) throw new Error('Existing section calculations could not be checked. No duplicate work was started.');
      const active = response.calculations.find(j => j.measurementId === record.id && ['queued', 'running'].includes(j.status));
      if (active && !matches(active)) { exposeCancel(active); throw new Error('Another calculation is already running for this outline. Wait for it or cancel it here before updating the section.'); }
      return active || response.calculations.find(j => j.status === 'complete' && matches(j));
    };
    let job = await recover();
    if (!job) {
      try { job = (await send('create', {measurementId: record.id, request: body}))?.calculation; }
      catch (error) { if (error.code !== 'measurement_calculation_already_active') throw error; job = await recover(); if (!job) throw error; }
    }
    const jobId = job?.id;
    if (!jobId) throw new Error('The section calculation could not be identified. Update the same profile to check for an existing result.');
    for (;;) {
      current();
      if (job?.id !== jobId || !matches(job)) throw new Error('The section does not match the current polygon, line, or saved volume.');
      if (job.status === 'complete') { onJob(null); if(!job.parameters.baseHash||job.result?.baseHash!==job.parameters.baseHash)throw new Error('The section reference base does not match the accepted calculation request.');return {...validateNativeProfile(job.result, {line, parentCalculationId, source}), calculationJobId: jobId}; }
      if (job.status === 'failed') { onJob(null); throw surfaceCalculationError(Object.assign(new Error(`The section could not finish (${String(job.errorCode || 'unavailable').replaceAll('_', ' ')}). Your saved volume is unchanged.`), {code: job.errorCode})); }
      if (job.status === 'cancelled') { onJob(null); throw new Error('Section calculation cancelled. Your saved volume is unchanged.'); }
      if (!['queued', 'running'].includes(job.status)) throw new Error('The section calculation status could not be understood. Update the same profile to check its status.');
      exposeCancel(job); onProgress(job.status === 'queued' ? 'Waiting to calculate this section. You may close this inspector while it works.' : 'Reading the original elevation data along this section…');
      await wait(pollMs, signal); current(); job = (await send('status', {measurementId: record.id, jobId}))?.calculation;
    }
  };
}
