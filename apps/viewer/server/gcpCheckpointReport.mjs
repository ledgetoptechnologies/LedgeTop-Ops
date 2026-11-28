// Checkpoint accuracy for one processing attempt: the processed DSM sampled at each
// checkpoint's surveyed position, compared with its surveyed Elevation.
//
// Vertical only. The DSM height at the checkpoint's horizontal position minus the
// surveyed Elevation (both NAVD88 metres for a NAVD88 project: gcp_list.txt feeds ODM
// the same Elevation, and ODM passes heights through). Horizontal error would need the
// orthophoto or the reconstructed cameras and is not measured here.
import { fromFile } from 'geotiff';
import { createUtmProjection } from '../utm-conversion.mjs';

const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const VERTICAL_FACTORS = { 9001: 1, 9002: 0.3048, 9003: 1200 / 3937 };

function utmZone(keys) {
  const epsg = Number(keys.ProjectedCSTypeGeoKey);
  if (epsg >= 32601 && epsg <= 32660) return { epsg, zone: epsg - 32600, hemisphere: 'N' };
  if (epsg >= 32701 && epsg <= 32760) return { epsg, zone: epsg - 32700, hemisphere: 'S' };
  return fail('checkpoint_report_crs_unsupported');
}

function verticalFactor(keys) {
  const key = keys.VerticalUnitsGeoKey;
  if (key === undefined) return 1; // ODM writes metre DSMs without a vertical unit key.
  return VERTICAL_FACTORS[Number(key)] ?? fail('checkpoint_report_vertical_units_unsupported');
}

const round = (value, digits = 4) => value == null ? null : Math.round(value * 10 ** digits) / 10 ** digits;

async function sample(image, { x, y, width, height, noData }) {
  // Bilinear between the four nearest pixel centres; any nodata among them makes
  // the sample unavailable rather than leaning on the remaining neighbours.
  const fx = x - 0.5, fy = y - 0.5;
  const x0 = Math.max(0, Math.min(width - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(height - 2, Math.floor(fy)));
  const [band] = await image.readRasters({ window: [x0, y0, x0 + 2, y0 + 2] });
  const values = Array.from(band);
  if (values.some((value) => !Number.isFinite(value) || (noData != null && value === noData))) return null;
  const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
  const top = values[0] * (1 - tx) + values[1] * tx, bottom = values[2] * (1 - tx) + values[3] * tx;
  return top * (1 - ty) + bottom * ty;
}

export async function checkpointReport({ checkpoints, dsmPath }) {
  if (!Array.isArray(checkpoints)) fail('checkpoint_report_invalid_input');
  const tiff = await fromFile(dsmPath);
  try {
    const image = await tiff.getImage(), keys = image.getGeoKeys() || {};
    const { epsg, zone, hemisphere } = utmZone(keys), factor = verticalFactor(keys);
    const [originX, originY] = image.getOrigin(), [dx, dy] = image.getResolution();
    if (![originX, originY, dx, dy].every(Number.isFinite) || dx <= 0 || dy >= 0) fail('checkpoint_report_raster_transform_unsupported');
    const width = image.getWidth(), height = image.getHeight();
    if (width < 2 || height < 2) fail('checkpoint_report_raster_too_small');
    const noDataRaw = image.getGDALNoData?.(), noData = noDataRaw == null ? null : Number(noDataRaw);
    const projection = createUtmProjection({ zoneLon0Deg: zone * 6 - 183, hemisphere });
    const points = [];
    for (const checkpoint of checkpoints) {
      const [easting, northing] = projection.latLonToUtm(checkpoint.latitude, checkpoint.longitude);
      const x = (easting - originX) / dx, y = (northing - originY) / dy;
      const base = { externalId: checkpoint.externalId, label: checkpoint.label, elevationM: checkpoint.elevationM, markCount: checkpoint.marks?.length || 0 };
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > width || y > height) {
        points.push({ ...base, status: 'outside_dsm', dsmZM: null, dzM: null }); continue;
      }
      const raw = await sample(image, { x, y, width, height, noData });
      if (raw == null) { points.push({ ...base, status: 'no_dsm_value', dsmZM: null, dzM: null }); continue; }
      const dsmZM = raw * factor;
      points.push({ ...base, status: 'measured', dsmZM: round(dsmZM), dzM: round(dsmZM - checkpoint.elevationM) });
    }
    const measured = points.filter((row) => row.status === 'measured').map((row) => row.dzM);
    const mean = measured.length ? measured.reduce((sum, value) => sum + value, 0) / measured.length : null;
    return {
      schemaVersion: 1,
      dsm: { crs: `EPSG:${epsg}`, verticalFactor: factor },
      points,
      summary: {
        checkpointCount: points.length, measuredCount: measured.length, horizontal: 'not_measured',
        meanZM: round(mean),
        rmseZM: measured.length ? round(Math.sqrt(measured.reduce((sum, value) => sum + value * value, 0) / measured.length)) : null,
        maxAbsZM: measured.length ? round(Math.max(...measured.map(Math.abs))) : null,
      },
    };
  } finally { await tiff.close?.(); }
}
