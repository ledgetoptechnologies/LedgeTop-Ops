export const CONTAINER_IMAGE_MAX_INPUT_BYTES = 512 * 1024 * 1024;
export const CONTAINER_PDF_MAX_INPUT_BYTES = 256 * 1024 * 1024;
export const CONTAINER_RENDER_MAX_OUTPUT_BYTES = 128 * 1024;
export const CONTAINER_RENDER_WIDTH = 320;
export const CONTAINER_RENDER_HEIGHT = 240;
export const CONTAINER_RENDER_MAX_PIXELS = 110_000_000;
export const THUMBNAIL_RENDER_PROFILE = "ltds-thumbnail-320x240-webp-v1";

export type ContainerThumbnailKind = "image" | "pdf" | "video";
export interface ContainerThumbnailRequest { kind: ContainerThumbnailKind; expectedSize: number }
export type ContainerThumbnailErrorCode =
  | "encrypted_pdf"
  | "invalid_input"
  | "invalid_request"
  | "invalid_output"
  | "metadata_not_stripped"
  | "output_too_large"
  | "pdf_page_limit"
  | "pixel_limit_exceeded"
  | "render_failed"
  | "render_timeout"
  | "resource_exhausted"
  | "unsupported_format";
export type ContainerThumbnailResult =
  | { ok: true; bytes: ArrayBuffer; contentType: "image/webp" }
  | { ok: false; errorCode: ContainerThumbnailErrorCode; message: string };

export class ThumbnailRendererError extends Error {
  constructor(readonly code: ContainerThumbnailErrorCode, message: string) {
    super(message);
    this.name = "ThumbnailRendererError";
  }
}

export function validateContainerThumbnailRequest(value: ContainerThumbnailRequest): void {
  if (value.kind !== "image" && value.kind !== "pdf") {
    throw new ThumbnailRendererError("invalid_request", "Unsupported container thumbnail kind");
  }
  const maximum = value.kind === "pdf" ? CONTAINER_PDF_MAX_INPUT_BYTES : CONTAINER_IMAGE_MAX_INPUT_BYTES;
  if (!Number.isSafeInteger(value.expectedSize) || value.expectedSize <= 0 || value.expectedSize > maximum) {
    throw new ThumbnailRendererError("invalid_request", "Container thumbnail source size is outside its safe limit");
  }
}

export function inspectWebp(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 20 || bytes.byteLength > CONTAINER_RENDER_MAX_OUTPUT_BYTES) return null;
  const ascii = (start: number, end: number) => new TextDecoder().decode(bytes.subarray(start, end));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 12) !== "WEBP") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.byteLength) return null;
  let offset = 12;
  let dimensions: { width: number; height: number } | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const chunk = ascii(offset, offset + 4);
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > bytes.byteLength) return null;
    if (["EXIF", "XMP ", "ICCP", "ANIM", "ANMF"].includes(chunk)) return null;
    if (chunk === "VP8X" && length >= 10) {
      dimensions = {
        width: 1 + bytes[start + 4]! + (bytes[start + 5]! << 8) + (bytes[start + 6]! << 16),
        height: 1 + bytes[start + 7]! + (bytes[start + 8]! << 8) + (bytes[start + 9]! << 16),
      };
    } else if (chunk === "VP8 " && length >= 10 && bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a) {
      dimensions = { width: view.getUint16(start + 6, true) & 0x3fff, height: view.getUint16(start + 8, true) & 0x3fff };
    } else if (chunk === "VP8L" && length >= 5 && bytes[start] === 0x2f) {
      const bits = view.getUint32(start + 1, true);
      dimensions = { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    offset = start + length + (length % 2);
  }
  return dimensions;
}

export function validWebp(bytes: Uint8Array): boolean {
  const dimensions = inspectWebp(bytes);
  return dimensions?.width === CONTAINER_RENDER_WIDTH && dimensions.height === CONTAINER_RENDER_HEIGHT;
}
