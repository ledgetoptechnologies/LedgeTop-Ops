import { eptSliceBox } from './ept-slice-geometry.mjs';

// Validate native-coordinate metadata only. This never performs reprojection or
// infers a CRS or unit from coordinate magnitude, an EPSG-like number or a label.
export function validateEptNativeCoordinates({ bounds, crs = null, horizontalUnit = null, verticalUnit = null } = {}) {
  eptSliceBox(bounds);
  const validText = value => value === null || (typeof value === 'string' && value.trim() === value
    && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value));
  if (!validText(crs) || ![null,'m','ft','us-ft'].includes(horizontalUnit) || ![null,'m','ft','us-ft'].includes(verticalUnit))
    throw new Error('Invalid native EPT coordinate metadata.');
  return Object.freeze({
    bounds: Object.freeze({min:Object.freeze([...bounds.min]),max:Object.freeze([...bounds.max])}),
    crs, horizontalUnit, verticalUnit,
    labels: Object.freeze({ easting:'X (native)', northing:'Y (native)', elevation:'Z (native)' }),
  });
}
