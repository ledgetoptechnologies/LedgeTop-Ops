const DEFAULT_CHUNK_SIZE = 16 * 1024 * 1024;

export function parseContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(value || '').trim());
  if (!match) return null;
  const start = Number(match[1]), end = Number(match[2]), total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || end >= total) return null;
  return { start, end, total };
}

function rangeError(message, status = null) {
  const error = new Error(message);
  error.code = 'asset_range_failed';
  if (status !== null) error.status = status;
  return error;
}

function assetTooLarge(total, maxBytes) {
  const error = new Error('Asset exceeds the safe browser download limit');
  error.code = 'asset_too_large';
  error.total = total;
  error.maxBytes = maxBytes;
  return error;
}

async function responseBytes(response, maxBytes = Infinity) {
  const contentLength = response.headers.get('content-length');
  const declared = contentLength === null ? Number.NaN : Number(contentLength);
  if (Number.isSafeInteger(declared) && declared > maxBytes) throw assetTooLarge(declared, maxBytes);
  if (Number.isSafeInteger(declared) && declared >= 0) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw assetTooLarge(bytes.byteLength, maxBytes);
    return bytes;
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw assetTooLarge(bytes.byteLength, maxBytes);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('asset exceeds safe browser download limit');
        throw assetTooLarge(total, maxBytes);
      }
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* response is already closed */ }
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function readRange(fetchImpl, url, start, end, signal, maxResponseBytes) {
  const response = await fetchImpl(url, {
    headers: { Range: `bytes=${start}-${end}` },
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (response.status !== 200 && response.status !== 206) {
    throw rangeError(`Asset request failed (${response.status})`, response.status);
  }
  const bytes = await responseBytes(response, maxResponseBytes);
  return { response, bytes };
}

// Large managed assets are integrity-checked by the API in fixed chunks before
// bytes are released. Fetching the GLB in bounded ranges prevents one long,
// silent, full-file verification from exceeding a reverse-proxy timeout.
export async function fetchAssetArrayBufferByRange(url, {
  fetchImpl = globalThis.fetch,
  chunkSize = DEFAULT_CHUNK_SIZE,
  signal = null,
  onProgress = () => {},
  onMetadata = () => {},
  maxBytes = Infinity,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new TypeError('chunkSize must be a positive safe integer');
  if (maxBytes !== Infinity && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) throw new TypeError('maxBytes must be a positive safe integer');

  const first = await readRange(fetchImpl, url, 0, chunkSize - 1, signal, maxBytes);
  if (first.response.status === 200) {
    onMetadata(first.bytes.byteLength);
    onProgress(first.bytes.byteLength, first.bytes.byteLength);
    return first.bytes.buffer;
  }

  const initialRange = parseContentRange(first.response.headers.get('content-range'));
  if (!initialRange || initialRange.start !== 0 || first.bytes.byteLength !== initialRange.end + 1) {
    throw rangeError('Asset server returned an invalid initial byte range');
  }
  onMetadata(initialRange.total);
  if (initialRange.total > maxBytes) throw assetTooLarge(initialRange.total, maxBytes);
  const output = new Uint8Array(initialRange.total);
  output.set(first.bytes, 0);
  let offset = initialRange.end + 1;
  onProgress(offset, initialRange.total);

  while (offset < initialRange.total) {
    const requestedEnd = Math.min(initialRange.total - 1, offset + chunkSize - 1);
    const part = await readRange(fetchImpl, url, offset, requestedEnd, signal, requestedEnd - offset + 1);
    if (part.response.status !== 206) throw rangeError('Asset server stopped honoring byte ranges', part.response.status);
    const contentRange = parseContentRange(part.response.headers.get('content-range'));
    if (!contentRange || contentRange.total !== initialRange.total || contentRange.start !== offset
      || contentRange.end !== requestedEnd || part.bytes.byteLength !== requestedEnd - offset + 1) {
      throw rangeError('Asset server returned an inconsistent byte range');
    }
    output.set(part.bytes, offset);
    offset = contentRange.end + 1;
    onProgress(offset, initialRange.total);
  }
  return output.buffer;
}

export { DEFAULT_CHUNK_SIZE };
