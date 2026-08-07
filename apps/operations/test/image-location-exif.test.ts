import { describe, expect, it } from "vitest";
import { IMAGE_LOCATION_EXIF_MAX_BYTES, parseImageGps } from "../src/worker/image-location-exif";

type Reference = "N" | "S" | "E" | "W";
type Rational = readonly [number, number];

function tiffLocation(input: {
  latitude?: readonly [Rational, Rational, Rational];
  longitude?: readonly [Rational, Rational, Rational];
  latitudeRef?: Reference;
  longitudeRef?: Reference;
} = {}): Uint8Array {
  const latitude = input.latitude ?? [[44, 1], [30, 1], [15, 1]];
  const longitude = input.longitude ?? [[88, 1], [7, 1], [30, 1]];
  const bytes = new Uint8Array(160);
  const view = new DataView(bytes.buffer);
  bytes.set([0x49, 0x49]);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, 1, true);
  view.setUint16(10, 0x8825, true);
  view.setUint16(12, 4, true);
  view.setUint32(14, 1, true);
  view.setUint32(18, 26, true);
  view.setUint32(22, 0, true);

  view.setUint16(26, 4, true);
  const entries = [
    { tag: 1, type: 2, count: 2, value: input.latitudeRef ?? "N" },
    { tag: 2, type: 5, count: 3, value: 80 },
    { tag: 3, type: 2, count: 2, value: input.longitudeRef ?? "E" },
    { tag: 4, type: 5, count: 3, value: 104 },
  ] as const;
  entries.forEach((entry, index) => {
    const offset = 28 + index * 12;
    view.setUint16(offset, entry.tag, true);
    view.setUint16(offset + 2, entry.type, true);
    view.setUint32(offset + 4, entry.count, true);
    if (typeof entry.value === "string") {
      bytes[offset + 8] = entry.value.charCodeAt(0);
      bytes[offset + 9] = 0;
    } else {
      view.setUint32(offset + 8, entry.value, true);
    }
  });
  view.setUint32(76, 0, true);
  latitude.forEach(([numerator, denominator], index) => {
    view.setUint32(80 + index * 8, numerator, true);
    view.setUint32(84 + index * 8, denominator, true);
  });
  longitude.forEach(([numerator, denominator], index) => {
    view.setUint32(104 + index * 8, numerator, true);
    view.setUint32(108 + index * 8, denominator, true);
  });
  return bytes;
}

function jpeg(tiff?: Uint8Array): Uint8Array {
  if (!tiff) return Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  const payload = new Uint8Array(6 + tiff.length);
  payload.set([0x45, 0x78, 0x69, 0x66, 0, 0]);
  payload.set(tiff, 6);
  const bytes = new Uint8Array(2 + 2 + 2 + payload.length + 2);
  bytes.set([0xff, 0xd8, 0xff, 0xe1]);
  const length = payload.length + 2;
  bytes[4] = length >>> 8;
  bytes[5] = length & 0xff;
  bytes.set(payload, 6);
  bytes.set([0xff, 0xd9], 6 + payload.length);
  return bytes;
}

function png(tiff: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + 12 + tiff.length + 12);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, tiff.length, false);
  bytes.set([0x65, 0x58, 0x49, 0x66], 12);
  bytes.set(tiff, 16);
  const iend = 20 + tiff.length;
  bytes.set([0x49, 0x45, 0x4e, 0x44], iend + 4);
  return bytes;
}

function webp(tiff: Uint8Array): Uint8Array {
  const padded = tiff.length + (tiff.length % 2);
  const bytes = new Uint8Array(12 + 8 + padded);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46]);
  view.setUint32(4, bytes.length - 8, true);
  bytes.set([0x57, 0x45, 0x42, 0x50, 0x45, 0x58, 0x49, 0x46], 8);
  view.setUint32(16, tiff.length, true);
  bytes.set(tiff, 20);
  return bytes;
}

describe("bounded image EXIF GPS parsing", () => {
  it("extracts and rounds valid JPEG coordinates without returning raw metadata", () => {
    const result = parseImageGps(jpeg(tiffLocation({
      latitude: [[44, 1], [30, 1], [1, 3]],
      longitude: [[88, 1], [7, 1], [2, 3]],
    })));
    expect(result).toEqual({ state: "ready", latitude: 44.500093, longitude: 88.116852 });
    expect(Object.keys(result).sort()).toEqual(["latitude", "longitude", "state"]);
  });

  it("applies south and west references", () => {
    expect(parseImageGps(jpeg(tiffLocation({ latitudeRef: "S", longitudeRef: "W" })))).toEqual({
      state: "ready",
      latitude: -44.504167,
      longitude: -88.125,
    });
  });

  it("returns absent for images without EXIF or without a GPS IFD", () => {
    expect(parseImageGps(jpeg())).toEqual({ state: "absent" });
    const noGps = tiffLocation();
    new DataView(noGps.buffer).setUint16(8, 0, true);
    expect(parseImageGps(noGps)).toEqual({ state: "absent" });
  });

  it("rejects malformed offsets and truncated JPEG segments", () => {
    const malformed = tiffLocation();
    new DataView(malformed.buffer).setUint32(18, 0xfffffff0, true);
    expect(parseImageGps(jpeg(malformed))).toEqual({ state: "invalid" });
    expect(parseImageGps(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0, 30, 0]))).toEqual({ state: "invalid" });
    expect(parseImageGps(new Uint8Array(IMAGE_LOCATION_EXIF_MAX_BYTES + 1))).toEqual({ state: "invalid" });
  });

  it("rejects out-of-range components and zero denominators", () => {
    expect(parseImageGps(tiffLocation({ latitude: [[91, 1], [0, 1], [0, 1]] }))).toEqual({ state: "invalid" });
    expect(parseImageGps(tiffLocation({ longitude: [[88, 1], [60, 1], [0, 1]] }))).toEqual({ state: "invalid" });
    expect(parseImageGps(tiffLocation({ latitude: [[44, 0], [0, 1], [0, 1]] }))).toEqual({ state: "invalid" });
  });

  it("parses TIFF GPS carried by PNG eXIf and WebP EXIF chunks", () => {
    const expected = { state: "ready", latitude: 44.504167, longitude: 88.125 };
    expect(parseImageGps(png(tiffLocation()))).toEqual(expected);
    expect(parseImageGps(webp(tiffLocation()))).toEqual(expected);
  });
});
