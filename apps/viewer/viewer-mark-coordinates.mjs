import { createUtmProjection } from './utm-conversion.mjs';

// One box for typed coordinates. Detects, in this order:
//   UTM   "16T 500000 4767000", "500000mE 4767000mN" (zone optional: the project's zone is used)
//   DMS   43°03'12.5"N 87°54'10"W, 43 3 12.5 N 87 54 10 W, N43 3.2 W87 54.1 (degrees + decimal minutes too)
//   DD    43.0535, -87.9028 or 43.0535N 87.9028W
// Latitude comes first unless N/S/E/W letters say otherwise. No datum shift is
// applied: typed UTM is read in the project's own frame.

const UTM = /^\s*(?:(\d{1,2})\s*([C-HJ-NP-X])?\s+)?(?:E\s*)?(\d{6}(?:\.\d+)?)\s*(?:m?\s*E)?\s*[,;\s]\s*(?:N\s*)?(\d{6,8}(?:\.\d+)?)\s*(?:m?\s*N)?\s*$/i;

export function projectUtmZone(georef) {
  const zone = (Number(georef?.utmZoneLon0Deg) + 183) / 6;
  if (!Number.isInteger(zone) || zone < 1 || zone > 60) return null;
  return { zone, hemisphere: georef?.hemisphere === 'S' ? 'S' : 'N' };
}

function utmProjection({ zone, hemisphere }) {
  return createUtmProjection({ zoneLon0Deg: zone * 6 - 183, hemisphere });
}

const fail = error => ({ ok: false, error });
const inRange = (latitude, longitude) => Number.isFinite(latitude) && Number.isFinite(longitude)
  && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;

function parseUtm(match, georef) {
  const [, zoneText, band, eastingText, northingText] = match;
  const fallback = projectUtmZone(georef);
  const zone = zoneText ? Number(zoneText) : fallback?.zone;
  if (!zone) return fail('Add a UTM zone, like 16T 500000 4767000.');
  if (zone < 1 || zone > 60) return fail('UTM zones run from 1 to 60.');
  const hemisphere = band ? (band.toUpperCase() >= 'N' ? 'N' : 'S') : zoneText ? 'N' : fallback.hemisphere;
  const easting = Number(eastingText), northing = Number(northingText);
  if (easting < 100000 || easting > 900000 || northing > 10000000) return fail('That UTM easting or northing is out of range.');
  const [latitude, longitude] = utmProjection({ zone, hemisphere }).utmToLatLon(easting, northing);
  if (!inRange(latitude, longitude)) return fail('That UTM position is out of range.');
  return { ok: true, format: 'UTM', latitude, longitude, utm: { zone, hemisphere, easting, northing } };
}

function axisValue(numbers, letter) {
  if (!numbers.length || numbers.length > 3) return null;
  const [degrees, minutes = 0, seconds = 0] = numbers;
  if (numbers.slice(1).some(value => value < 0 || value >= 60)) return null;
  if (numbers.length > 1 && !Number.isInteger(degrees)) return null;
  if (numbers.length > 2 && !Number.isInteger(minutes)) return null;
  const negative = degrees < 0 || Object.is(degrees, -0);
  if (negative && letter) return null;
  const value = Math.abs(degrees) + minutes / 60 + seconds / 3600;
  return negative || letter === 'S' || letter === 'W' ? -value : value;
}

