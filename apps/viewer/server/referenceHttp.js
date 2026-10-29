'use strict';

// Shared by the production mounting seam and the isolated Node/Python fixture.
// This handler grants no project/session access: every byte requires its own
// short-lived broker bearer. The caller owns the trusted TLS-termination policy.
const PREFIX = '/api/processing/reference/v1/objects/';
const OBJECT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
function json(res, status, error) {
  if (res.headersSent) { res.destroy(); return; }
  for (const name of ['content-length','content-range','accept-ranges','transfer-encoding']) res.removeHeader(name);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'no-referrer');
  res.end(JSON.stringify({error}));
}
function createReferenceBrokerHandler({broker, enabled = false,
  isProtectedTransport = req => req.socket?.encrypted === true} = {}) {
  if (typeof enabled !== 'boolean' || typeof isProtectedTransport !== 'function'
    || enabled && typeof broker?.readAuthorizedObject !== 'function') throw new Error('invalid reference broker configuration');
  return async function referenceBrokerHandler(req, res) {
    if (typeof req.url !== 'string' || !req.url.startsWith(PREFIX)) return false;
    if (!enabled) { json(res,404,'not_found'); return true; }
    // Never infer protected transport from caller-supplied Forwarded headers.
    if (isProtectedTransport(req) !== true) { json(res,503,'protected_transport_required'); return true; }
    const suffix = req.url.slice(PREFIX.length), queryIndex = suffix.indexOf('?');
    if (queryIndex !== -1) { json(res,400,'query_not_allowed'); return true; }
    if (!OBJECT.test(suffix)) { json(res,404,'not_found'); return true; }
    if (req.method !== 'GET') { json(res,405,'method_not_allowed'); return true; }
    if (req.aborted || req.destroyed && !req.complete) return true;
    let body;
    try {
      const response = await broker.readAuthorizedObject({objectId:suffix,
        authorization:req.headers?.authorization, method:req.method,
        range:req.headers?.range, query:{}});
      body = response.body;
      if (!body || typeof body.pipe !== 'function' || ![200,206].includes(response.status)) throw new Error('invalid broker response');
      const stop = () => { if (!body.destroyed) body.destroy(); };
      const requestClosed = () => { if (req.aborted || !req.complete) stop(); };
      const responseClosed = () => { if (!res.writableFinished) stop(); };
      const cleanup = () => {
        req.removeListener('aborted',stop); req.removeListener('close',requestClosed);
        res.removeListener('close',responseClosed); res.removeListener('error',stop);
      };
      body.once('close',cleanup);
      body.once('error',() => {
        // Do not return a source path, bearer, or raw filesystem exception.
        if (!res.headersSent) json(res,409,'source_unavailable');
        else res.destroy();
      });
      req.once('aborted',stop); req.once('close',requestClosed);
      res.once('close',responseClosed); res.once('error',stop);
      if (req.aborted || req.destroyed && !req.complete || res.destroyed) { stop(); return true; }
      res.statusCode = response.status;
      const headers = new Map(Object.entries(response.headers || {}).map(([key,value]) => [key.toLowerCase(),value]));
      for (const name of ['content-type','content-length','content-range','accept-ranges']) {
        const value = headers.get(name);
        if (value !== undefined) res.setHeader(name,value);
      }
      res.setHeader('cache-control','no-store');
      res.setHeader('referrer-policy','no-referrer');
      res.setHeader('x-content-type-options','nosniff');
      body.pipe(res);
      return true;
    } catch (error) {
      body?.destroy();
      const code = error?.code;
      if (code === 'UNAUTHORIZED' || code === 'OBJECT_NOT_GRANTED') json(res,401,'unauthorized');
      else if (code === 'INVALID_RANGE') json(res,416,'invalid_range');
      else if (code === 'TRANSFER_LIMIT') json(res,429,'transfer_limit');
      else if (['SOURCE_CHANGED','SOURCE_UNAVAILABLE','UNSAFE_SOURCE','SYMLINK_SOURCE'].includes(code)) json(res,409,'source_unavailable');
      else json(res,500,'reference_unavailable');
      return true;
    }
  };
}
module.exports = {createReferenceBrokerHandler, PREFIX};
