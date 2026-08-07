export type ImageLocationExifResult =
  | { state: "ready"; latitude: number; longitude: number }
  | { state: "absent" }
  | { state: "invalid" };

type ParseResult = ImageLocationExifResult;

const JPEG_APP1 = 0xe1;
const GPS_IFD_TAG = 0x8825;
const GPS_LATITUDE_REF = 0x0001;
const GPS_LATITUDE = 0x0002;
const GPS_LONGITUDE_REF = 0x0003;
const GPS_LONGITUDE = 0x0004;
const MAX_IFD_ENTRIES = 1024;
const COORDINATE_DECIMALS = 6;
export const IMAGE_LOCATION_EXIF_MAX_BYTES = 512 * 1024;

function hasBytes(bytes: Uint8Array, offset: number, length: number): boolean {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(length) &&
    offset >= 0 && length >= 0 && offset <= bytes.length - length;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string | null {
  if (!hasBytes(bytes, offset, length)) return null;
  let value = "";
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(bytes[offset + index]!);
  return value;
}

function startsWith(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return hasBytes(bytes, offset, expected.length) && expected.every((value, index) => bytes[offset + index] === value);
}

function parseExifPayload(payload: Uint8Array): ParseResult {
  const tiff = startsWith(payload, 0, [0x45, 0x78, 0x69, 0x66, 0, 0]) ? payload.subarray(6) : payload;
  return parseTiffGps(tiff);
}

function parseJpeg(bytes: Uint8Array): ParseResult {
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return { state: "invalid" };
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return { state: "invalid" };
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) return { state: "absent" };
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (!hasBytes(bytes, offset, 2)) return { state: "invalid" };
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || !hasBytes(bytes, offset, length)) return { state: "invalid" };
    const payloadStart = offset + 2;
    const payloadLength = length - 2;
    if (marker === JPEG_APP1 && startsWith(bytes, payloadStart, [0x45, 0x78, 0x69, 0x66, 0, 0])) {
      return parseExifPayload(bytes.subarray(payloadStart, payloadStart + payloadLength));
    }
    offset += length;
  }
  return { state: "invalid" };
}

function parsePng(bytes: Uint8Array): ParseResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset < bytes.length) {
    if (!hasBytes(bytes, offset, 12)) return { state: "invalid" };
    const length = view.getUint32(offset, false);
    const type = ascii(bytes, offset + 4, 4);
    if (length > bytes.length - offset - 12) return { state: "invalid" };
    const dataStart = offset + 8;
    if (type === "eXIf") return parseExifPayload(bytes.subarray(dataStart, dataStart + length));
    offset += 12 + length;
    if (type === "IEND") return length === 0 ? { state: "absent" } : { state: "invalid" };
  }
  return { state: "invalid" };
}

function parseWebp(bytes: Uint8Array): ParseResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!hasBytes(bytes, 0, 12)) return { state: "invalid" };
  const declaredSize = view.getUint32(4, true);
  if (declaredSize < 4) return { state: "invalid" };
  const declaredEnd = 8 + declaredSize;
  const end = Math.min(declaredEnd, bytes.length);
  let offset = 12;
  while (offset < end) {
    if (offset > end - 8) return { state: "invalid" };
    const type = ascii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    if (length > end - dataStart) return { state: "invalid" };
    if (type === "EXIF") return parseExifPayload(bytes.subarray(dataStart, dataStart + length));
    const paddedLength = length + (length % 2);
    if (paddedLength > end - dataStart) return { state: "invalid" };
    offset = dataStart + paddedLength;
  }
  return offset === end && declaredEnd <= bytes.length ? { state: "absent" } : { state: "invalid" };
}

