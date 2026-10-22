const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;
const UTM_SCALE = 0.9996;
const FALSE_EASTING = 500000;
const FALSE_NORTHING = 10000000;

export function normalizeUtmHemisphere(value) {
  return String(value || '').trim().toUpperCase().startsWith('S') ? 'S' : 'N';
}

export function createUtmProjection({ zoneLon0Deg = -87, hemisphere = 'N' } = {}) {
  const centralMeridian = Number(zoneLon0Deg) * Math.PI / 180;
  if (!Number.isFinite(centralMeridian)) throw new TypeError('UTM central meridian must be finite.');
  const normalizedHemisphere = normalizeUtmHemisphere(hemisphere);
  const southOffset = normalizedHemisphere === 'S' ? FALSE_NORTHING : 0;
  const eSq = 2 * WGS84_F - WGS84_F * WGS84_F;
  const ep2 = eSq / (1 - eSq);

  function utmToLatLon(easting, northing) {
    const e = Number(easting), n = Number(northing);
    if (!Number.isFinite(e) || !Number.isFinite(n)) return [NaN, NaN];
    const e1 = (1 - Math.sqrt(1 - eSq)) / (1 + Math.sqrt(1 - eSq));
    const x = e - FALSE_EASTING;
    // Southern UTM coordinates include a 10,000 km false northing. Remove it
    // before evaluating the meridional arc so camera, map and raster paths all
    // operate in the correct signed hemisphere.
    const M = (n - southOffset) / UTM_SCALE;
    const mu = M / (WGS84_A * (1 - eSq / 4 - 3 * eSq * eSq / 64 - 5 * eSq ** 3 / 256));
    const j1 = 3 * e1 / 2 - 27 * e1 ** 3 / 32;
    const j2 = 21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32;
    const j3 = 151 * e1 ** 3 / 96;
    const j4 = 1097 * e1 ** 4 / 512;
    const fp = mu + j1 * Math.sin(2 * mu) + j2 * Math.sin(4 * mu)
      + j3 * Math.sin(6 * mu) + j4 * Math.sin(8 * mu);
    const c1 = ep2 * Math.cos(fp) ** 2, t1 = Math.tan(fp) ** 2;
    const r1 = WGS84_A * (1 - eSq) / Math.pow(1 - eSq * Math.sin(fp) ** 2, 1.5);
    const n1 = WGS84_A / Math.sqrt(1 - eSq * Math.sin(fp) ** 2);
    const d = x / (n1 * UTM_SCALE);
    const lat = fp - (n1 * Math.tan(fp) / r1) * (d * d / 2
      - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * d ** 4 / 24
      + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ep2 - 3 * c1 * c1) * d ** 6 / 720);
    const lon = centralMeridian + (d - (1 + 2 * t1 + c1) * d ** 3 / 6
      + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ep2 + 24 * t1 * t1) * d ** 5 / 120) / Math.cos(fp);
    return [lat * 180 / Math.PI, lon * 180 / Math.PI];
  }

  function latLonToUtm(latDeg, lonDeg) {
    const lat = Number(latDeg) * Math.PI / 180;
    const lon = Number(lonDeg) * Math.PI / 180;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [NaN, NaN];
    const N = WGS84_A / Math.sqrt(1 - eSq * Math.sin(lat) ** 2);
    const T = Math.tan(lat) ** 2;
    const C = ep2 * Math.cos(lat) ** 2;
    const A = Math.cos(lat) * (lon - centralMeridian);
    const M = WGS84_A * ((1 - eSq / 4 - 3 * eSq ** 2 / 64 - 5 * eSq ** 3 / 256) * lat
      - (3 * eSq / 8 + 3 * eSq ** 2 / 32 + 45 * eSq ** 3 / 1024) * Math.sin(2 * lat)
      + (15 * eSq ** 2 / 256 + 45 * eSq ** 3 / 1024) * Math.sin(4 * lat)
      - (35 * eSq ** 3 / 3072) * Math.sin(6 * lat));
    const easting = UTM_SCALE * N * (A + (1 - T + C) * A ** 3 / 6
      + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + FALSE_EASTING;
    const signedNorthing = UTM_SCALE * (M + N * Math.tan(lat) * (A * A / 2
      + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24
      + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
    return [easting, signedNorthing + southOffset];
  }

  return Object.freeze({
    hemisphere: normalizedHemisphere,
    zoneLon0Deg: Number(zoneLon0Deg),
    latLonToUtm,
    utmToLatLon,
  });
}
