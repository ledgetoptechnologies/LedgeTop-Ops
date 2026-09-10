/**
 * Pure naming and transfer planning for the future TrueNAS rclone pickup.
 *
 * This module deliberately performs no R2, D1, filesystem, or rclone work.
 * In particular, building a plan is not evidence that a server downloaded an
 * object.  The original upload name remains display metadata; only the
 * sanitized basename is used in an R2 ready key or a Windows destination.
 */

// Mirrors validateIncomingFile's present maximum. Keep an activation change
// coupled to that validator if either limit changes.
export const INCOMING_MAX_BYTES = 2 * 1024 ** 4;
export const R2_MULTIPART_MIN_PART_BYTES = 5 * 1024 ** 2;
export const R2_MULTIPART_MAX_PART_BYTES = 5 * 1024 ** 3;
export const R2_MULTIPART_MAX_PARTS = 10_000;

const OPAQUE_ID = /^[A-Za-z0-9_-]{8,200}$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\..*)?$/i;
const encoder = new TextEncoder();

export type RcloneTransferMode = "copy" | "move";

export type MultipartCopyPlan = {
  sourceBytes: number;
  partBytes: number;
  partCount: number;
  lastPartBytes: number;
};

export type IncomingRcloneReadyPlan = {
  sourceKey: string;
  readyKey: string;
  destinationPath: string;
  safeBasename: string;
  transferMode: RcloneTransferMode;
  multipartCopy: MultipartCopyPlan;
};

function requireOpaqueId(label: string, value: string): void {
  if (!OPAQUE_ID.test(value)) throw new Error(`Invalid incoming ${label}`);
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let used = 0;
  for (const character of value) {
    const bytes = encoder.encode(character).byteLength;
    if (used + bytes > maxBytes) break;
    result += character;
    used += bytes;
  }
  return result;
}

function isWindowsReserved(value: string): boolean {
  // NFKC catches Windows device aliases written with superscript digits, such
  // as COM¹ and LPT³, without changing ordinary display-derived Unicode.
  return WINDOWS_RESERVED.test(value.normalize("NFKC"));
}

function truncateBasenamePreservingExtension(value: string): string {
  if (encoder.encode(value).byteLength <= 255) return value;
  const dot = value.lastIndexOf(".");
  const extension = dot > 0 ? value.slice(dot) : "";
  // Preserve a useful extension when it fits.  Very long extensions have no
  // practical Windows value, so safely truncate the complete basename instead.
  if (extension && encoder.encode(extension).byteLength < 255) {
    const stem = truncateUtf8(value.slice(0, dot), 255 - encoder.encode(extension).byteLength);
    if (stem) return `${stem}${extension}`;
  }
  return truncateUtf8(value, 255);
}

/**
 * Produce one deterministic, Windows-compatible basename (never a path).
 * The returned relative path has safe components; callers must still account
 * for their configured destination root when enforcing a full-path limit.
 */
export function sanitizeIncomingReadyBasename(originalName: string): string {
  if (typeof originalName !== "string") throw new Error("Invalid incoming file name");
  // \p{C} includes ASCII/C1 controls and Unicode format controls such as RLO.
  let value = originalName.normalize("NFC")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\p{C}/gu, "_")
    .trim()
    .replace(/[. ]+$/g, "");
  if (!value || value === "." || value === "..") value = "upload";
  if (isWindowsReserved(value)) value = `_${value}`;
  value = truncateBasenamePreservingExtension(value).replace(/[. ]+$/g, "");
  // Truncation cannot normally create these values, but retain the invariant.
  if (!value || value === "." || value === "..") return "upload";
  return isWindowsReserved(value) ? `_${value}` : value;
}

/**
 * Plans bounded multipart transfer boundaries without opening object bytes.
 * It does not select or promise a provider copy primitive: activation must
 * verify the R2 API used by that deployment supports these boundaries.
 */
export function planIncomingMultipartCopy(sourceBytes: number): MultipartCopyPlan {
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes <= 0 || sourceBytes > INCOMING_MAX_BYTES) {
    throw new Error("Incoming object size is outside the supported range");
  }
  const required = Math.ceil(sourceBytes / R2_MULTIPART_MAX_PARTS);
  const partBytes = Math.max(R2_MULTIPART_MIN_PART_BYTES, Math.ceil(required / R2_MULTIPART_MIN_PART_BYTES) * R2_MULTIPART_MIN_PART_BYTES);
  if (partBytes > R2_MULTIPART_MAX_PART_BYTES) throw new Error("Incoming object requires an unsupported multipart copy plan");
  const partCount = Math.ceil(sourceBytes / partBytes);
  if (partCount > R2_MULTIPART_MAX_PARTS) throw new Error("Incoming object requires too many multipart copy parts");
  return { sourceBytes, partBytes, partCount, lastPartBytes: sourceBytes - partBytes * (partCount - 1) };
}

export function buildIncomingRcloneReadyPlan(input: {
  requestId: string;
  uploadId: string;
  originalName: string;
  sourceBytes: number;
  transferMode: RcloneTransferMode;
}): IncomingRcloneReadyPlan {
  requireOpaqueId("request id", input.requestId);
  requireOpaqueId("upload id", input.uploadId);
  if (input.transferMode !== "copy" && input.transferMode !== "move") throw new Error("Invalid rclone transfer mode");
  const safeBasename = sanitizeIncomingReadyBasename(input.originalName);
  const sourceKey = `quarantine/${input.requestId}/${input.uploadId}/object`;
  const destinationPath = `${input.requestId}/${input.uploadId}/${safeBasename}`;
  return {
    sourceKey,
    readyKey: `ready/${destinationPath}`,
    destinationPath,
    safeBasename,
    transferMode: input.transferMode,
    multipartCopy: planIncomingMultipartCopy(input.sourceBytes),
  };
}
