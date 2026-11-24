import { createUtmProjection } from './utm-conversion.mjs';

// Map views can use the saved WGS84 position directly. 3D views project only
// where the exact version declares a compatible WGS84 UTM frame.
export function projectViewerMark(mark, georef) {
  const { latitude, longitude } = mark || {};
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90
    || !Number.isFinite(longitude) || Math.abs(longitude) > 180) return null;
  const position = { latitude, longitude, utm: null };
  const zone = (georef?.utmZoneLon0Deg + 183) / 6;
  const hemisphere = georef?.hemisphere;
  const epsg = Number(georef?.epsg ?? String(georef?.crs || '').match(/^EPSG:(\d+)$/i)?.[1]);
  if (!Number.isInteger(zone) || zone < 1 || zone > 60 || !['N', 'S'].includes(hemisphere)
    || epsg !== (hemisphere === 'N' ? 32600 : 32700) + zone
    || latitude < -80 || latitude > 84 || (latitude !== 0 && (latitude > 0) !== (hemisphere === 'N'))) return position;
  const longitudeDelta = ((longitude - georef.utmZoneLon0Deg + 540) % 360) - 180;
  if (Math.abs(longitudeDelta) > 6) return position;
  const projection = createUtmProjection({ zoneLon0Deg: georef.utmZoneLon0Deg, hemisphere });
  const [easting, northing] = projection.latLonToUtm(latitude, georef.utmZoneLon0Deg + longitudeDelta);
  if (Number.isFinite(easting) && Number.isFinite(northing)) position.utm = { easting, northing };
  return position;
}
