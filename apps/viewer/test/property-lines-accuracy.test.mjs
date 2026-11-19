// Positional accuracy of the property lines chain, offline:
//   state service rings (EPSG:3857, geometryPrecision 2) -> server lon/lat
//   (rounded to 1e-7 deg) -> browser UTM (utm-conversion.mjs) -> scene.
// Reference values come from an independent transverse Mercator (Karney 2011,
// 6th-order Krueger series) below, not from utm-conversion.mjs. The WISCRS
// point is the published-style survey fixture already used by
// gcp-import.test.js (NAD83(2011) / WISCRS Dodge and Jefferson, US survey
// feet), which checks both the WISCRS parameters and the foot definition.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createUtmProjection } from '../utm-conversion.mjs';
import { lonLatToWebMercator, webMercatorToLonLat, parcelsToUtmPolylines } from '../property-lines.mjs';

const require = createRequire(import.meta.url);
const server = require('../server/propertyLines.js');

const US_FOOT = 1200 / 3937;          // metres, US survey foot
const INTERNATIONAL_FOOT = 0.3048;
const CM = 0.03;                      // acceptance tolerance, metres

// Karney (2011) Krüger series, 6th order.
function referenceTm({ a, f, lon0, lat0 = 0, k0, fe = 0, fn = 0 }) {
  const n = f / (2 - f), n2 = n*n, n3 = n2*n, n4 = n3*n, n5 = n4*n, n6 = n5*n;
  const A = a / (1 + n) * (1 + n2/4 + n4/64 + n6/256);
  const al = [0, n/2 - 2*n2/3 + 5*n3/16 + 41*n4/180 - 127*n5/288 + 7891*n6/37800,
    13*n2/48 - 3*n3/5 + 557*n4/1440 + 281*n5/630 - 1983433*n6/1935360,
    61*n3/240 - 103*n4/140 + 15061*n5/26880 + 167603*n6/181440,
    49561*n4/161280 - 179*n5/168 + 6601661*n6/7257600,
    34729*n5/80640 - 3418889*n6/1995840, 212378941*n6/319334400];
  const be = [0, n/2 - 2*n2/3 + 37*n3/96 - n4/360 - 81*n5/512 + 96199*n6/604800,
    n2/48 + n3/15 - 437*n4/1440 + 46*n5/105 - 1118711*n6/3870720,
    17*n3/480 - 37*n4/840 - 209*n5/4480 + 5569*n6/90720,
    4397*n4/161280 - 11*n5/504 - 830251*n6/7257600,
    4583*n5/161280 - 108847*n6/3991680, 20648693*n6/638668800];
  const e = Math.sqrt(f * (2 - f)), D = Math.PI / 180;
  const raw = (latD, lonD) => {
    const phi = latD*D, lam = (lonD - lon0)*D;
    const t = Math.sinh(Math.atanh(Math.sin(phi)) - e*Math.atanh(e*Math.sin(phi)));
    const xi_ = Math.atan2(t, Math.cos(lam)), eta_ = Math.atanh(Math.sin(lam)/Math.sqrt(1+t*t));
    let xi = xi_, eta = eta_;
    for (let j = 1; j <= 6; j++) { xi += al[j]*Math.sin(2*j*xi_)*Math.cosh(2*j*eta_); eta += al[j]*Math.cos(2*j*xi_)*Math.sinh(2*j*eta_); }
    return [k0*A*eta, k0*A*xi];
  };
  const y0 = raw(lat0, lon0)[1];
  const forward = (latD, lonD) => { const [x, y] = raw(latD, lonD); return [fe + x, fn + y - y0]; };
  const inverse = (E, N) => {
    const xi = (N - fn + y0)/(k0*A), eta = (E - fe)/(k0*A);
    let xi_ = xi, eta_ = eta;
    for (let j = 1; j <= 6; j++) { xi_ -= be[j]*Math.sin(2*j*xi)*Math.cosh(2*j*eta); eta_ -= be[j]*Math.cos(2*j*xi)*Math.sinh(2*j*eta); }
    const tau_ = Math.sin(xi_)/Math.sqrt(Math.sinh(eta_)**2 + Math.cos(xi_)**2);
    let tau = tau_;
    for (let i = 0; i < 8; i++) { const s = Math.sinh(e*Math.atanh(e*tau/Math.sqrt(1+tau*tau)));
      const t_ = tau*Math.sqrt(1+s*s) - s*Math.sqrt(1+tau*tau);
      tau += (tau_ - t_)/Math.sqrt(1+t_*t_) * (1 + (1-e*e)*tau*tau) / ((1-e*e)*Math.sqrt(1+tau*tau)); }
    return [Math.atan(tau)/D, lon0 + Math.atan2(Math.sinh(eta_), Math.cos(xi_))/D];
  };
  return { forward, inverse };
}

