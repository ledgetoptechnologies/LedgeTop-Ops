import { z } from 'zod';

const handle = z.string().max(8192).regex(/^ond1_[A-Za-z0-9_-]+$/u);
const label = z.string().min(1).max(500).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const action = (suffix: 'preview' | 'download') => z.string().max(8300)
  .regex(new RegExp(`^/api/client/operations/data/files/ond1_[A-Za-z0-9_-]+/${suffix}$`, 'u')).nullable();
const file = z.object({ id: handle, name: label, size: z.number().int().nonnegative().refine(Number.isSafeInteger),
  uploadedAt: z.string().max(80), contentType: z.string().max(256).nullable(),
  kind: z.enum(['image', 'video', 'audio', 'pdf', 'text', 'other']),
  previewPath: action('preview'), thumbnailPath: z.null(), downloadPath: action('download'),
}).strict().superRefine((value, context) => {
  for (const suffix of ['preview', 'download'] as const) {
    const path = value[suffix === 'preview' ? 'previewPath' : 'downloadPath'];
    if (path !== null && path !== `/api/client/operations/data/files/${value.id}/${suffix}`)
      context.addIssue({ code: 'custom', message: 'File action does not match its selector' });
  }
});
const folder = z.object({ id: handle, name: label }).strict();
const uniqueSelectors = (values: { id: string }[]) => new Set(values.map(value => value.id)).size === values.length;
const discovery = z.object({ resourceMode: z.literal('operations_native_delivery'),
  items: z.array(z.object({ id: handle, displayName: label }).strict()).max(25),
  page: z.object({ nextCursor: handle.nullable() }).strict(),
}).strict().refine(value => uniqueSelectors(value.items), { message: 'Duplicate delivery selectors' });
const listing = z.object({ resourceMode: z.literal('operations_native_delivery'),
  files: z.array(file).max(25), folders: z.array(folder).max(25), breadcrumbs: z.array(folder).max(512),
  folderId: handle, prefix: z.literal(''), cursor: handle.nullable(),
}).strict().refine(value => value.files.length + value.folders.length <= 25)
  .refine(value => uniqueSelectors([...value.files, ...value.folders]), { message: 'Duplicate entry selectors' });

export type OperationsNativeDataDiscovery = z.infer<typeof discovery>;
export type OperationsNativeDataListing = z.infer<typeof listing>;
export type OperationsNativeDataFile = z.infer<typeof file>;
export const parseOperationsNativeDataDiscovery = (value: unknown) => discovery.safeParse(value);
export const parseOperationsNativeDataListing = (value: unknown) => listing.safeParse(value);

// Bounded by 25 entries and at most 512 path segments within the server's
// 1024-character relative path; allow their opaque selectors without truncation.
const MAX_BODY = 5 * 1024 * 1024;
function unavailable(status = 503) {
  return Object.assign(new Error('Shared data could not be verified. Please refresh or try again later.'), { status });
}
async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok) { await response.body?.cancel(); throw unavailable(response.status); }
  if (!/^application\/json(?:;|$)/iu.test(response.headers.get('Content-Type') ?? '')) {
    await response.body?.cancel(); throw unavailable();
  }
  const declared = response.headers.get('Content-Length');
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > MAX_BODY)) {
    await response.body?.cancel(); throw unavailable();
  }
  if (!response.body) throw unavailable();
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw unavailable(); }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { await reader.cancel().catch(() => undefined); throw unavailable(); }
  finally { reader.releaseLock(); }
}
const options = (signal?: AbortSignal): RequestInit => ({ signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
  headers: { Accept: 'application/json' } });
export async function loadOperationsNativeData(cursor?: string | null, signal?: AbortSignal): Promise<OperationsNativeDataDiscovery> {
  if (cursor !== undefined && cursor !== null && !handle.safeParse(cursor).success) throw unavailable(400);
  const value = await readBoundedJson(await fetch(`/api/client/operations/data/deliveries${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, options(signal)));
  const parsed = parseOperationsNativeDataDiscovery(value);
  if (!parsed.success) throw unavailable();
  return parsed.data;
}
export async function loadOperationsNativeFolder(folderId: string, cursor?: string | null, signal?: AbortSignal): Promise<OperationsNativeDataListing> {
  if (!handle.safeParse(folderId).success || (cursor !== undefined && cursor !== null && !handle.safeParse(cursor).success)) throw unavailable(400);
  const value = await readBoundedJson(await fetch(`/api/client/operations/data/folders/${encodeURIComponent(folderId)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, options(signal)));
  const parsed = parseOperationsNativeDataListing(value);
  if (!parsed.success || parsed.data.folderId !== folderId) throw unavailable();
  return parsed.data;
}
