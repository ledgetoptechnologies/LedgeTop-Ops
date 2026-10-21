import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { inspectNativePointUnits } from '../server/nativePointUnitInspection.mjs';

// Binary fixtures use LAS 1.4-R15 header/VLR/EVLR offsets, sections 2–3:
// https://www.asprs.org/wp-content/uploads/2021/04/LAS_latest.pdf
const horizontal = 'PROJCS["WGS84 UTM16N",GEOGCS["WGS84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-87],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","32616"]]';
const compound = (name = 'foot', factor = .3048) => `COMPD_CS["Survey",${horizontal},VERT_CS["Height",VERT_DATUM["Survey datum",2005],UNIT["${name}",${factor}],AXIS["Height",UP]]]`;

function keys(unit = 9001, additions = []) {
  const entries = [[1024, 1], [3072, 32616], [3076, 9001], ...(unit === null ? [] : [[4099, unit]]), ...additions];
  const bytes = Buffer.alloc(8 + entries.length * 8);
  bytes.writeUInt16LE(1, 0); bytes.writeUInt16LE(1, 2); bytes.writeUInt16LE(entries.length, 6);
  entries.forEach(([key, value], i) => {
    bytes.writeUInt16LE(key, 8 + i * 8); bytes.writeUInt16LE(1, 12 + i * 8); bytes.writeUInt16LE(value, 14 + i * 8);
  });
  return { id: 34735, bytes };
}
const wkt = text => ({ id: 2112, bytes: Buffer.from(`${text}\0`) });
function las({ records = [keys()], extended = [], compressed = false, minor = 4 } = {}) {
  const pack = (r, evlr) => {
    const head = Buffer.alloc(evlr ? 60 : 54);
    head.write('LASF_Projection', 2, 'ascii'); head.writeUInt16LE(r.id, 18);
    if (evlr) head.writeBigUInt64LE(BigInt(r.bytes.length), 20); else head.writeUInt16LE(r.bytes.length, 20);
    return Buffer.concat([head, r.bytes]);
  };
  const header = Buffer.alloc(minor === 4 ? 375 : minor === 3 ? 235 : 227);
  const vlrs = Buffer.concat(records.map(r => pack(r, false)));
  header.write('LASF'); header[24] = 1; header[25] = minor;
  if ([...records, ...extended].some(r => r.id === 2112)) header.writeUInt16LE(16, 6);
  header.writeUInt16LE(header.length, 94); header.writeUInt32LE(header.length + vlrs.length, 96);
  header.writeUInt32LE(records.length, 100); header[104] = compressed ? 128 : 0; header.writeUInt16LE(20, 105);
  for (const at of [131, 139, 147]) header.writeDoubleLE(.01, at);
  if (minor === 4 && extended.length) {
    header.writeBigUInt64LE(BigInt(header.length + vlrs.length), 235); header.writeUInt32LE(extended.length, 243);
  }
  return Buffer.concat([header, vlrs, ...extended.map(r => pack(r, true))]);
}
function fixture(t, bytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-point-units-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'cloud.laz'); fs.writeFileSync(file, bytes);
  return { file, source: { byteSize: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') } };
}
const inspect = (t, bytes) => { const f = fixture(t, bytes); return inspectNativePointUnits(f.file, f.source); };

test('GeoTIFF LAS/LAZ metadata preserves explicit metres and both feet with byte binding', async t => {
  for (const compressed of [false, true]) for (const minor of [2, 3, 4]) {
    for (const [unit, factor, original] of [[9001, 1, 'm'], [9002, .3048, 'ft'], [9003, 1200 / 3937, 'us-ft']]) {
      const f = fixture(t, las({ records: [keys(unit)], compressed, minor }));
      const result = await inspectNativePointUnits(f.file, f.source);
      assert.deepEqual(result, { crs: 'EPSG:32616', horizontalEpsg: 32616, verticalFactor: factor,
        originalUnit: original, metadataBasis: 'las-geotiff-vertical-unit', ...f.source, manifestSha256: '' });
    }
  }
});

test('compound WKT VLR and EVLR validate the horizontal and vertical frames', async t => {
  for (const extended of [false, true]) for (const [name, factor, original] of [
    ['metre', 1, 'm'], ['foot', .3048, 'ft'], ['US survey foot', 1200 / 3937, 'us-ft'],
  ]) {
    const records = [wkt(compound(name, factor))];
    const result = await inspect(t, las(extended ? { records: [], extended: records } : { records }));
    assert.equal(result.originalUnit, original); assert.equal(result.verticalFactor, factor);
    assert.equal(result.metadataBasis, 'las-wkt-vertical-crs');
  }
});

test('horizontal-only CRS remains useful but never supplies vertical units', async t => {
  for (const records of [[keys(null)], [wkt(horizontal)]]) {
    const result = await inspect(t, las({ records }));
    assert.equal(result.horizontalEpsg, 32616);
    assert.equal(result.verticalFactor, null); assert.equal(result.originalUnit, null); assert.equal(result.metadataBasis, null);
  }
  assert.equal(await inspect(t, las({ records: [] })), null);
});

test('conflicting or unsupported geometric declarations fail closed', async t => {
  for (const [records, code] of [
    [[keys(9001), wkt(compound())], 'measurement_source_vertical_units_conflict'],
    [[keys(9001), keys(9002)], 'native_point_metadata_conflict'],
    [[keys(9001, [[4099, 9002]])], 'native_point_metadata_invalid'],
    [[keys(9999)], 'measurement_source_vertical_units_unsupported'],
    [[keys(9001, [[3077, 2]])], 'native_point_metadata_unsupported'],
    [[keys(9003, [[4096, 5703]])], 'native_point_metadata_unsupported'],
    [[keys(9001, [[4096, 6360]])], 'native_point_metadata_unsupported'],
    [[keys(9001, [[4098, 5103]])], 'native_point_metadata_unsupported'],
    [[keys(9001, [[2048, 4269]])], 'measurement_source_crs_mismatch'],
    [[wkt(compound('foot', 1))], 'measurement_source_crs_mismatch'],
    [[wkt(compound().replace('AXIS["Height",UP]', 'AXIS["Height",DOWN]'))], 'measurement_source_crs_mismatch'],
    [[wkt(horizontal.replace('PARAMETER["false_easting",500000]', 'PARAMETER["false_easting",500001]'))], 'measurement_source_crs_mismatch'],
  ]) await assert.rejects(inspect(t, las({ records })), { code });
  await assert.rejects(inspect(t, las({ records: [keys(9001)], extended: [keys(9002)] })), { code: 'native_point_metadata_conflict' });
});

test('unsupported WKT scales cannot produce evidence with an unidentified original unit', async t => {
  for (const [name, factor] of [['centimetre', .01], ['millimetre', .001], ['kilometre', 1000]]) {
    await assert.rejects(inspect(t, las({ records: [wkt(compound(name, factor))] })));
  }
});

test('matching WKT and GeoTIFF declarations preserve combined evidence', async t => {
  const result = await inspect(t, las({ records: [keys(9002), wkt(compound())] }));
  assert.equal(result.originalUnit, 'ft'); assert.equal(result.metadataBasis, 'las-geotiff-vertical-unit+las-wkt-vertical-crs');
});

test('malformed headers, records, offsets and bounded metadata cannot yield metre defaults', async t => {
  const cases = [];
  const mutate = change => { const bytes = las(); change(bytes); cases.push(bytes); };
  mutate(b => b.writeUInt32LE(1, 96));
  mutate(b => b.writeUInt16LE(60000, 375 + 20));
  mutate(b => b.writeUInt32LE(4097, 100));
  mutate(b => b.writeDoubleLE(NaN, 131));
  mutate(b => b.writeBigUInt64LE(1n, 235));
  mutate(b => b.writeBigUInt64LE(1n, 247));
  mutate(b => b.writeUInt16LE(16, 6));
  cases.push(Buffer.alloc(20));
  cases.push(las({ records: [{ id: 2112, bytes: Buffer.from(horizontal) }] }));
  cases.push(las({ records: [], extended: [{ id: 2112, bytes: Buffer.alloc(1024 * 1024 + 1) }] }));
  for (const bytes of cases) await assert.rejects(inspect(t, bytes));
});

test('source hash, size and manifest mismatches and aborts are rejected', async t => {
  const f = fixture(t, las());
  await assert.rejects(inspectNativePointUnits(f.file, { ...f.source, sha256: '0'.repeat(64) }), { code: 'source_changed' });
  await assert.rejects(inspectNativePointUnits(f.file, { ...f.source, byteSize: f.source.byteSize + 1 }), { code: 'source_changed' });
  await assert.rejects(inspectNativePointUnits(f.file, { ...f.source, manifestSha256: 'a'.repeat(64) }), { code: 'source_changed' });
  await assert.rejects(inspectNativePointUnits(f.file, f.source, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const changed = fs.readFileSync(f.file); changed[50] ^= 1; fs.writeFileSync(f.file, changed);
  await assert.rejects(inspectNativePointUnits(f.file, f.source), { code: 'source_changed' });
});

test('replacement with identical bytes during inspection fails stable path identity', async t => {
  const bytes = las(), f = fixture(t, bytes);
  const replacement = `${f.file}.replacement`; fs.writeFileSync(replacement, bytes);
  let checks = 0;
  const signal = { throwIfAborted() {
    // Final check after hashing and all metadata reads; old handle stays open.
    if (++checks === 7) {
      fs.renameSync(f.file, `${f.file}.original`); fs.renameSync(replacement, f.file);
    }
  } };
  await assert.rejects(inspectNativePointUnits(f.file, f.source, { signal }), { code: 'source_changed' });
  assert.equal(checks, 7);
});
