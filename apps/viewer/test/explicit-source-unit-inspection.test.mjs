import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { nativeTiffFixture } from './helpers/native-tiff-fixture.mjs';
import storage from '../server/storageManager.js';
import { inspectExplicitSourceUnits } from '../server/explicitSourceUnitInspection.mjs';

function fixture(t, bytes, kind = 'dsm') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explicit-unit-inspection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, kind === 'ept' ? 'ept.json' : 'surface.tif');
  fs.writeFileSync(file, bytes);
  return { file, root, source: { kind, byteSize: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') } };
}

test('physical raster units preserve original metres, international feet and survey feet', async t => {
  for (const [verticalUnit, originalUnit, factor] of [[9001,'m',1],[9002,'ft',.3048],[9003,'us-ft',1200/3937]]) {
    const f = fixture(t, nativeTiffFixture({ verticalUnit }));
    const result = await inspectExplicitSourceUnits(f.file, f.source);
    assert.equal(result.originalUnit, originalUnit);
    assert.equal(result.verticalFactor, factor);
    assert.equal(result.sha256, f.source.sha256);
    assert.equal(result.byteSize, f.source.byteSize);
    assert.equal(result.manifestSha256, '');
    assert.equal(result.crs, 'EPSG:32616');
    assert.equal(result.metadataBasis, 'raster-metadata');
  }
});

test('unknown units stay unknown and contradictory/scaled raster metadata never becomes evidence', async t => {
  const unknown = fixture(t, nativeTiffFixture({ verticalUnit: null }));
  assert.equal(await inspectExplicitSourceUnits(unknown.file, unknown.source), null);
  for (const [gdalMetadata, code] of [
    ['<GDALMetadata><Item name="UNITTYPE" sample="0">ft</Item></GDALMetadata>','measurement_source_vertical_units_conflict'],
    ['<GDALMetadata><Item name="SCALE" sample="0">2</Item></GDALMetadata>','measurement_source_value_transform_unsupported'],
  ]) {
    const f = fixture(t, nativeTiffFixture({ verticalUnit: 9001, gdalMetadata }));
    await assert.rejects(inspectExplicitSourceUnits(f.file,f.source), { code });
  }
});

test('changed raster bytes and aborted inspections cannot produce records', async t => {
  const f = fixture(t, nativeTiffFixture({ verticalUnit:9001 }));
  const bytes = fs.readFileSync(f.file); bytes[bytes.length-1] ^= 1; fs.writeFileSync(f.file,bytes);
  await assert.rejects(inspectExplicitSourceUnits(f.file,f.source), { code:'source_changed' });
  await assert.rejects(inspectExplicitSourceUnits(f.file,f.source,{signal:AbortSignal.abort()}), { name:'AbortError' });
});

test('explicit band units retain every supported scale instead of defaulting to metres', async t => {
  for (const [originalUnit, factor] of [['cm', .01], ['mm', .001], ['km', 1000]]) {
    const f=fixture(t,nativeTiffFixture({verticalUnit:null,gdalMetadata:`<GDALMetadata><Item name="UNITTYPE" sample="0">${originalUnit}</Item></GDALMetadata>`}));
    const result=await inspectExplicitSourceUnits(f.file,f.source);
    assert.equal(result.originalUnit,originalUnit);
    assert.equal(result.verticalFactor,factor);
    assert.equal(result.metadataBasis,'gdal-band-unit');
  }
});

const horizontal='PROJCS["WGS84 UTM16N",GEOGCS["WGS84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-87],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","32616"]]';

test('EPT explicit feet bind to the entire immutable tree; horizontal-only metadata is not vertical proof', async t => {
  const wkt=`COMPD_CS["Survey",${horizontal},VERT_CS["Survey height",VERT_DATUM["Survey datum",2005],UNIT["foot",0.3048],AXIS["Height",UP]]]`;
  const f=fixture(t,Buffer.from(JSON.stringify({srs:{horizontal:32616,wkt}})),'ept');
  fs.writeFileSync(path.join(f.root,'points.bin'),Buffer.from([1,2,3]));
  f.source.manifestSha256=(await storage.hashTree(f.root)).manifestSha256;
  const result=await inspectExplicitSourceUnits(f.file,f.source);
  assert.equal(result.originalUnit,'ft');
  assert.equal(result.metadataBasis,'ept-vertical-crs');
  assert.equal(result.manifestSha256,f.source.manifestSha256);
  const wktOnly=fixture(t,Buffer.from(JSON.stringify({srs:{wkt}})),'ept');
  wktOnly.source.manifestSha256=(await storage.hashTree(wktOnly.root)).manifestSha256;
  assert.equal((await inspectExplicitSourceUnits(wktOnly.file,wktOnly.source)).originalUnit,'ft');
  fs.writeFileSync(path.join(f.root,'points.bin'),Buffer.from([3,2,1]));
  await assert.rejects(inspectExplicitSourceUnits(f.file,f.source),{code:'source_changed'});
  const missing=fixture(t,Buffer.from(JSON.stringify({srs:{horizontal:32616,wkt:horizontal}})),'ept');
  missing.source.manifestSha256=(await storage.hashTree(missing.root)).manifestSha256;
  assert.equal(await inspectExplicitSourceUnits(missing.file,missing.source),null);
});
