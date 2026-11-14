// TEMPORARY, read-only raw export of the Logs telemetry tracks, for the one-time copy to the NAS Logs host.
// Removed after the copy is verified (the infrastructure owner deploys, uses and deletes it; this repo holds no
// credentials or account resources).
//
// It answers exactly one thing: GET /telemetry/v1/<uuid>.json.gz, on one configured hostname, for one Access service
// identity (verified at the origin with the reviewed Access JWT verifier: exact issuer, audience and client id).
// Everything else is 404 before the bucket is touched: other methods, paths, query strings, hosts and identities.
// No listing, no other keys, no D1, no writes.
//
// The body is the object's stored bytes, streamed unchanged: never parsed, decompressed or re-compressed. It is sent
// as application/octet-stream WITHOUT Content-Encoding (even when the object was stored with contentEncoding gzip),
// with Cache-Control no-store, no-transform, so no client or proxy decodes it. The source size and ETag (an MD5 for
// single-part objects) are returned in headers so the receiver can prove the bytes are the originals.
import { accessKeyResolver, canonicalIssuer, verifyAccessService } from '../../logs-local/src/access-jwt.mjs';

const PATH = /^\/telemetry\/v1\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json\.gz$/;
const CLIENT_ID = /^[A-Za-z0-9._-]{8,256}$/;
const HOST = /^[a-z0-9.-]{1,253}$/;
const AUDIENCE = /^[A-Za-z0-9_-]{16,128}$/;
const validIssuer = issuer => { try { canonicalIssuer(issuer); return true; } catch { return false; } };

const notFound = () => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
const unavailable = () => new Response('Export not configured', { status: 503, headers: { 'Cache-Control': 'no-store' } });

/** Complete configuration or null (fail closed: never serve with a partial configuration). */
function configOf(env) {
  const { EXPORT_HOST: host, ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience, EXPORT_CLIENT_ID: clientId, EXPORT_BUCKET: bucket } = env ?? {};
  if (typeof host !== 'string' || !HOST.test(host) || !validIssuer(issuer) || typeof audience !== 'string' || !AUDIENCE.test(audience)
    || typeof clientId !== 'string' || !CLIENT_ID.test(clientId) || typeof bucket?.get !== 'function') return null;
  return { host, issuer, audience, clientId, bucket };
}

/** @param {{ fetch?: typeof fetch, now?: () => number }} [deps] for tests */
export function createExportWorker({ fetch: fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now } = {}) {
  const resolvers = new Map();
  const resolverFor = issuer => {
    if (!resolvers.has(issuer)) resolvers.set(issuer, accessKeyResolver(issuer, { fetch: fetchImpl, now }));
    return resolvers.get(issuer);
  };
  return {
    async fetch(request, env) {
      const config = configOf(env);
      if (!config) return unavailable();
      const url = new URL(request.url);
      // Shape first: nothing below is reached (no key fetch, no bucket) unless the request is exactly the one allowed.
      if (url.hostname !== config.host || request.method !== 'GET' || url.search || url.hash || !PATH.test(url.pathname)) {
        await request.body?.cancel().catch(() => {});
        return notFound();
      }
      let identity;
      try { identity = await verifyAccessService(request, { issuer: config.issuer, audience: config.audience }, resolverFor(config.issuer), { now }); }
      catch { return notFound(); }
      if (identity.clientId !== config.clientId) return notFound();
      const object = await config.bucket.get(url.pathname.slice(1));
      if (!object?.body) return notFound();
      const headers = new Headers({
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(object.size),
        'Cache-Control': 'no-store, no-transform',
        'X-Source-Size': String(object.size),
        'X-Source-Etag': String(object.etag),
      });
      // Informational only; never sent as Content-Encoding, so nothing decodes the body.
      if (object.httpMetadata?.contentEncoding) headers.set('X-Source-Content-Encoding', String(object.httpMetadata.contentEncoding).slice(0, 64));
      return new Response(object.body, { status: 200, headers });
    },
  };
}

export default createExportWorker();
