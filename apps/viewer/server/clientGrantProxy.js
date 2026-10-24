'use strict';

const { signViewerEvent } = require('./viewerEvents');
const { randomUUID } = require('node:crypto');
const { validDirectGrantInput, validDirectSnapshot, directListQuery } = require('./directClientGrantContract');

const REMOTE_PATH = '/api/viewer/workspace/client-grants';
const LOCAL_PATH = '/api/v1/workspace/client-grants';
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

function invalid(res, message = 'client grant request is invalid') {
  return res.status(400).json({ error: message, code: 'invalid_client_grant_request' });
}
function validSnapshot(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Array.isArray(value.grants) && value.grants.length <= 10_000
    && Array.isArray(value.projects) && value.projects.length <= 10_000
    && Array.isArray(value.associations) && value.associations.length <= 10_000
    && (value.replayed === undefined || typeof value.replayed === 'boolean');
}

function validNativeSnapshot(value, action) {
  const object = item => item && typeof item === 'object' && !Array.isArray(item);
  const id = item => typeof item === 'string' && ID.test(item);
  const text = (item, maximum = 1024) => typeof item === 'string' && item.length > 0 && item.length <= maximum && !/[\u0000-\u001f\u007f]/.test(item);
  const source = item => typeof item === 'string' && /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(item);
  const list = items => Array.isArray(items) && items.length <= 500;
  return object(value) && (value.replayed === undefined || typeof value.replayed === 'boolean')
    && (value.existingSessionsExpireWithinSeconds === undefined ? action !== 'revoke'
      : Number.isSafeInteger(value.existingSessionsExpireWithinSeconds) && value.existingSessionsExpireWithinSeconds > 0 && value.existingSessionsExpireWithinSeconds <= 1800)
    && list(value.targets) && value.targets.every(target => object(target) && source(target.sourceId)
      && id(target.workspaceId) && text(target.projectPublicId, 256) && text(target.workspaceName) && text(target.projectName)
      && list(target.associations) && target.associations.every(item => object(item) && id(item.id) && text(item.modelTitle) && id(item.viewerModelId)))
    && list(value.grants) && value.grants.every(grant => object(grant) && id(grant.id) && source(grant.source_id)
      && id(grant.workspace_id) && text(grant.project_public_id, 256) && text(grant.workspace_name)
      && (grant.project_name === null || text(grant.project_name)) && grant.status === 'active'
      && ['project', 'task'].includes(grant.scope_type)
      && (grant.scope_type === 'project' ? grant.association_id === null && grant.include_future_published === 1 : id(grant.association_id) && grant.include_future_published === 0)
      && ['can_measure', 'can_view_cameras', 'can_download'].every(key => grant[key] === 0 || grant[key] === 1)
      && Number.isSafeInteger(grant.grant_version) && grant.grant_version > 0
      && (grant.authorization_expires_at === null || typeof grant.authorization_expires_at === 'string' && Number.isFinite(Date.parse(grant.authorization_expires_at))));
}