function parseAngles(text) {
  const tokens = text.toUpperCase().replace(/[°º'′’"″”]/g, ' ').match(/-?\d+(?:\.\d+)?|[NSEW]|,|[^\s\d.,NSEW-]+/g) || [];
  if (tokens.some(token => /^[^\d,NSEW-]/.test(token) && !/^[NSEW]$/.test(token))) return fail('Use numbers and N, S, E or W only.');
  const letters = tokens.filter(token => /^[NSEW]$/.test(token));
  let axes = [];
  if (letters.length) {
    if (letters.length !== 2) return fail('Give one N/S and one E/W letter.');
    const prefix = /^[NSEW]$/.test(tokens.find(token => token !== ','));
    let current = { numbers: [], letter: null };
    for (const token of tokens) {
      if (token === ',') continue;
      if (/^[NSEW]$/.test(token)) {
        if (prefix) {
          if (current.letter || current.numbers.length) axes.push(current);
          current = { numbers: [], letter: token };
        } else {
          current.letter = token;
          axes.push(current);
          current = { numbers: [], letter: null };
        }
      } else current.numbers.push(Number(token));
    }
    if (prefix) axes.push(current);
    else if (current.numbers.length) return fail('Put a letter after each value.');
  } else {
    const comma = tokens.indexOf(',');
    const numbers = tokens.filter(token => token !== ',').map(Number);
    if (comma >= 0 && tokens.lastIndexOf(',') === comma) {
      axes = [tokens.slice(0, comma), tokens.slice(comma + 1)].map(part => ({ numbers: part.map(Number), letter: null }));
    } else if ([2, 4, 6].includes(numbers.length)) {
      const size = numbers.length / 2;
      axes = [numbers.slice(0, size), numbers.slice(size)].map(part => ({ numbers: part, letter: null }));
    } else return fail('Enter latitude and longitude.');
  }
  if (axes.length !== 2) return fail('Enter latitude and longitude.');
  const [first, second] = axes;
  const latitudeAxis = second.letter === 'N' || second.letter === 'S' || first.letter === 'E' || first.letter === 'W' ? second : first;
  const longitudeAxis = latitudeAxis === first ? second : first;
  if ((latitudeAxis.letter && !'NS'.includes(latitudeAxis.letter)) || (longitudeAxis.letter && !'EW'.includes(longitudeAxis.letter)))
    return fail('Give one N/S and one E/W letter.');
  const latitude = axisValue(latitudeAxis.numbers, latitudeAxis.letter);
  const longitude = axisValue(longitudeAxis.numbers, longitudeAxis.letter);
  if (latitude === null || longitude === null) return fail('Minutes and seconds must be under 60.');
  if (!inRange(latitude, longitude)) return fail('Latitude must be within 90 and longitude within 180.');
  const format = axes.every(axis => axis.numbers.length === 1) ? 'DD' : 'DMS';
  return { ok: true, format, latitude, longitude };
}

export function parseCoordinateInput(text, { georef } = {}) {
  const value = String(text ?? '').trim();
  if (!value) return fail('');
  if (value.length > 120) return fail('That is too long for a coordinate.');
  const utm = value.match(UTM);
  if (utm) return parseUtm(utm, georef);
  return parseAngles(value);
}

export function formatDecimal(latitude, longitude) {
  return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
}

function dms(value, positive, negative) {
  const absolute = Math.abs(value);
  let degrees = Math.floor(absolute), minutes = Math.floor((absolute - degrees) * 60);
  let seconds = Math.round(((absolute - degrees) * 60 - minutes) * 60 * 100) / 100;
  if (seconds >= 60) { seconds = 0; minutes += 1; }
  if (minutes >= 60) { minutes = 0; degrees += 1; }
  return `${degrees}°${String(minutes).padStart(2, '0')}'${seconds.toFixed(2).padStart(5, '0')}"${value < 0 ? negative : positive}`;
}

export function formatDms(latitude, longitude) {
  return `${dms(latitude, 'N', 'S')} ${dms(longitude, 'E', 'W')}`;
}

export function formatUtm(latitude, longitude, georef) {
  const zone = projectUtmZone(georef);
  if (!zone) return null;
  const [easting, northing] = utmProjection(zone).latLonToUtm(latitude, longitude);
  if (!Number.isFinite(easting) || !Number.isFinite(northing)) return null;
  return `${zone.zone}${zone.hemisphere} ${easting.toFixed(2)} E ${northing.toFixed(2)} N`;
}

// Heights are NAVD88 elevation (orthometric), stored in metres.
const FEET_PER_METRE = 3.28084;
export function elevationToMetres(text, units) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  const number = Number(value.replace(/,/g, ''));
  if (!Number.isFinite(number)) return NaN;
  return units === 'metric' ? number : number / FEET_PER_METRE;
}
export function elevationForDisplay(metres, units) {
  if (!Number.isFinite(metres)) return '';
  return (units === 'metric' ? metres : metres * FEET_PER_METRE).toFixed(2);
}
export const elevationUnit = units => (units === 'metric' ? 'm' : 'ft');
