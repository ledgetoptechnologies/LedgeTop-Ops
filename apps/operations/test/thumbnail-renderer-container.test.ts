import { describe, expect, it } from "vitest";
import {
  CONTAINER_IMAGE_MAX_INPUT_BYTES,
  CONTAINER_PDF_MAX_INPUT_BYTES,
  CONTAINER_RENDER_MAX_OUTPUT_BYTES,
  CONTAINER_RENDER_MAX_PIXELS,
  ThumbnailRendererError,
  inspectWebp,
  validWebp,
  validateContainerThumbnailRequest,
} from "../src/worker/thumbnail-renderer-contract";

function webp(width = 320, height = 240, extraChunk?: string): Uint8Array {
  const extraLength = extraChunk ? 8 : 0;
  const bytes = new Uint8Array(30 + extraLength);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  new DataView(bytes.buffer).setUint32(4, bytes.byteLength - 8, true);
  bytes.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20], 8);
  new DataView(bytes.buffer).setUint32(16, 10, true);
  bytes.set([0, 0, 0, 0x9d, 0x01, 0x2a], 20);
  new DataView(bytes.buffer).setUint16(26, width, true);
  new DataView(bytes.buffer).setUint16(28, height, true);
  if (extraChunk) {
    bytes.set(new TextEncoder().encode(extraChunk), 30);
    new DataView(bytes.buffer).setUint32(34, 0, true);
  }
  return bytes;
}

describe("private thumbnail renderer boundary", () => {
  it("accepts only bounded image and PDF requests", () => {
    expect(() => validateContainerThumbnailRequest({ kind: "image", expectedSize: CONTAINER_IMAGE_MAX_INPUT_BYTES })).not.toThrow();
    expect(() => validateContainerThumbnailRequest({ kind: "pdf", expectedSize: CONTAINER_PDF_MAX_INPUT_BYTES })).not.toThrow();
    expect(() => validateContainerThumbnailRequest({ kind: "image", expectedSize: CONTAINER_IMAGE_MAX_INPUT_BYTES + 1 })).toThrow(ThumbnailRendererError);
    expect(() => validateContainerThumbnailRequest({ kind: "pdf", expectedSize: CONTAINER_PDF_MAX_INPUT_BYTES + 1 })).toThrow(ThumbnailRendererError);
    expect(() => validateContainerThumbnailRequest({ kind: "pdf", expectedSize: 0 })).toThrow(ThumbnailRendererError);
    expect(() => validateContainerThumbnailRequest({ kind: "image", expectedSize: 1.5 })).toThrow(ThumbnailRendererError);
    expect(() => validateContainerThumbnailRequest({ kind: "video", expectedSize: 1 } as never)).toThrow(ThumbnailRendererError);
    expect(CONTAINER_RENDER_MAX_PIXELS).toBe(110_000_000);
  });

  it("accepts only a complete 320x240 metadata-free RIFF WebP", () => {
    expect(inspectWebp(webp())).toEqual({ width: 320, height: 240 });
    expect(validWebp(webp())).toBe(true);
    expect(validWebp(webp(319, 240))).toBe(false);
    expect(validWebp(webp(320, 241))).toBe(false);
    expect(validWebp(webp(320, 240, "EXIF"))).toBe(false);
    expect(validWebp(webp(320, 240, "XMP "))).toBe(false);

    const badRiffLength = webp();
    new DataView(badRiffLength.buffer).setUint32(4, 0, true);
    expect(validWebp(badRiffLength)).toBe(false);
    expect(validWebp(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(validWebp(new Uint8Array(CONTAINER_RENDER_MAX_OUTPUT_BYTES + 1))).toBe(false);
  });
});