function createClientGrantProxy({ config, authorize, fetchImpl = fetch, diagnostic = record => console.warn(`[client-grant-proxy] ${JSON.stringify(record)}`) }) {
  async function proxy(req, res, action, connection = null) {
    if (!/^ops:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(String(req.adminPrincipal?.subject || '')))
      return res.status(403).json({ error: 'Viewer workspace authorization is invalid', code: 'invalid_workspace_subject' });
    const supplied = req.body || {};
    if (connection === 'direct' && action === 'revoke') {
      if (Object.keys(supplied).some(key => key !== 'reason')) return invalid(res);
      supplied.grantId = req.params.grantId;
      if (supplied.reason === undefined) supplied.reason = 'Revoked by staff';
      if (typeof supplied.reason !== 'string' || /[\u0000-\u001f\u007f]/.test(supplied.reason)) return invalid(res);
    }
    const envelope = { subject: req.adminPrincipal.subject, action, ...(connection ? { connection } : {}) };
    if (connection === 'direct' && action === 'list') {
      const listQuery = directListQuery(req.query);
      if (!listQuery) return invalid(res);
      envelope.listQuery = listQuery;
    }
    if (action === 'create') {
      const grant = supplied.grant;
      if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return invalid(res);
      if (!IDEMPOTENCY_KEY.test(String(req.get('Idempotency-Key') || ''))) return invalid(res, 'valid Idempotency-Key is required');
      envelope.idempotencyKey = req.get('Idempotency-Key');
      if (connection === 'direct' && !validDirectGrantInput(grant)) return invalid(res);
      envelope.grant = grant;
    } else if (action === 'revoke') {
      if (!ID.test(String(supplied.grantId || '')) || typeof supplied.reason !== 'string' || !supplied.reason.trim() || supplied.reason.trim().length > 240)
        return invalid(res);
      if (!IDEMPOTENCY_KEY.test(String(req.get('Idempotency-Key') || ''))) return invalid(res, 'valid Idempotency-Key is required');
      envelope.idempotencyKey = req.get('Idempotency-Key');
      envelope.grantId = supplied.grantId;
      envelope.reason = supplied.reason.trim();
    }

    const requestId = randomUUID();
    res.set('X-LTDS-Client-Access-Request', requestId);
    let stage = 'configuration', upstreamStatus = null;
    const report = (status, code) => {
      // Fixed fields only: never include subjects, URLs, bodies, headers or
      // exception text, any of which can contain credentials or client data.
      try { diagnostic({ event: 'client_grant_proxy_failed', timestamp: new Date().toISOString(),
        requestId, action, stage, upstreamStatus, status, code }); } catch { /* Diagnostics must not change authorization or responses. */ }
    };
    try {
      const body = JSON.stringify(envelope);
      const url = new URL(REMOTE_PATH, config.opsAutomationBaseUrl);
      if (url.origin !== config.opsAutomationBaseUrl || url.pathname !== REMOTE_PATH || url.search || url.hash || url.username || url.password)
        throw new Error('invalid_destination');
      stage = 'signing';
      const signed = signViewerEvent({ secret: config.viewerEventSecret, keyId: config.viewerEventKeyId, method: 'POST', path: REMOTE_PATH, body });
      stage = 'request';
      const response = await fetchImpl(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: { ...signed, Accept: 'application/json', 'Content-Type': 'application/json' },
        body,
      });
      upstreamStatus = response.status;
      stage = 'response_headers';
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > 1024 * 1024) throw new Error('response_too_large');
      stage = 'response_body';
      const text = await response.text();
      if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('response_too_large');
      stage = 'response_json';
      let payload;
      try { payload = JSON.parse(text); } catch { throw new Error('invalid_response'); }
      if (!response.ok) {
        stage = 'upstream_rejection';
        const status = response.status >= 400 && response.status < 500 ? response.status : 502;
        report(status, 'operations_request_failed');
        if (connection === 'direct' && response.status >= 400 && response.status < 500
          && payload && typeof payload === 'object' && !Array.isArray(payload)
          && typeof payload.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(payload.code)
          && typeof payload.error === 'string' && payload.error.length > 0 && payload.error.length <= 500
          && !/[\u0000-\u001f\u007f]/.test(payload.error))
          return res.status(status).json({ error: payload.error, code: payload.code,
            ...(typeof payload.grantId === 'string' && ID.test(payload.grantId) ? { grantId: payload.grantId } : {}) });
        return res.status(status).json({ error: 'Operations rejected the client access request', code: 'operations_request_failed' });
      }
      stage = 'response_schema';
      if (!(connection === 'direct' ? validDirectSnapshot(payload, action) : connection === 'native' ? validNativeSnapshot(payload, action) : validSnapshot(payload))) throw new Error('invalid_response');
      return res.status(action === 'create' && !payload.replayed ? 201 : 200).json(payload);
    } catch {
      report(502, 'operations_unavailable');
      return res.status(502).json({ error: 'Operations client access service is unavailable', code: 'operations_unavailable' });
    }
  }

  return {
    mount(router) {
      const allowed = authorize('viewer.client_grants.manage');
      router.get(LOCAL_PATH, allowed, (req, res) => proxy(req, res, 'list'));
      router.post(LOCAL_PATH, allowed, (req, res) => proxy(req, res, 'create'));
      router.delete(LOCAL_PATH, allowed, (req, res) => proxy(req, res, 'revoke'));
      const directPath = '/api/v1/workspace/direct-client-grants';
      router.get(directPath, allowed, (req, res) => proxy(req, res, 'list', 'direct'));
      router.post(directPath, allowed, (req, res) => proxy(req, res, 'create', 'direct'));
      router.delete(`${directPath}/:grantId`, allowed, (req, res) => proxy(req, res, 'revoke', 'direct'));
      const nativePath = '/api/v1/workspace/native-client-grants';
      router.get(nativePath, allowed, (req, res) => proxy(req, res, 'list', 'native'));
      router.post(nativePath, allowed, (req, res) => proxy(req, res, 'create', 'native'));
      router.delete(nativePath, allowed, (req, res) => proxy(req, res, 'revoke', 'native'));
    },
  };
}

module.exports = { LOCAL_PATH, REMOTE_PATH, createClientGrantProxy };
