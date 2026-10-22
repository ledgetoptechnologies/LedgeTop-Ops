import { parseContentRange } from './range-fetch.mjs';
import { validateRasterTiffHeader } from './raster-tiff-header.mjs';

// Bound header reads before GeoTIFF allocates arrays declared by the file.
// Refuse servers ignoring Range instead of buffering an entire raster.
export async function preflightBrowserRasterHeader(url, { signal, fetcher = fetch } = {}) {
  let total = null, first = null;
  const fail = () => new Error('The elevation source cannot be inspected with safe byte ranges. Ask an administrator to verify its TIFF metadata.');
  async function read(offset, length) {
    if (offset === 0 && length === 16 && first) return first;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 8192) throw fail();
    const response = await fetcher(url, { headers: { Range: `bytes=${offset}-${offset+length-1}` }, signal, credentials: 'same-origin', cache: 'no-store' });
    const range = parseContentRange(response.headers.get('content-range'));
    if (response.status !== 206 || !range || range.start !== offset || range.end !== offset+length-1 || (total !== null && range.total !== total)) {
      await response.body?.cancel(); throw fail();
    }
    total = range.total;
    const reader = response.body?.getReader();
    if (!reader) throw fail();
    const bytes = new Uint8Array(length); let used = 0;
    try {
      while (true) {
        const {value,done} = await reader.read();
        if (done) break;
        if (used + value.byteLength > length) throw fail();
        bytes.set(value,used); used += value.byteLength;
      }
      if (used !== length) throw fail();
    } catch (error) { try { await reader.cancel(); } catch {} throw error; }
    finally { reader.releaseLock(); }
    return bytes;
  }
  first = await read(0,16);
  try { await validateRasterTiffHeader(read,total); }
  catch (error) { if (error.name === 'AbortError') throw error; throw fail(); }
}
