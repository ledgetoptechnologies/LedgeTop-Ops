// Reads an OpenDroneLog backup container: a gzip-compressed tar of Parquet files.
// The backup's file name says ".db.backup", but it is not a database file.
import { gunzipSync } from 'node:zlib';

const BLOCK = 512;
export const MAX_BACKUP_BYTES = 4 * 1024 ** 3; // refuse anything absurd before allocating

/** Thrown for any backup that cannot be read; `code` is stable for UI wording. */
export class OdlBackupError extends Error {
  constructor(code, message) { super(message); this.name = 'OdlBackupError'; this.code = code; }
}

function text(bytes, start, length) {
  const slice = bytes.subarray(start, start + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end));
}

function octal(bytes, start, length) {
  const value = text(bytes, start, length).trim();
  if (!/^[0-7]*$/.test(value)) throw new OdlBackupError('backup_corrupt', 'The backup archive has an unreadable entry size.');
  return value ? parseInt(value, 8) : 0;
}

function isZeroBlock(bytes, offset) {
  for (let i = offset; i < offset + BLOCK; i++) if (bytes[i] !== 0) return false;
  return true;
}

/** Extracts regular files from an uncompressed tar. Returns Map<name, Uint8Array view>. */
export function untar(bytes) {
  const files = new Map();
  let offset = 0, longName = null;
  while (offset + BLOCK <= bytes.length) {
    if (isZeroBlock(bytes, offset)) break;
    const size = octal(bytes, offset + 124, 12), type = String.fromCharCode(bytes[offset + 156] || 48);
    const magic = text(bytes, offset + 257, 6), prefix = magic.startsWith('ustar') ? text(bytes, offset + 345, 155) : '';
    let name = longName ?? (prefix ? `${prefix}/${text(bytes, offset, 100)}` : text(bytes, offset, 100));
    longName = null;
    const dataStart = offset + BLOCK, dataEnd = dataStart + size;
    if (dataEnd > bytes.length) throw new OdlBackupError('backup_truncated', 'The backup archive ends part-way through a file.');
    if (type === 'L') longName = text(bytes, dataStart, size);                 // GNU long name for the next entry
    else if (type === '0' || type === '\0' || type === '7') {
      name = name.replace(/^\.\//, '');
      if (name.includes('..') || name.startsWith('/')) throw new OdlBackupError('backup_unsafe_path', 'The backup archive contains an unsafe path.');
      files.set(name, bytes.subarray(dataStart, dataEnd));
    }                                                                           // pax headers, directories and links are ignored
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}

/** Opens backup bytes (gzip tar or plain tar) and returns its files. */
export function readBackupArchive(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > MAX_BACKUP_BYTES) throw new OdlBackupError('backup_too_large', 'The backup is larger than the importer accepts.');
  if (bytes.length >= 4 && bytes[0] === 0x53 && bytes[1] === 0x51 && bytes[2] === 0x4c && bytes[3] === 0x69)
    throw new OdlBackupError('backup_unsupported_sqlite', 'This looks like an SQLite database, not an OpenDroneLog backup. Export a backup from OpenDroneLog instead.');
  let tar = bytes;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try { tar = new Uint8Array(gunzipSync(bytes, { maxOutputLength: MAX_BACKUP_BYTES })); }
    catch { throw new OdlBackupError('backup_corrupt', 'The backup could not be decompressed.'); }
  }
  if (tar.length < BLOCK || !text(tar, 257, 6).startsWith('ustar') && !text(tar, 0, 100).endsWith('.parquet'))
    throw new OdlBackupError('backup_not_odl', 'This file is not an OpenDroneLog backup.');
  return untar(tar);
}