// WISCRS Dodge and Jefferson, NAD83(2011) on GRS80, as a proj4 string:
// +proj=tmerc +lat_0=41.4722222222 +lon_0=-88.775 +k=1.0000346179 +x_0=263347.7263 +y_0=0 +ellps=GRS80 +units=us-ft
// (false easting 864000 ftUS). No proj4 library is in the repo, hence referenceTm.
const wiscrsDodgeJefferson = referenceTm({ a: 6378137, f: 1 / 298.257222101, lon0: -(88 + 46 / 60 + 30 / 3600),
  lat0: 41 + 28 / 60 + 20 / 3600, k0: 1.0000346179, fe: 263347.7263, fn: 0 });
const utm16Reference = referenceTm({ a: 6378137, f: 1 / 298.257223563, lon0: -87, k0: 0.9996, fe: 500000 });
const utm16 = createUtmProjection({ zoneLon0Deg: -87, hemisphere: 'N' });

// Fixture point: WISCRS ftUS and its geographic position from the same export.
const FIXTURE = { eFt: 903241.652, nFt: 549596.746, lat: 42.98018648, lon: -88.62836667 };
// UTM 16N values for the fixture and a far-from-meridian point (Madison area,
// about 2.4 degrees west of -87), from referenceTm above, to 0.1 mm.
const UTM_REFERENCE = [
  { lat: FIXTURE.lat, lon: FIXTURE.lon, e: 367230.5869, n: 4759900.9562 },
  { lat: 43.0745, lon: -89.401, e: 304531.1172, n: 4771885.8828 },
];

test('WISCRS ftUS fixture round trips through lon/lat within a few centimetres', () => {
  const [e, n] = wiscrsDodgeJefferson.forward(FIXTURE.lat, FIXTURE.lon);
  assert.ok(Math.abs(e - FIXTURE.eFt * US_FOOT) < CM, `easting off by ${e - FIXTURE.eFt * US_FOOT} m`);
  assert.ok(Math.abs(n - FIXTURE.nFt * US_FOOT) < CM, `northing off by ${n - FIXTURE.nFt * US_FOOT} m`);
  const [lat, lon] = wiscrsDodgeJefferson.inverse(FIXTURE.eFt * US_FOOT, FIXTURE.nFt * US_FOOT);
  const [ue, un] = utm16.latLonToUtm(lat, lon);
  assert.ok(Math.hypot(ue - UTM_REFERENCE[0].e, un - UTM_REFERENCE[0].n) < CM, 'WISCRS -> lon/lat -> UTM 16N');
});

test('reading WISCRS US survey feet as international feet is caught (about half a metre)', () => {
  const [e, n] = wiscrsDodgeJefferson.forward(FIXTURE.lat, FIXTURE.lon);
  const shift = Math.hypot(FIXTURE.eFt * INTERNATIONAL_FOOT - e, FIXTURE.nFt * INTERNATIONAL_FOOT - n);
  assert.ok(shift > 0.5 && shift < 0.7, `foot mix-up shift ${shift} m`);
});

test('utm-conversion.mjs matches the independent UTM 16N reference both ways', () => {
  for (const ref of UTM_REFERENCE) {
    const [e, n] = utm16.latLonToUtm(ref.lat, ref.lon);
    assert.ok(Math.hypot(e - ref.e, n - ref.n) < CM, `forward off by ${Math.hypot(e - ref.e, n - ref.n)} m at ${ref.lon}`);
    const [lat, lon] = utm16.utmToLatLon(ref.e, ref.n);
    const metres = Math.hypot((lat - ref.lat) * 111_000, (lon - ref.lon) * 111_000 * Math.cos(ref.lat * Math.PI / 180));
    assert.ok(metres < CM, `inverse off by ${metres} m at ${ref.lon}`);
  }
});

test('service rings in Web Mercator land on the reference UTM position after server and browser rounding', () => {
  for (const ref of UTM_REFERENCE) {
    // As the state service returns it: EPSG:3857 at geometryPrecision 2.
    const [x, y] = server.lonLatToWebMercator(ref.lon, ref.lat).map(v => Math.round(v * 100) / 100);
    const { parcels } = server.normalizeUpstream({ features: [{ attributes: { OBJECTID: 1 },
      geometry: { rings: [[[x, y], [x + 10, y], [x + 10, y + 10], [x, y]]] } }] });
    const { lines } = parcelsToUtmPolylines(parcels, utm16.latLonToUtm, { densifyMeters: 0 });
    const [e, n] = lines[0][0];
    assert.ok(Math.hypot(e - ref.e, n - ref.n) < CM, `chain off by ${Math.hypot(e - ref.e, n - ref.n)} m at ${ref.lon}`);
  }
  // Browser and server Web Mercator helpers agree and invert each other.
  const [bx, by] = lonLatToWebMercator(FIXTURE.lon, FIXTURE.lat);
  const [sx, sy] = server.lonLatToWebMercator(FIXTURE.lon, FIXTURE.lat);
  assert.ok(Math.abs(bx - sx) < 1e-6 && Math.abs(by - sy) < 1e-6);
  const [lon, lat] = webMercatorToLonLat(bx, by);
  assert.ok(Math.abs(lon - FIXTURE.lon) < 1e-10 && Math.abs(lat - FIXTURE.lat) < 1e-10);
});
