// Opens an OpenDroneLog backup and reads its tables. Nothing here writes anywhere.
import { parquetMetadata, parquetSchema, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { readBackupArchive, OdlBackupError } from './archive.mjs';
import { ODL_TABLES, validateLayout } from './schema.mjs';

const arrayBufferOf = view => view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);

/**
 * A per-log DJI decryption key. The value is reachable only through reveal(); logging, JSON and
 * string conversion all print "[redacted]" so it cannot leak through reports or console output.
 */
export class SecretValue {
  #value;
  constructor(value) { this.#value = value; }
  reveal() { return this.#value; }
  toJSON() { return '[redacted]'; }
  toString() { return '[redacted]'; }
  [Symbol.for('nodejs.util.inspect.custom')]() { return '[redacted]'; }
}

/** Opens backup bytes. Throws OdlBackupError for unreadable input; layout problems are returned in `validation`. */
export function openOdlBackup(input) {
  const files = readBackupArchive(input), tables = new Map();
  for (const [name, view] of files) {
    if (!name.endsWith('.parquet')) continue;
    const key = name.split('/').pop();
    try {
      const buffer = arrayBufferOf(view), metadata = parquetMetadata(buffer);
      const columns = parquetSchema(metadata).children.map(child => child.element.name);
      tables.set(key, { buffer, metadata, columns, rowCount: Number(metadata.num_rows) });
    } catch { throw new OdlBackupError('backup_corrupt', `${key} in the backup could not be read.`); }
  }
  const validation = validateLayout(new Map([...tables].map(([name, table]) => [name, table.columns])));
  return new OdlBackup(tables, validation);
}

export class OdlBackup {
  constructor(tables, validation) { this.tables = tables; this.validation = validation; }

  get ok() { return this.validation.errors.length === 0; }

  /** File names and row counts, for reports. */
  summary() { return [...this.tables].map(([name, table]) => ({ name, rows: table.rowCount })); }

  has(name) { return this.tables.has(name); }

  /** Reads a whole small table as row objects (all tables except telemetry are small). */
  async rows(name, columns) {
    const table = this.tables.get(name);
    if (!table) return [];
    const wanted = columns ? columns.filter(column => table.columns.includes(column)) : undefined;
    return parquetReadObjects({ file: table.buffer, compressors, columns: wanted });
  }

  /** Keychains for the parser only. Values are wrapped in SecretValue. */
  async keychains() {
    const rows = await this.rows('keychains.parquet', ['file_hash', 'encryption_key', 'fetched_at']);
    return rows.filter(row => row.file_hash && row.encryption_key)
      .map(row => ({ fileHash: String(row.file_hash), key: new SecretValue(String(row.encryption_key)), fetchedAt: toIso(row.fetched_at) }));
  }

  /** Row ranges of each telemetry row group, so callers can stream without loading 8M rows at once. */
  telemetryRowGroups() {
    const table = this.tables.get('telemetry.parquet');
    if (!table) return [];
    let start = 0;
    return table.metadata.row_groups.map(group => { const rows = Number(group.num_rows), range = { start, end: start + rows }; start += rows; return range; });
  }

  async telemetryRows(columns, { start, end }) {
    const table = this.tables.get('telemetry.parquet');
    const wanted = columns.filter(column => table.columns.includes(column));
    return parquetReadObjects({ file: table.buffer, compressors, columns: wanted, rowStart: start, rowEnd: end });
  }
}

export function toIso(value) {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'bigint') return new Date(Number(value / 1000n)).toISOString(); // microseconds
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export { ODL_TABLES };
