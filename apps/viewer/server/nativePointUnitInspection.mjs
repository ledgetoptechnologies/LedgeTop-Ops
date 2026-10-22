import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { inspectEptUtmCrs, resolveEptVerticalUnits } from './measurementEptCrs.mjs';

// LAS 1.4-R15 sections 2.4, 2.5, 2.7 and 3:
// https://www.asprs.org/wp-content/uploads/2021/04/LAS_latest.pdf
// GeoTIFF key/unit definitions: https://docs.ogc.org/is/19-008r4/19-008r4.html
// Intentionally supports LAS 1.2–1.4 (including LAZ headers), WGS84 UTM only.
// Point bytes are hashed but never decoded. This is metadata evidence, not a
// validation of compressed point records, a producer receipt, or datum proof.
const fail = (code = 'native_point_metadata_invalid') => {
  throw Object.assign(new Error(code), { code });
};
const changed = () => fail('source_changed');
const identity = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
const specs = new Map([[9001, [1, 'm']], [9002, [.3048, 'ft']], [9003, [1200 / 3937, 'us-ft']]]);
const maxMetadataBytes = 1024 * 1024, maxRecords = 4096;
const decoder = new TextDecoder('utf-8', { fatal: true });

function geoKeys(bytes, records) {
  if (bytes.length < 8 || bytes.length % 2 || bytes.readUInt16LE(0) !== 1 ||
      bytes.readUInt16LE(2) !== 1 || ![0, 1].includes(bytes.readUInt16LE(4))) fail();
  const count = bytes.readUInt16LE(6), end = 8 + count * 8;
  if (end > bytes.length) fail();
  const keys = new Map();
  for (let at = 8; at < end; at += 8) {
    const key = bytes.readUInt16LE(at), location = bytes.readUInt16LE(at + 2);
    const length = bytes.readUInt16LE(at + 4), offset = bytes.readUInt16LE(at + 6);
    if (keys.has(key) || !length) fail();
    if (!location) { if (length !== 1) fail(); keys.set(key, offset); }
    else {
      const target = location === 34735 ? bytes : records.get(location);
      const width = location === 34736 ? 8 : location === 34735 ? 2 : 1;
      if (![34735, 34736, 34737].includes(location) || !target ||
          (offset + length) * width > target.length || location === 34735 && offset * 2 < end) fail();
      keys.set(key, null);
    }
  }
  // Support canonical authority codes and descriptive citations. Refuse
  // user-defined projection/ellipsoid/unit overrides rather than trusting a
  // projected EPSG label over contradictory geometric parameters.
  // 4096 (vertical CRS) and 4098 (vertical datum) need independent authority
  // validation and cross-declaration checks, which this narrow reader does not
  // implement. Reject them even alongside 4099 rather than silently accepting
  // conflicting CRS/unit labels (e.g. EPSG:5703 with survey-foot heights).
  const allowed = new Set([1024, 1025, 1026, 2048, 2049, 2054, 3072, 3073, 3076, 4097, 4099]);
  if ([...keys.keys()].some(key => !allowed.has(key))) fail('native_point_metadata_unsupported');
  for (const [key, expected] of [[1024, 1], [2048, 4326], [2054, 9102], [3076, 9001]]) {
    if (keys.has(key) && keys.get(key) !== expected) fail('measurement_source_crs_mismatch');
  }
  const code = keys.get(3072);
  const horizontal = code === undefined ? null : inspectEptUtmCrs({ horizontal: code });
  let verticalFactor = null, originalUnit = null;
  if (keys.has(4099)) {
    const spec = specs.get(keys.get(4099));
    if (!spec) fail('measurement_source_vertical_units_unsupported');
    [verticalFactor, originalUnit] = spec;
  }
  return { horizontal, verticalFactor, originalUnit };
}

/** Inspect exact registered LAS/LAZ bytes. Absent vertical units remain null.
 * A non-null horizontalEpsg alone is NOT permission to assume metre heights.
 * Malformed, conflicting or unsupported declarations throw; no CRS returns null.
 */
