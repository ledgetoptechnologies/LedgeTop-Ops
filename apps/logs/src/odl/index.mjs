// Node entry for the OpenDroneLog importer.
import { gunzipSync } from 'node:zlib';
import { parquetMetadata, parquetSchema, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { readBackupArchive, MAX_BACKUP_BYTES } from './archive.mjs';
import { createOdlBackup } from './backup.mjs';

export const NODE_PARQUET = { parquetMetadata, parquetSchema, parquetReadObjects, compressors };

/** Opens backup bytes (gzip tar or plain tar). Throws OdlBackupError for unreadable input. */
export function openOdlBackup(input) {
  return createOdlBackup(readBackupArchive(input, bytes => gunzipSync(bytes, { maxOutputLength: MAX_BACKUP_BYTES })), NODE_PARQUET);
}

export { OdlBackupError, readBackupArchive, MAX_BACKUP_BYTES } from './archive.mjs';
export { createOdlBackup, OdlBackup, SecretValue } from './backup.mjs';
export { ODL_TABLES, validateLayout } from './schema.mjs';
export { IMPORT_SCHEMA, TELEMETRY_COLUMNS } from './map.mjs';
export { DRY_RUN_SCHEMA, buildImport, dryRun, streamTelemetry, telemetryCounts } from './import.mjs';