function parseTiffGps(bytes: Uint8Array): ParseResult {
  if (!hasBytes(bytes, 0, 8)) return { state: "invalid" };
  const byteOrder = ascii(bytes, 0, 2);
  if (byteOrder !== "II" && byteOrder !== "MM") return { state: "invalid" };
  const littleEndian = byteOrder === "II";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number): number | null => hasBytes(bytes, offset, 2) ? view.getUint16(offset, littleEndian) : null;
  const u32 = (offset: number): number | null => hasBytes(bytes, offset, 4) ? view.getUint32(offset, littleEndian) : null;
  if (u16(2) !== 42) return { state: "invalid" };
  const firstIfdOffset = u32(4);
  if (firstIfdOffset === null || firstIfdOffset < 8) return { state: "invalid" };
  const firstIfd = readIfd(bytes, view, littleEndian, firstIfdOffset);
  if (!firstIfd) return { state: "invalid" };

  const gpsPointers = firstIfd.filter((entry) => entry.tag === GPS_IFD_TAG);
  if (!gpsPointers.length) return { state: "absent" };
  if (gpsPointers.length !== 1) return { state: "invalid" };
  const pointer = gpsPointers[0]!;
  if (pointer.type !== 4 || pointer.count !== 1 || pointer.valueOffset < 8) return { state: "invalid" };
  const gpsIfd = readIfd(bytes, view, littleEndian, pointer.valueOffset);
  if (!gpsIfd) return { state: "invalid" };

  const latitudeRef = gpsIfd.filter((entry) => entry.tag === GPS_LATITUDE_REF);
  const latitude = gpsIfd.filter((entry) => entry.tag === GPS_LATITUDE);
  const longitudeRef = gpsIfd.filter((entry) => entry.tag === GPS_LONGITUDE_REF);
  const longitude = gpsIfd.filter((entry) => entry.tag === GPS_LONGITUDE);
  const found = latitudeRef.length + latitude.length + longitudeRef.length + longitude.length;
  if (found === 0) return { state: "absent" };
  if ([latitudeRef, latitude, longitudeRef, longitude].some((entries) => entries.length !== 1)) return { state: "invalid" };

  const latRef = readReference(bytes, latitudeRef[0]!, "N", "S");
  const lonRef = readReference(bytes, longitudeRef[0]!, "E", "W");
  const lat = readCoordinate(bytes, view, littleEndian, latitude[0]!, 90);
  const lon = readCoordinate(bytes, view, littleEndian, longitude[0]!, 180);
  if (!latRef || !lonRef || lat === null || lon === null) return { state: "invalid" };

  const signedLatitude = latRef === "S" ? -lat : lat;
  const signedLongitude = lonRef === "W" ? -lon : lon;
  const roundedLatitude = roundCoordinate(signedLatitude);
  const roundedLongitude = roundCoordinate(signedLongitude);
  if (!Number.isFinite(roundedLatitude) || !Number.isFinite(roundedLongitude) ||
    roundedLatitude < -90 || roundedLatitude > 90 || roundedLongitude < -180 || roundedLongitude > 180) {
    return { state: "invalid" };
  }
  return { state: "ready", latitude: roundedLatitude, longitude: roundedLongitude };
}

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  valueOffset: number;
  valueFieldOffset: number;
}

function readIfd(
  bytes: Uint8Array,
  view: DataView,
  littleEndian: boolean,
  offset: number,
): IfdEntry[] | null {
  if (!hasBytes(bytes, offset, 2)) return null;
  const count = view.getUint16(offset, littleEndian);
  if (count > MAX_IFD_ENTRIES || !hasBytes(bytes, offset + 2, count * 12 + 4)) return null;
  const entries: IfdEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset + 2 + index * 12;
    entries.push({
      tag: view.getUint16(entryOffset, littleEndian),
      type: view.getUint16(entryOffset + 2, littleEndian),
      count: view.getUint32(entryOffset + 4, littleEndian),
      valueOffset: view.getUint32(entryOffset + 8, littleEndian),
      valueFieldOffset: entryOffset + 8,
    });
  }
  return entries;
}

function readReference(bytes: Uint8Array, entry: IfdEntry, positive: string, negative: string): string | null {
  if (entry.type !== 2 || entry.count !== 2) return null;
  const value = ascii(bytes, entry.valueFieldOffset, 2);
  return value && value[1] === "\0" && (value[0] === positive || value[0] === negative) ? value[0]! : null;
}

function readCoordinate(
  bytes: Uint8Array,
  view: DataView,
  littleEndian: boolean,
  entry: IfdEntry,
  maxDegrees: number,
): number | null {
  if (entry.type !== 5 || entry.count !== 3 || !hasBytes(bytes, entry.valueOffset, 24)) return null;
  const values: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    const offset = entry.valueOffset + index * 8;
    const numerator = view.getUint32(offset, littleEndian);
    const denominator = view.getUint32(offset + 4, littleEndian);
    if (denominator === 0) return null;
    const value = numerator / denominator;
    if (!Number.isFinite(value)) return null;
    values.push(value);
  }
  const [degrees, minutes, seconds] = values;
  if (degrees === undefined || minutes === undefined || seconds === undefined ||
    degrees < 0 || degrees > maxDegrees || minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60 ||
    (degrees === maxDegrees && (minutes !== 0 || seconds !== 0))) return null;
  const coordinate = degrees + minutes / 60 + seconds / 3600;
  return Number.isFinite(coordinate) && coordinate <= maxDegrees ? coordinate : null;
}

function roundCoordinate(value: number): number {
  const rounded = Math.round(value * 10 ** COORDINATE_DECIMALS) / 10 ** COORDINATE_DECIMALS;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Parses GPS coordinates from a caller-bounded image prefix or complete image.
 * Only rounded latitude/longitude are returned; raw EXIF, timestamps, and
 * camera direction are deliberately discarded.
 */
export function parseImageGps(input: ArrayBuffer | Uint8Array): ImageLocationExifResult {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > IMAGE_LOCATION_EXIF_MAX_BYTES) return { state: "invalid" };
  if (startsWith(bytes, 0, [0xff, 0xd8])) return parseJpeg(bytes);
  if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return parsePng(bytes);
  if (startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 4) === "WEBP") return parseWebp(bytes);
  if (startsWith(bytes, 0, [0x45, 0x78, 0x69, 0x66, 0, 0]) || ascii(bytes, 0, 2) === "II" || ascii(bytes, 0, 2) === "MM") {
    return parseExifPayload(bytes);
  }
  return { state: "absent" };
}

export const extractImageLocationExif = parseImageGps;