export async function inspectNativePointUnits(absolutePath, source, { signal } = {}) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(source?.byteSize) || source.byteSize < 0 ||
      !/^[a-f0-9]{64}$/i.test(source?.sha256 || '') || source.manifestSha256) changed();
  const before = await fs.lstat(absolutePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(source.byteSize)) changed();
  const file = await fs.open(absolutePath, 'r');
  try {
    if (identity(before) !== identity(await file.stat({ bigint: true }))) changed();
    const digest = crypto.createHash('sha256'), chunk = Buffer.alloc(1024 * 1024);
    for (let offset = 0; offset < source.byteSize;) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, source.byteSize - offset), offset);
      if (!bytesRead) changed();
      digest.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
    }
    if (digest.digest('hex') !== source.sha256.toLowerCase()) changed();
    let budget = maxMetadataBytes;
    async function read(offset, length, boundary = source.byteSize) {
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
          offset + length > boundary || offset + length > source.byteSize) fail();
      if (length > budget) fail('native_point_metadata_limit');
      budget -= length;
      const bytes = Buffer.alloc(length);
      for (let filled = 0; filled < length;) {
        const { bytesRead } = await file.read(bytes, filled, length - filled, offset + filled);
        if (!bytesRead) fail(); filled += bytesRead;
      }
      return bytes;
    }
    const base = await read(0, 227);
    if (base.toString('ascii', 0, 4) !== 'LASF' || base[24] !== 1 || ![2, 3, 4].includes(base[25])) fail('native_point_metadata_unsupported');
    const minimumHeader = base[25] === 4 ? 375 : base[25] === 3 ? 235 : 227;
    const headerSize = base.readUInt16LE(94), pointOffset = base.readUInt32LE(96), vlrCount = base.readUInt32LE(100);
    if (headerSize < minimumHeader || pointOffset < headerSize || pointOffset > source.byteSize) fail();
    const extra = await read(227, minimumHeader - 227);
    const header = Buffer.concat([base, extra]);
    const pointFormat = base[104] & 0x3f;
    const lengths = [20, 28, 26, 34, 57, 63, 30, 36, 38, 59, 67];
    if (base[104] & 0x40 || pointFormat > (base[25] === 4 ? 10 : base[25] === 3 ? 5 : 3) ||
        base.readUInt16LE(105) < lengths[pointFormat]) fail();
    for (let at = 131; at < 179; at += 8) {
      const value = base.readDoubleLE(at);
      if (!Number.isFinite(value) || at < 155 && value <= 0) fail();
    }
    const evlrCount = base[25] === 4 ? header.readUInt32LE(243) : 0;
    const evlrBigOffset = base[25] === 4 ? header.readBigUInt64LE(235) : 0n;
    if (evlrBigOffset > BigInt(Number.MAX_SAFE_INTEGER)) fail();
    const evlrOffset = Number(evlrBigOffset);
    if (vlrCount + evlrCount > maxRecords) fail('native_point_metadata_limit');
    if ((!evlrCount && evlrOffset) || evlrCount && (evlrOffset < pointOffset || evlrOffset >= source.byteSize)) fail();
    const legacyCount = BigInt(base.readUInt32LE(107));
    const pointCount = base[25] === 4 ? header.readBigUInt64LE(247) : legacyCount;
    if (base[25] === 4 && legacyCount !== 0n && (pointFormat >= 6 || legacyCount !== pointCount)) fail();
    // Uncompressed points must fit before EVLRs. LAZ compression framing is
    // deliberately outside this metadata-only inspector's contract.
    if (!(base[104] & 0x80)) {
      if (BigInt(pointOffset) + pointCount * BigInt(base.readUInt16LE(105)) > BigInt(evlrCount ? evlrOffset : source.byteSize)) fail();
    }
    const records = new Map();
    async function scan(offset, count, extended, boundary) {
      for (let index = 0; index < count; index++) {
        const size = extended ? 60 : 54, record = await read(offset, size, boundary);
        const lengthBig = extended ? record.readBigUInt64LE(20) : BigInt(record.readUInt16LE(20));
        if (lengthBig > BigInt(Number.MAX_SAFE_INTEGER)) fail();
        const length = Number(lengthBig), start = offset + size;
        if (!Number.isSafeInteger(start + length) || start + length > boundary) fail();
        const user = record.subarray(2, 18).toString('ascii').replace(/\0+$/, '');
        const id = record.readUInt16LE(18);
        if (user === 'LASF_Projection') {
          if (![2112, 34735, 34736, 34737].includes(id)) fail('native_point_metadata_unsupported');
          if (records.has(id)) fail('native_point_metadata_conflict');
          records.set(id, await read(start, length, boundary));
        }
        offset = start + length;
      }
    }
    await scan(headerSize, vlrCount, false, pointOffset);
    await scan(evlrOffset, evlrCount, true, source.byteSize);
    const wktFlag = Boolean(base.readUInt16LE(6) & 16);
    if ((wktFlag || pointFormat >= 6) && !records.has(2112)) fail();
    if (records.has(2112) && (base[25] < 4 || !wktFlag)) fail();
    if ((records.has(34736) || records.has(34737)) && !records.has(34735)) fail();
    const declarations = [];
    if (records.has(34735)) declarations.push({ ...geoKeys(records.get(34735), records), basis: 'las-geotiff-vertical-unit' });
    if (records.has(2112)) {
      const bytes = records.get(2112);
      if (!bytes.length || bytes[bytes.length - 1] !== 0 || bytes.subarray(0, -1).includes(0)) fail();
      let wkt; try { wkt = decoder.decode(bytes.subarray(0, -1)); } catch { fail(); }
      const horizontal = inspectEptUtmCrs({ wkt });
      let verticalFactor = null;
      try { verticalFactor = resolveEptVerticalUnits({ wkt }, horizontal).verticalFactor; }
      catch (error) { if (error.code !== 'measurement_source_vertical_units_required') throw error; }
      const originalUnit = [...specs.values()].find(([factor]) => factor === verticalFactor)?.[1] || null;
      if (verticalFactor !== null && originalUnit === null) fail('measurement_source_vertical_units_unsupported');
      declarations.push({ horizontal, verticalFactor, originalUnit, basis: 'las-wkt-vertical-crs' });
    }
    const horizontals = declarations.map(d => d.horizontal).filter(v => v !== null);
    if (horizontals.some(v => v !== horizontals[0])) fail('measurement_source_crs_mismatch');
    const verticals = declarations.filter(d => d.verticalFactor !== null);
    if (verticals.some(d => d.verticalFactor !== verticals[0].verticalFactor)) fail('measurement_source_vertical_units_conflict');
    signal?.throwIfAborted();
    const after = await fs.lstat(absolutePath, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || identity(before) !== identity(after) ||
        identity(before) !== identity(await file.stat({ bigint: true }))) changed();
    if (!horizontals.length) return null;
    return { crs: `EPSG:${horizontals[0]}`, horizontalEpsg: horizontals[0],
      verticalFactor: verticals[0]?.verticalFactor ?? null, originalUnit: verticals[0]?.originalUnit ?? null,
      metadataBasis: verticals.length ? verticals.map(d => d.basis).join('+') : null,
      sha256: source.sha256.toLowerCase(), byteSize: source.byteSize, manifestSha256: '' };
  } finally { await file.close(); }
}
