// Browser entry for the OpenDroneLog importer. No Node or package imports: the caller passes the Parquet
// reader (hyparquet + hyparquet-compressors), and gzip is decoded with the built-in DecompressionStream.
import { checkContainer, isGzip, readTarArchive, OdlBackupError } from './archive.mjs';
import { createOdlBackup } from './backup.mjs';

async function gunzip(bytes) {
  try { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()); }
  catch { throw new OdlBackupError('backup_corrupt', 'The backup could not be decompressed.'); }
}

/** Opens a backup File/Blob or bytes in the browser. */
export async function openOdlBackupInBrowser(input, parquet) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input instanceof Blob ? await input.arrayBuffer() : input);
  checkContainer(bytes);
  return createOdlBackup(readTarArchive(isGzip(bytes) ? await gunzip(bytes) : bytes), parquet);
}

export { OdlBackupError } from './archive.mjs';
export { IMPORT_SCHEMA, TELEMETRY_COLUMNS } from './map.mjs';
export { DRY_RUN_SCHEMA, buildImport, dryRun, streamTelemetry, telemetryCounts } from './import.mjs';
