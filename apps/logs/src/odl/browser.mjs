// Browser entry for the OpenDroneLog importer. No Node or package imports: the caller passes the Parquet
// reader (hyparquet + hyparquet-compressors), and gzip is decoded with the built-in DecompressionStream.
import { checkContainer, isGzip, readTarArchive, OdlBackupError, MAX_BACKUP_BYTES } from './archive.mjs';
import { createOdlBackup } from './backup.mjs';

const tooLarge = () => new OdlBackupError('backup_too_large', 'The backup is larger than the importer accepts.');

// Decompress, counting expanded bytes as they arrive. A stream that would exceed `limit` is cancelled at that
// point, before any combined buffer is allocated, so a small file can't expand into unbounded memory.
async function gunzip(bytes, limit) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      let step;
      try { step = await reader.read(); } catch { throw new OdlBackupError('backup_corrupt', 'The backup could not be decompressed.'); }
      if (step.done) break;
      if (step.value.byteLength > limit - size) { await reader.cancel('backup_too_large').catch(() => {}); throw tooLarge(); }
      size += step.value.byteLength;
      chunks.push(step.value);
    }
  } finally { reader.releaseLock(); }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

/**
 * Opens a backup File/Blob or bytes in the browser. Sizes are checked before allocating: a Blob's declared
 * size before it is read, and the expanded gzip size while it streams. `maxBytes` defaults to the same
 * limit the Node importer uses; tests pass a small one.
 */
export async function openOdlBackupInBrowser(input, parquet, { maxBytes = MAX_BACKUP_BYTES } = {}) {
  const limit = Math.min(MAX_BACKUP_BYTES, maxBytes);
  if (input instanceof Blob && input.size > limit) throw tooLarge();
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input instanceof Blob ? await input.arrayBuffer() : input);
  if (bytes.length > limit) throw tooLarge();
  checkContainer(bytes);
  return createOdlBackup(readTarArchive(isGzip(bytes) ? await gunzip(bytes, limit) : bytes), parquet);
}

export { OdlBackupError } from './archive.mjs';
export { IMPORT_SCHEMA, TELEMETRY_COLUMNS } from './map.mjs';
export { DRY_RUN_SCHEMA, buildImport, dryRun, streamTelemetry, telemetryCounts } from './import.mjs';
