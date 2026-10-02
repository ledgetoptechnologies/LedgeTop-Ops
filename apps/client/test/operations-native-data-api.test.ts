import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadOperationsNativeData, loadOperationsNativeFolder, parseOperationsNativeDataDiscovery,
  parseOperationsNativeDataListing } from '../src/client/operations-native-data-api';

const handle = 'ond1_synthetic', fileHandle = 'ond1_file';
const file = { id: fileHandle, name: 'photo.jpg', size: 42, uploadedAt: '2026-09-30 12:00:00', contentType: 'image/jpeg',
  kind: 'image', previewPath: `/api/client/operations/data/files/${fileHandle}/preview`, thumbnailPath: null,
  downloadPath: `/api/client/operations/data/files/${fileHandle}/download` };
const listing = { resourceMode: 'operations_native_delivery', folderId: handle, prefix: '', cursor: null,
  files: [file], folders: [], breadcrumbs: [{ id: handle, name: 'Synthetic project' }] };
describe('native client data DTOs and bounded same-origin transport', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('accepts only the native opaque discovery/listing contract', () => {
    expect(parseOperationsNativeDataDiscovery({ resourceMode: 'operations_native_delivery', items: [{ id: handle, displayName: 'Project' }], page: { nextCursor: null } }).success).toBe(true);
    expect(parseOperationsNativeDataListing(listing).success).toBe(true);
    for (const change of [{ prefix: 'private/raw/' }, { authorityId: 'raw-id' }, { resourceMode: 'legacy' },
      { files: [{ ...file, id: 'raw-path' }] }, { files: [{ ...file, size: Number.MAX_SAFE_INTEGER + 1 }] }])
      expect(parseOperationsNativeDataListing({ ...listing, ...change }).success).toBe(false);
  });
  it('rejects cross-origin or mismatched action links, scripts, and extra private fields', () => {
    for (const change of [{ previewPath: 'https://foreign.test/image' }, { downloadPath: 'javascript:alert(1)' },
      { previewPath: '/api/client/operations/data/files/ond1_other/preview' }, { r2_key: 'private/raw/photo.jpg' }])
      expect(parseOperationsNativeDataListing({ ...listing, files: [{ ...file, ...change }] }).success).toBe(false);
  });
  it('rejects duplicate delivery and file/folder selectors without treating breadcrumbs as entries', () => {
    expect(parseOperationsNativeDataDiscovery({ resourceMode: 'operations_native_delivery',
      items: [{ id: handle, displayName: 'One' }, { id: handle, displayName: 'Two' }], page: { nextCursor: null } }).success).toBe(false);
    expect(parseOperationsNativeDataListing({ ...listing, files: [file, file] }).success).toBe(false);
    expect(parseOperationsNativeDataListing({ ...listing, folders: [{ id: fileHandle, name: 'Collision' }] }).success).toBe(false);
    expect(parseOperationsNativeDataListing({ ...listing, folders: [{ id: handle, name: 'Folder' }] }).success).toBe(true);
  });
  it('uses fixed same-origin routes, no-store, redirect denial and the caller abort signal', async () => {
    const fetcher = vi.fn(async () => Response.json(listing)); vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    expect(await loadOperationsNativeFolder(handle, null, controller.signal)).toEqual(listing);
    expect(fetcher).toHaveBeenCalledWith(`/api/client/operations/data/folders/${handle}`, expect.objectContaining({
      credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal }));
    await expect(loadOperationsNativeFolder('../bad')).rejects.toMatchObject({ status: 400 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('preserves authorization status without disclosing server error details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private server detail', { status: 403 })));
    await expect(loadOperationsNativeData()).rejects.toMatchObject({ status: 403 });
    await expect(loadOperationsNativeData()).rejects.not.toThrow('private server detail');
  });
  it('rejects a sign-in HTML response, oversized stream, malformed JSON or another folder', async () => {
    for (const response of [new Response('<html>login</html>'), new Response(' '.repeat(5 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }),
      new Response('{bad', { headers: { 'Content-Type': 'application/json' } }), Response.json({ ...listing, folderId: 'ond1_other' })]) {
      vi.stubGlobal('fetch', vi.fn(async () => response));
      await expect(loadOperationsNativeFolder(handle)).rejects.toMatchObject({ status: 503 });
    }
  });
});
