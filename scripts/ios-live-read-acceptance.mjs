import { pathToFileURL } from 'node:url';

// This QA target does not populate any Worker/native admission gate. The
// integration owner must verify and activate the reviewed staging candidate.
export const PILOT_ORIGIN = 'https://ledge-top-ios-edge-staging.ledge-top-staging.workers.dev';
const PREFIX = '/mobile-pilot/v1/';
const MAX_BYTES = 1_048_576;
const MAX_PAGES = 10;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value)
  && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  && !/[\u0000-\u001f\u007f]/u.test(value);
const cursorValid = value => value === null || typeof value === 'string' && /^[A-Za-z0-9_-]{1,4096}$/.test(value);

export class AcceptanceFailure extends Error {
  constructor(code) { super(code); this.name = 'AcceptanceFailure'; this.code = code; }
}
function requireThat(condition, code) { if (!condition) throw new AcceptanceFailure(code); }

async function readJSON(response) {
  requireThat(response.status === 200, `http_${Number.isInteger(response.status) ? response.status : 'invalid'}`);
  requireThat(response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json', 'content_type');
  requireThat(response.headers.get('cache-control')?.split(',').some(part => part.trim().toLowerCase() === 'no-store'), 'cache_policy');
  const advertised = response.headers.get('content-length');
  requireThat(advertised === null || /^\d+$/.test(advertised) && Number(advertised) <= MAX_BYTES, 'response_size');
  requireThat(response.body && typeof response.body.getReader === 'function', 'response_body');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      requireThat(bytes <= MAX_BYTES, 'response_size');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
  catch { throw new AcceptanceFailure('response_json'); }
}

function rootValid(root) {
  return keys(root, ['sourceId', 'rootNamespace', 'kind', 'clientHubRootId', 'name'])
    && root.sourceId === 'project-alpha:primary' && root.rootNamespace === 'business'
    && ['organization', 'standalone_client'].includes(root.kind)
    && text(root.clientHubRootId, 512) && !['.', '..'].includes(root.clientHubRootId) && text(root.name, 512);
}
function projectValid(project) {
  return keys(project, ['id', 'origin', 'name', 'status', 'startDate', 'endDate'])
    && text(project.id, 512) && ['pa', 'canonical'].includes(project.origin) && text(project.name, 512)
    && [project.status === null || text(project.status, 128),
      project.startDate === null || text(project.startDate, 64), project.endDate === null || text(project.endDate, 64)].every(Boolean);
}

/** Performs GETs only. It returns counts/booleans, never records or credentials.
 * fetchImpl is for offline tests; the CLI always uses Node's built-in fetch.
 * A passing result proves the observed read path, not device UX, write denial,
 * refresh-token revocation, or a cross-request atomic data snapshot. */
export async function verifyLivePilot({ bearer, fetchImpl = globalThis.fetch } = {}) {
  requireThat(typeof bearer === 'string' && bearer.length <= 16_384
    && /^[A-Za-z0-9._~+/-]+=*$/.test(bearer), 'credential_format');
  const signal = AbortSignal.timeout(60_000);
  async function get(path, cursor = null) {
    const url = new URL(PREFIX + path, PILOT_ORIGIN);
    if (cursor !== null) url.searchParams.set('cursor', cursor);
    let response;
    try {
      response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', credentials: 'omit',
        referrerPolicy: 'no-referrer', cache: 'no-store', signal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${bearer}` } });
    } catch { throw new AcceptanceFailure('network_or_redirect'); }
    try {
      requireThat(!response.redirected && (!response.url || response.url === url.href), 'response_origin');
      return await readJSON(response);
    }
    catch (error) {
      if (error instanceof AcceptanceFailure) throw error;
      throw new AcceptanceFailure('response_transport');
    } finally {
      // Also release bodies rejected before the streaming reader was acquired.
      if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }
  const session = await get('session');
  requireThat(keys(session, ['schemaVersion', 'readOnly', 'user', 'expiresAt']) && session.schemaVersion === 1
    && session.readOnly === true && Number.isSafeInteger(session.expiresAt)
    && session.expiresAt * 1000 > Date.now()
    && keys(session.user, ['id', 'displayName', 'email']) && text(session.user.id, 4096)
    && text(session.user.displayName, 4096) && text(session.user.email, 4096), 'session_contract');

  async function pages(path, collection, valid, idOf, selectFirst) {
    const seenCursors = new Set(), seenRows = new Set();
    let cursor = null, first, count = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await get(path, cursor);
      requireThat(keys(body, ['schemaVersion', collection, 'nextCursor']) && body.schemaVersion === 1
        && Array.isArray(body[collection]) && body[collection].length <= 20
        && body[collection].every(valid) && cursorValid(body.nextCursor), `${collection}_contract`);
      for (const row of body[collection]) {
        const id = idOf(row);
        requireThat(!seenRows.has(id), `${collection}_duplicate`);
        seenRows.add(id);
        if (!first && selectFirst) first = selectFirst(row);
        count++;
      }
      if (body.nextCursor === null) return { count, pageCount: page, first };
      requireThat(!seenCursors.has(body.nextCursor), `${collection}_cursor_repeated`);
      seenCursors.add(body.nextCursor);
      cursor = body.nextCursor;
    }
    throw new AcceptanceFailure(`${collection}_page_limit`);
  }
  const roots = await pages('business-roots', 'roots', rootValid,
    root => `${root.sourceId}|${root.rootNamespace}|${root.kind}|${root.clientHubRootId}`,
    root => ({ kind: root.kind, id: root.clientHubRootId }));
  requireThat(roots.count > 0, 'no_visible_business_records');
  const projects = await pages(`business-roots/${roots.first.kind}/${encodeURIComponent(roots.first.id)}/projects`,
    'projects', projectValid, project => project.id);
  requireThat(session.expiresAt * 1000 > Date.now(), 'session_expired_during_check');
  return { schemaVersion: 1, target: 'dedicated-staging-ios-edge', readOnlySession: true,
    nonemptyBusinessDirectory: true, rootCount: roots.count, rootPages: roots.pageCount,
    selectedRootProjectsRead: true, projectCount: projects.count, projectPages: projects.pageCount };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    requireThat(process.argv.length === 2, 'arguments_not_supported');
    const bearer = process.env.LT_IOS_ACCEPTANCE_BEARER;
    delete process.env.LT_IOS_ACCEPTANCE_BEARER;
    console.log(JSON.stringify(await verifyLivePilot({ bearer })));
  } catch (error) {
    // Never print a provider body, credential, URL/cursor or raw network error.
    console.error(JSON.stringify({ ok: false, code: error instanceof AcceptanceFailure ? error.code : 'acceptance_failed' }));
    process.exitCode = 1;
  }
}
