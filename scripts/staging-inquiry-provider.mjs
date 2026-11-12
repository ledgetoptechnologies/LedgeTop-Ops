import { createHash } from 'node:crypto';

// Fixed-target Cloudflare adapter for the staging inquiry successor. All
// credentials and transport are injected by the caller; this module never
// discovers accounts, retries mutations, or exposes response bodies in errors.
const ACCOUNT = '846c924bf17bf4f3dd15c97a4c5d1d51';
const WORKER = 'ledgetop-ops-staging';
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
const BASE = `/workers/scripts/${WORKER}`;
const UPLOAD = `${BASE}/versions?bindings_inherit=strict`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_RESPONSE = 32 * 1024 * 1024;
const MAX_UPLOAD = 16 * 1024 * 1024;
const need = (ok, code) => { if (!ok) throw new Error(code); };
const digestBindings = rows => createHash('sha256').update(JSON.stringify([...rows].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0))).digest('hex');

export function createStagingInquiryProvider({ token, fetchImpl = fetch, now = () => new Date() }) {
  need(typeof token === 'string' && token.length > 0 && token.length <= 16_384
    && !/[\s\x00-\x1f\x7f]/u.test(token), 'staging_inquiry_provider_credential_invalid');
  need(typeof fetchImpl === 'function' && typeof now === 'function', 'staging_inquiry_provider_dependencies_invalid');

  async function request(method, path, body, contentType) {
    need(method === 'GET' && (path === `${BASE}/deployments?per_page=1` || /^\/workers\/scripts\/ledgetop-ops-staging\/versions\?per_page=100(?:&page=[1-9][0-9]*)?$/u.test(path)
      || new RegExp(`^${BASE}/versions/[0-9a-f-]{36}$`, 'iu').test(path)) || method === 'POST' && path === UPLOAD,
    'staging_inquiry_provider_path_refused');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let response;
    try {
      response = await fetchImpl(`${API}${path}`, { method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(contentType ? { 'Content-Type': contentType } : {}) },
        ...(body === undefined ? {} : { body }) });
      need(response && Number.isInteger(response.status) && response.body
        && typeof response.body.getReader === 'function', 'staging_inquiry_provider_response_invalid');
      const length = response.headers?.get?.('content-length');
      need(length === null || length === undefined || /^\d+$/u.test(length) && Number(length) <= MAX_RESPONSE,
        'staging_inquiry_provider_response_too_large');
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        need(part.value instanceof Uint8Array, 'staging_inquiry_provider_response_invalid');
        size += part.value.byteLength;
        if (size > MAX_RESPONSE) { try { await reader.cancel(); } catch { /* best effort */ } throw new Error('staging_inquiry_provider_response_too_large'); }
        chunks.push(Buffer.from(part.value));
      }
      return { httpStatus: response.status, rawResponseBytes: Buffer.concat(chunks, size) };
    } catch {
      throw new Error('staging_inquiry_provider_request_uncertain');
    } finally { clearTimeout(timer); }
  }
  async function get(path) {
    const raw = await request('GET', path);
    let envelope;
    try { envelope = JSON.parse(raw.rawResponseBytes.toString('utf8')); } catch { throw new Error('staging_inquiry_provider_json_invalid'); }
    need(raw.httpStatus >= 200 && raw.httpStatus < 300 && envelope?.success === true && envelope.result,
      'staging_inquiry_provider_read_failed');
    return { result: envelope.result, resultInfo: envelope.result_info };
  }
  async function readVersionList() {
    const first = await get(`${BASE}/versions?per_page=100&page=1`);
    const firstItems = first.result.items, info = first.resultInfo;
    need(Array.isArray(firstItems) && info?.page === 1 && info?.per_page === 100
      && info.count === firstItems.length && Number.isSafeInteger(info.total_count)
      && info.total_count >= 1 && info.total_count <= 1000,
    'staging_inquiry_provider_inventory_incomplete');
    const pageCount = Math.ceil(info.total_count / 100);
    need(pageCount <= 10, 'staging_inquiry_provider_inventory_unbounded');
    const all = [...firstItems];
    for (let page = 2; page <= pageCount; page++) {
      const next = await get(`${BASE}/versions?per_page=100&page=${page}`);
      const expectedCount = Math.min(100, info.total_count - (page - 1) * 100);
      need(next.resultInfo?.page === page && next.resultInfo?.per_page === 100
        && next.resultInfo?.total_count === info.total_count && next.resultInfo?.count === expectedCount
        && Array.isArray(next.result.items) && next.result.items.length === expectedCount,
      'staging_inquiry_provider_inventory_changed');
      all.push(...next.result.items);
    }
    need(all.length === info.total_count && all.every(row => UUID.test(row?.id ?? '')
      && Number.isFinite(Date.parse(row.metadata?.created_on ?? '')))
      && new Set(all.map(row => row.id)).size === all.length,
    'staging_inquiry_provider_inventory_invalid');
    const rows = all.map(row => ({ id: row.id, created_on: row.metadata.created_on }));
    for (let i = 1; i < rows.length; i++) need(Date.parse(rows[i - 1].created_on) > Date.parse(rows[i].created_on),
      'staging_inquiry_provider_inventory_order_invalid');
    return rows;
  }
  async function snapshot({ candidateId } = {}) {
    const observedAt = now().toISOString();
    const [deploymentResult, rows] = await Promise.all([
      get(`${BASE}/deployments?per_page=1`), readVersionList()
    ]);
    const deployments = deploymentResult.result.deployments;
    need(Array.isArray(deployments) && deployments.length === 1 && Array.isArray(rows)
      && rows.length > 0 && rows.length <= 1000,
    'staging_inquiry_provider_inventory_incomplete');
    const deployment = deployments[0], newestId = rows[0]?.id;
    need(!candidateId || newestId === candidateId, 'staging_inquiry_provider_candidate_not_newest');
    need(Array.isArray(deployment.versions), 'staging_inquiry_provider_inventory_invalid');
    const activeId = deployment.versions.find(row => row.percentage === 100)?.version_id;
    const zeroId = deployment.versions.find(row => row.percentage === 0)?.version_id;
    need(UUID.test(activeId ?? '') && UUID.test(zeroId ?? '') && activeId !== zeroId
      && rows.some(row => row.id === zeroId) && (candidateId || zeroId === newestId),
    'staging_inquiry_provider_deployment_shape_invalid');
    const [activeVersion, pinnedZeroPercentVersion] = await Promise.all([
      get(`${BASE}/versions/${activeId}`), get(`${BASE}/versions/${zeroId}`)
    ]);
    need(pinnedZeroPercentVersion.result?.id === zeroId && activeVersion.result?.id === activeId,
      'staging_inquiry_provider_readback_mismatch');
    const pinnedVersion = pinnedZeroPercentVersion.result;
    const latestVersion = pinnedVersion;
    const pin = { deploymentId: deployment.id, activeVersionId: activeId, latestVersionId: zeroId,
      bindingsSha256: digestBindings(pinnedVersion.resources?.bindings ?? []) };
    return { accountId: ACCOUNT, workerName: WORKER, observedAt, deployment, latestVersion,
      pinnedZeroPercentVersion: pinnedVersion, pin, versionList: { complete: true, observedAt, rows } };
  }
  return Object.freeze({
    readFence: async () => {
      const fence = await snapshot();
      return fence;
    },
    postVersion: async ({ path, body, contentType }) => {
      need(path === UPLOAD && Buffer.isBuffer(body) && body.length > 0 && body.length <= MAX_UPLOAD
        && typeof contentType === 'string' && contentType.startsWith('multipart/form-data;'),
      'staging_inquiry_provider_upload_invalid');
      // Exactly one fetch call. Any exception is ambiguous; callers must hold.
      return request('POST', path, body, contentType);
    },
    readCandidate: async candidateId => {
      need(UUID.test(candidateId ?? ''), 'staging_inquiry_provider_candidate_invalid');
      const [fence, candidate] = await Promise.all([snapshot({ candidateId }), get(`${BASE}/versions/${candidateId}`)]);
      return { fence, versionList: fence.versionList, candidateVersion: candidate.result };
    },
  });
}
