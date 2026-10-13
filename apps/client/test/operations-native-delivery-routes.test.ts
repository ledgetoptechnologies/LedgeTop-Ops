import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeOperationsDeliveryContext } from '../src/worker/client-portal/operations-native-delivery-authorization';
import type { Env } from '../src/worker/types';
import { createOperationsNativeDeliveryRouter } from '../src/worker/client-portal/operations-native-delivery-routes';
import { encodeOperationsNativeDeliveryHandle, decodeOperationsNativeDeliveryHandle, type OperationsNativeDeliveryHandle }
  from '../src/worker/client-portal/operations-native-delivery-handles';

const { authorization, audit } = vi.hoisted(() => ({ authorization: vi.fn(), audit: vi.fn() }));
vi.mock('../src/worker/client-portal/operations-native-delivery-authorization', () => ({ authorizeNativeOperationsDelivery: authorization }));
vi.mock('../src/worker/client-portal/operations-native-content-audit', () => ({ appendOperationsNativeContentStart: audit }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const origin = 'https://client-staging.ledgetopdroneservices.com';
const principal = { issuer: 'https://synthetic.cloudflareaccess.com', subject: 'synthetic-person', email: 'synthetic@example.test' };
function context(): NativeOperationsDeliveryContext {
  return { requestFingerprint: 'c'.repeat(64), selectedR2Prefix: 'synthetic/photos/', command: {
    protocol: 'operations-portal-native-delivery-authority', protocolVersion: 1, permissionSchemaVersion: 3, action: 'delivery.grant',
    operationId: id(1), authority: { authorityId: id(2), expectedRevision: '0', resultingRevision: '1' },
    target: { targetId: id(3), targetRevision: '1', clientAuthorityId: id(4), workspaceId: 'synthetic-workspace', rootKind: 'standalone_client', rootRecordId: 'synthetic-client' },
    recipient: { recipientBindingId: id(5), enrollmentIntentId: id(6), targetClientRecordId: 'synthetic-client', issuer: principal.issuer, subject: principal.subject,
      homeOwnershipEpoch: '1', homeGrantRevision: '1', homeGrantOperationId: id(7), homeRequestFingerprint: 'a'.repeat(64) },
    publication: { operationId: id(8), publicationId: id(9), revision: '1', sourceSequence: '1', snapshotId: id(10), snapshotSha256: 'b'.repeat(64) },
    resource: { folderReservationId: id(11), folderReservationRevision: '1', clientFolderBindingId: 'synthetic-folder', externalProjectId: 'synthetic-project',
      projectVersion: '1', opsFolderProjectId: 'synthetic-physical-project', opsDivisionId: 'synthetic-division', selectedR2Prefix: 'synthetic/photos/',
      baseR2Prefix: 'synthetic/', baseMatchMethod: 'manual', baseConfirmedBy: 'synthetic-owner', baseConfirmedAt: new Date().toISOString() },
    features: ['folder.list', 'file.metadata', 'file.preview', 'file.download'], expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    reasonCode: 'synthetic', observedAt: new Date().toISOString() } };
}
function handle(kind: 'folder' | 'file' = 'folder'): OperationsNativeDeliveryHandle {
  return { v: 1, kind, authorityId: id(2), authorityRevision: '1', recipientBindingId: id(5), enrollmentIntentId: id(6), targetClientRecordId: 'synthetic-client',
    issuer: principal.issuer, subject: principal.subject, targetId: id(3), targetRevision: '1', clientAuthorityId: id(4), workspaceId: 'synthetic-workspace',
    homeOwnershipEpoch: '1', homeGrantRevision: '1', homeGrantOperationId: id(7), homeRequestFingerprint: 'a'.repeat(64),
    publicationId: id(9), publicationOperationId: id(8), publicationRevision: '1', publicationSourceSequence: '1', snapshotId: id(10), snapshotSha256: 'b'.repeat(64),
    folderReservationId: id(11), folderReservationRevision: '1', clientFolderBindingId: 'synthetic-folder', externalProjectId: 'synthetic-project', projectVersion: '1',
    path: kind === 'file' ? 'photo.jpg' : '', ...(kind === 'file' ? { etag: 'synthetic-etag' } : {}), expires: Date.now() + 600_000 };
}
const file = { r2_key: 'synthetic/photos/photo.jpg', etag: 'synthetic-etag', size: 42, uploaded_at: new Date().toISOString(), content_type: 'image/jpeg', media_kind: 'image' };
describe('native Operations folder HTTP routes', () => {
  let env: Env & { CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED?: string };
  let proof: NativeOperationsDeliveryContext;
  const prepare = vi.fn(), bind = vi.fn(), first = vi.fn(), all = vi.fn(), head = vi.fn(), get = vi.fn(), cancel = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks(); proof = context(); authorization.mockResolvedValue({ ok: true, context: proof });
    first.mockImplementation(async (column?: string) => column === 'name' ? 'Synthetic Project' : file);
    all.mockResolvedValue({ success: true, results: [{ entry_kind: 'file', entry_name: 'photo.jpg', ...file }, { entry_kind: 'folder', entry_name: 'nested' }] });
    bind.mockImplementation(() => ({ first, all })); prepare.mockImplementation(() => ({ bind }));
    audit.mockResolvedValue({ eventId: 'synthetic-event', occurredAt: new Date().toISOString(), replayed: false });
    head.mockResolvedValue({ etag: 'synthetic-etag', httpEtag: '"synthetic-etag"', size: 42 });
    get.mockImplementation(async (_key: string, options: { range?: { length: number } }) => ({ etag: 'synthetic-etag', size: 42,
      body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(options.range?.length ?? 42)); }, cancel }) }));
    // Isolated route fixture; real ledger predicates are exercised separately against D1.
    env = { CLIENT_PORTAL_ENABLED: 'true', CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED: 'true', ENVIRONMENT: 'staging',
      EXPECTED_HOST: 'delivery-staging.ledgetopdroneservices.com', CLIENT_PORTAL_ORIGIN: origin, DELIVERY_SESSION_SECRET: 's'.repeat(48),
      DELIVERY_DB: { withSession: () => ({ prepare }) }, DATA_BUCKET: { head, get } } as unknown as typeof env;
  });
  const request = (path: string, headers?: HeadersInit) => new Request(`${origin}${path}`, { headers });
  const router = () => createOperationsNativeDeliveryRouter({ resolvePrincipal: async () => principal });
  async function path(kind: 'folder' | 'file') {
    return `/${kind === 'folder' ? 'folders' : 'files'}/${await encodeOperationsNativeDeliveryHandle(env, handle(kind))}`;
  }
  it('is default-off and production-off before identity, ledger, index or R2 lookups', async () => {
    const resolvePrincipal = vi.fn(async () => principal), instance = createOperationsNativeDeliveryRouter({ resolvePrincipal });
    for (const override of [{ ENVIRONMENT: 'production' }, { CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED: undefined }, { CLIENT_PORTAL_ENABLED: 'false' }]) {
      const result = await instance.fetch(request('/deliveries'), { ...env, ...override });
      expect(result.status).toBe(404); expect(result.headers.get('Cache-Control')).toBe('private, no-store');
    }
    expect(resolvePrincipal).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(authorization).not.toHaveBeenCalled();
  });
  it('requires verified Client Access identity and the exact portal origin', async () => {
    expect((await createOperationsNativeDeliveryRouter({ resolvePrincipal: async () => null }).fetch(request('/deliveries'), env)).status).toBe(401);
    expect((await router().fetch(new Request('https://unrelated.test/deliveries'), env)).status).toBe(404);
    expect((await createOperationsNativeDeliveryRouter().fetch(request('/deliveries', { 'Cf-Access-Authenticated-User-Email': principal.email }), env)).status).toBe(503);
    expect(prepare).not.toHaveBeenCalled();
  });
  it('admits only the primary native portal and preserves the separate public delivery host', async () => {
    const resolvePrincipal = vi.fn(async () => principal);
    const instance = createOperationsNativeDeliveryRouter({ resolvePrincipal });
    const secondary = 'https://portal-staging.ledgetoptechnologies.com';
    env.CLIENT_PORTAL_ORIGINS = `${origin},${secondary}`;
    for (const host of ['https://delivery-staging.ledgetopdroneservices.com', secondary,
      'https://client.ledgetopdroneservices.com', 'http://client-staging.ledgetopdroneservices.com']) {
      expect((await instance.fetch(new Request(`${host}/deliveries`), env)).status).toBe(404);
    }
    for (const primary of [undefined, secondary, `${origin}/`]) {
      expect((await instance.fetch(request('/deliveries'), { ...env, CLIENT_PORTAL_ORIGIN: primary })).status).toBe(404);
    }
    expect(resolvePrincipal).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  });
  it('does not treat home-only permission or an encrypted selector as folder access', async () => {
    authorization.mockResolvedValue({ ok: false, code: 'denied' });
    expect((await router().fetch(request(await path('folder')), env)).status).toBe(404);
    expect(prepare).not.toHaveBeenCalled(); expect(head).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  });
  it('pages delivery discovery with an encrypted exact-person cursor and no raw authority ID', async () => {
    all.mockResolvedValueOnce({ success: true, results: Array.from({ length: 26 }, (_, n) => ({ authority_id: id(20 + n) })) });
    authorization.mockImplementation(async (_env, _principal, authorityId: string) => ({ ok: true,
      context: { ...proof, command: { ...proof.command, authority: { ...proof.command.authority, authorityId } } } }));
    const response = await router().fetch(request('/deliveries'), env);
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ id: string }>; page: { nextCursor: string } };
    expect(body.items).toHaveLength(25);
    expect(body.page.nextCursor).toMatch(/^ond1_/);
    expect(JSON.stringify(body)).not.toContain(id(44));
    const decoded = await decodeOperationsNativeDeliveryHandle(env, body.page.nextCursor);
    expect(decoded).toMatchObject({ kind: 'cursor', path: '', entryKind: 'delivery', after: id(44), authorityId: id(44) });
    all.mockResolvedValueOnce({ success: true, results: [{ authority_id: id(45) }] });
    const second = await router().fetch(request(`/deliveries?cursor=${encodeURIComponent(body.page.nextCursor)}`), env);
    expect(second.status).toBe(200);
    expect(bind.mock.calls.at(-2)?.slice(0, 3)).toEqual([principal.issuer, principal.subject, id(44)]);
    expect(await second.json()).toMatchObject({ items: [expect.any(Object)], page: { nextCursor: null } });
  });
  it('rejects folder cursors in discovery and discovery cursors in folder traversal', async () => {
    const folderCursor = await encodeOperationsNativeDeliveryHandle(env, { ...handle(), kind: 'cursor', after: 'nested', entryKind: 'folder' });
    expect((await router().fetch(request(`/deliveries?cursor=${encodeURIComponent(folderCursor)}`), env)).status).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
    const discoveryCursor = await encodeOperationsNativeDeliveryHandle(env, { ...handle(), kind: 'cursor', after: id(2), entryKind: 'delivery' });
    expect((await router().fetch(request(`${await path('folder')}?cursor=${encodeURIComponent(discoveryCursor)}`), env)).status).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
  });
  it('denies changed-person, modified-boundary or revoked discovery cursors before listing', async () => {
    for (const changes of [{ subject: 'another-person' }, { after: id(3) }]) {
      const cursor = await encodeOperationsNativeDeliveryHandle(env,
        { ...handle(), kind: 'cursor', after: id(2), entryKind: 'delivery', ...changes });
      expect((await router().fetch(request(`/deliveries?cursor=${encodeURIComponent(cursor)}`), env)).status).toBe(404);
    }
    authorization.mockResolvedValue({ ok: false, code: 'denied' });
    const cursor = await encodeOperationsNativeDeliveryHandle(env, { ...handle(), kind: 'cursor', after: id(2), entryKind: 'delivery' });
    expect((await router().fetch(request(`/deliveries?cursor=${encodeURIComponent(cursor)}`), env)).status).toBe(404);
    expect(prepare).not.toHaveBeenCalled(); expect(head).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  });
  it('lists only safe DTOs with opaque per-person handles and no storage prefixes', async () => {
    const result = await router().fetch(request(await path('folder')), env);
    expect(result.status).toBe(200); const body = await result.json() as { files: Array<{ id: string; name: string }>; folders: Array<{ id: string; name: string }>; prefix: string };
    expect(body.files[0]!.name).toBe('photo.jpg'); expect(body.folders[0]!.name).toBe('nested'); expect(body.prefix).toBe('');
    const wire = JSON.stringify(body); expect(wire).not.toContain('synthetic/photos/'); expect(wire).not.toContain(principal.subject); expect(wire).not.toContain('synthetic-etag');
    expect((await decodeOperationsNativeDeliveryHandle(env, body.files[0]!.id))?.path).toBe('photo.jpg');
    expect(authorization).toHaveBeenCalledTimes(3); expect(authorization.mock.calls.at(-1)?.[3]).toBe('file.metadata');
    expect(head).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
    expect(prepare.mock.calls[0]?.[0]).toContain('delivery_tombstones');
  });
  it('rechecks authority after index/label reads and suppresses the response after revocation', async () => {
    authorization.mockResolvedValueOnce({ ok: true, context: proof }).mockResolvedValue({ ok: false, code: 'denied' });
    const result = await router().fetch(request(await path('folder')), env);
    expect(result.status).toBe(404); expect(await result.text()).not.toContain('photo.jpg');
  });
  it('rejects another person before any ledger/index/storage lookup', async () => {
    const other = await encodeOperationsNativeDeliveryHandle(env, { ...handle(), subject: 'another-person' });
    expect((await router().fetch(request(`/folders/${other}`), env)).status).toBe(404);
    expect(authorization).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  });
  it('reads metadata only for the exact indexed key and pinned content version', async () => {
    const result = await router().fetch(request(await path('file')), env);
    expect(result.status).toBe(200); expect(authorization).toHaveBeenCalledTimes(2);
    expect(bind).toHaveBeenCalledWith('synthetic/photos/photo.jpg');
    first.mockResolvedValue({ ...file, etag: 'replaced-content' });
    expect((await router().fetch(request(await path('file')), env)).status).toBe(404);
    first.mockResolvedValue({ ...file, r2_key: 'another-client/photo.jpg' });
    expect((await router().fetch(request(await path('file')), env)).status).toBe(404);
    expect(head).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  });
  it('does not expose file metadata/action links to a folder-list-only recipient', async () => {
    proof = { ...proof, command: { ...proof.command, features: ['folder.list'] } }; authorization.mockResolvedValue({ ok: true, context: proof });
    const result = await router().fetch(request(await path('folder')), env), body = await result.json() as { files: unknown[]; folders: unknown[] };
    expect(result.status).toBe(200); expect(body.files).toEqual([]); expect(body.folders).toHaveLength(1);
  });
  it('rejects foreign cursors and invalid/tampered handles before file indexing', async () => {
    expect((await router().fetch(request('/folders/ond1_tampered'), env)).status).toBe(404);
    const cursor = await encodeOperationsNativeDeliveryHandle(env, { ...handle(), kind: 'cursor', path: 'other/' });
    expect((await router().fetch(request(`${await path('folder')}?cursor=${encodeURIComponent(cursor)}`), env)).status).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
  });
  it('denies private transport failures without a legacy or public-link fallback', async () => {
    authorization.mockResolvedValue({ ok: false, code: 'unavailable' });
    const result = await router().fetch(request(await path('file')), env);
    expect(result.status).toBe(503); expect(prepare).not.toHaveBeenCalled();
  });
  it('streams ranged downloads with conditional R2 acquisition and mandatory audit before final authorization', async () => {
    const result = await router().fetch(request(`${await path('file')}/download`, { Range: 'bytes=0-4' }), env);
    expect(result.status).toBe(206); expect(result.headers.get('Content-Range')).toBe('bytes 0-4/42');
    expect(result.headers.get('Content-Length')).toBe('5'); expect(result.headers.get('Cache-Control')).toBe('private, no-store');
    expect(result.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(get).toHaveBeenCalledWith(file.r2_key, { range: { offset: 0, length: 5 }, onlyIf: { etagMatches: 'synthetic-etag' } });
    expect(audit).toHaveBeenCalledWith(env, expect.objectContaining({ principal, feature: 'file.download', action: 'file.download_requested',
      storageKey: file.r2_key, contentVersion: file.etag }));
    expect(authorization).toHaveBeenCalledTimes(6);
    expect(audit.mock.invocationCallOrder[0]).toBeLessThan(authorization.mock.invocationCallOrder[5]!);
    // No buffering occurs in the handler; test releases the handed-off body.
    await result.body?.cancel();
  });
  it.each([2, 3, 4, 5, 6])('denies revocation at media authorization phase %s and cancels any acquired body', async phase => {
    let calls = 0; authorization.mockImplementation(async () => ++calls === phase ? { ok: false, code: 'denied' } : { ok: true, context: proof });
    const result = await router().fetch(request(`${await path('file')}/download`), env);
    expect(result.status).toBe(404);
    if (phase >= 5) expect(cancel).toHaveBeenCalledOnce(); else expect(get).not.toHaveBeenCalled();
  });
  it('cancels an acquired stream if mandatory audit is unavailable or the indexed content changed', async () => {
    audit.mockRejectedValue(new Error('missing private audit key'));
    const result = await router().fetch(request(`${await path('file')}/download`), env);
    expect(result.status).toBe(503); expect(cancel).toHaveBeenCalledOnce();
    audit.mockResolvedValue({ eventId: 'synthetic-event' }); cancel.mockClear();
    get.mockImplementationOnce(async () => {
      first.mockResolvedValue({ ...file, etag: 'replaced-content' });
      return { etag: 'synthetic-etag', size: 42, body: new ReadableStream({ cancel }) };
    });
    expect((await router().fetch(request(`${await path('file')}/download`), env)).status).toBe(404);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('keeps HEAD, 304 and invalid range handling authorized without acquiring/auditing bytes', async () => {
    const url = `${origin}${await path('file')}/download`;
    const response = await router().fetch(new Request(url, { method: 'HEAD', headers: { Range: 'bytes=0-4' } }), env);
    expect(response.status).toBe(206); expect(response.body).toBeNull();
    expect((await router().fetch(new Request(url, { headers: { 'If-None-Match': '"synthetic-etag"' } }), env)).status).toBe(304);
    const badRange = await router().fetch(new Request(url, { headers: { Range: 'bytes=900-999' } }), env);
    expect(badRange.status).toBe(416); expect(badRange.headers.get('Content-Range')).toBe('bytes */42');
    expect(get).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled();
  });
  it('ignores stale If-Range and requires safe preview MIME types', async () => {
    const result = await router().fetch(request(`${await path('file')}/download`, { Range: 'bytes=0-4', 'If-Range': '"old-etag"' }), env);
    expect(result.status).toBe(200); expect(get).toHaveBeenCalledWith(file.r2_key, { onlyIf: { etagMatches: 'synthetic-etag' } });
    await result.body?.cancel(); get.mockClear(); head.mockClear();
    first.mockResolvedValue({ ...file, content_type: 'text/html' });
    expect((await router().fetch(request(`${await path('file')}/preview`), env)).status).toBe(415);
    expect(head).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  });
});
