const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (code, status = 403) => { throw Object.assign(new Error(code), { code, status }); };
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));

// Only protocol-owned identifiers cross into a model tab. Never forward a
// server message, arbitrary code, or a prefix-matched string: those may contain
// paths, credentials, or other details from a failed native source operation.
const CALCULATION_ERROR_CODES = new Set([
  'measurement_admin_required', 'measurement_scope_changed', 'measurement_request_invalid',
  'measurement_calculation_invalid', 'measurement_volume_requires_bounded_polygon',
  'measurement_method_unavailable', 'measurement_native_source_unavailable',
  'measurement_source_crs_unavailable', 'measurement_reference_invalid',
  'measurement_vertical_unit_invalid', 'measurement_point_surface_settings_invalid',
  'measurement_reconstruction_settings_invalid', 'measurement_mesh_selection_invalid',
  'measurement_mesh_frame_unknown', 'measurement_not_found',
  'measurement_calculations_disabled', 'measurement_reconstruction_unavailable',
  'measurement_calculation_not_found', 'measurement_revision_conflict',
  'measurement_calculation_already_active', 'measurement_queue_full', 'measurement_rate_limited',
  'measurement_source_preflight_unavailable', 'measurement_source_changed',
  'measurement_source_crs_mismatch', 'measurement_pixel_is_point_unsupported',
  'measurement_rotated_raster_unsupported', 'measurement_raster_transform_unsupported',
  'measurement_raster_block_too_large', 'measurement_source_vertical_metadata_invalid',
  'measurement_source_value_transform_unsupported', 'measurement_source_vertical_units_conflict',
  'measurement_source_vertical_units_unsupported', 'measurement_source_vertical_units_required',
  'measurement_boundary_elevation_unavailable', 'measurement_limit', 'measurement_cancelled',
  'measurement_transect_invalid', 'measurement_transect_limit', 'measurement_transect_reference_invalid',
  'measurement_transect_base_unavailable', 'measurement_transect_parent_stale', 'measurement_transect_parent_unavailable',
]);
export const safeMeasurementCalculationErrorCode = code =>
  typeof code === 'string' && CALCULATION_ERROR_CODES.has(code) ? code : 'measurement_request_failed';

// This helper runs only in the authenticated workspace. Its narrowly scoped
// protocol does not give the model tab a generic fetch proxy or an admin token.
export function createMeasurementCalculationBroker({ origin, getAuthorization, fetchImpl = fetch }) {
  if (new URL(origin).origin !== origin || typeof getAuthorization !== 'function') throw new Error('invalid_measurement_broker');
  return async (context, message) => {
    const auth = getAuthorization();
    if (!auth?.accessToken || !auth.session?.subject || !auth.session.permissions?.includes('viewer.processing.write') || !Number.isFinite(Date.parse(auth.session.expiresAt)) || Date.parse(auth.session.expiresAt) <= Date.now()) fail('measurement_admin_required');
    if (!['capabilities','create','list','status','cancel'].includes(message.operation) || !/^[A-Za-z0-9_-]{32,128}$/.test(message.viewerToken || '') || !message.payload || JSON.stringify(message.payload).length > 16384) fail('measurement_request_invalid', 400);
    const payload = message.payload;
    const allowed = message.operation === 'capabilities' ? [] : message.operation === 'create' ? ['measurementId','request'] : message.operation === 'list' ? ['measurementId'] : ['measurementId','jobId'];
    if (!keys(payload, allowed) || (message.operation !== 'capabilities' && !UUID.test(payload.measurementId || '')) || (['status','cancel'].includes(message.operation) && !UUID.test(payload.jobId || ''))) fail('measurement_request_invalid', 400);
    const send = async (path, { method = 'GET', body, administrative = false } = {}) => {
      const response = await fetchImpl(`${origin}${path}`, { method, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${message.viewerToken}`, Accept: 'application/json', ...(administrative ? { 'X-Viewer-Admin-Authorization': `Bearer ${auth.accessToken}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) fail('measurement_admin_required', response.status);
        let code;
        // Only calculation responses have this error contract. A session check
        // or an upstream HTML/network failure remains a generic request error.
        if (administrative) {
          try { code = (await response.json())?.code; } catch {}
        }
        fail(safeMeasurementCalculationErrorCode(code), response.status);
      }
      return response.status === 204 ? { cancelled: true } : response.json();
    };
    const viewer = await send('/api/v1/sessions/current');
    if (viewer.audience !== 'ops' || viewer.subject !== auth.session.subject || viewer.model?.id !== context.modelId || viewer.model?.activeVersion?.id !== context.modelVersionId || viewer.sessionMode !== (context.sessionMode || 'review') || (viewer.sessionMode === 'review' && viewer.reviewAttemptId !== context.attemptId) || viewer.permissions?.view !== true || viewer.permissions?.measure !== true || !Number.isFinite(Date.parse(viewer.expiresAt)) || Date.parse(viewer.expiresAt) <= Date.now()) fail('measurement_scope_changed');
    // A workspace sign-out or subject/token replacement during verification
    // must not dispatch a queued write under the preceding principal.
    const current = getAuthorization();
    if (current?.accessToken !== auth.accessToken || current?.session?.subject !== auth.session.subject || !current.session.permissions?.includes('viewer.processing.write')) fail('measurement_admin_required');
    if (message.operation === 'capabilities') return send('/api/v1/measurements/capabilities', { administrative: true });
    const base = `/api/v1/measurements/${encodeURIComponent(payload.measurementId)}/calculations`;
    if (message.operation === 'create') return send(base, { method: 'POST', body: payload.request, administrative: true });
    if (message.operation === 'list') return send(base, { administrative: true });
    return send(`${base}/${encodeURIComponent(payload.jobId)}`, { method: message.operation === 'cancel' ? 'DELETE' : 'GET', administrative: true });
  };
}
