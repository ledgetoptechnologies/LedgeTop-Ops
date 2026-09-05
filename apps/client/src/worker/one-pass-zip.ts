import { crc32, uniqueZipEntryNames } from "./zip";

const encoder = new TextEncoder();
const ZIP64_EXTRA = 0x0001;
export const ZIP_SOURCE_READ_CHUNK = 8 * 1024 * 1024;
export const ZIP_MULTIPART_MAX_PART = 32 * 1024 * 1024;
export const ZIP_MULTIPART_MIN_PART = 5 * 1024 * 1024;

function u16(value: number): Uint8Array { return Uint8Array.from([value & 0xff, (value >>> 8) & 0xff]); }
function u32(value: number): Uint8Array { return Uint8Array.from([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]); }
function u64(value: number): Uint8Array {
  let current = BigInt(value); const result = new Uint8Array(8);
  for (let index = 0; index < 8; index += 1) { result[index] = Number(current & 0xffn); current >>= 8n; }
  return result;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0)); let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function zip64Extra(size: number, offset?: number): Uint8Array {
  const values = offset === undefined ? [size, size] : [size, size, offset];
  return concat(u16(ZIP64_EXTRA), u16(values.length * 8), ...values.map(u64));
}

export interface OnePassZipEntry {
  key: string;
  physicalKey: string;
  name: string;
  size: number;
  etag: string;
  /** Present only when the exact key + ETag + size checksum was cached. */
  crc32?: number;
}

export interface OnePassZipState {
  entryIndex: number;
  stage: "header" | "data" | "descriptor" | "done";
  segmentOffset: number;
  sourceOffset: number;
  crcState: number;
  entryCrc32: number | null;
  archiveOffset: number;
  completedFiles: number;
}

export interface OnePassZipChecksum {
  entryIndex: number;
  crc32: number;
  calculated: boolean;
}

export interface OnePassZipPartResult {
  bytes: Uint8Array;
  state: OnePassZipState;
  completedChecksums: OnePassZipChecksum[];
  sourceBytesRead: number;
}

export interface OnePassZipBucket {
  get(key: string, options: {
    range: { offset: number; length: number };
    onlyIf: { etagMatches: string };
  }): Promise<{ arrayBuffer?: () => Promise<ArrayBuffer> } | null>;
}

export interface OnePassZipMultipartPlan {
  prefixSize: number;
  trailerSize: number;
  archiveSize: number;
  partSize: number;
  prefixPartCount: number;
  finalPrefixBytes: number;
  partCount: number;
}

export function initialOnePassZipState(): OnePassZipState {
  return { entryIndex: 0, stage: "header", segmentOffset: 0, sourceOffset: 0, crcState: 0xffffffff, entryCrc32: null, archiveOffset: 0, completedFiles: 0 };
}

function localHeader(entry: OnePassZipEntry, name: string): Uint8Array {
  const nameValue = encoder.encode(name); const extra = zip64Extra(entry.size);
  // Bit 3 means the CRC follows in a data descriptor. Keeping one wire format
  // for cached and newly calculated checksums makes Workflow replay stable.
  return concat(u32(0x04034b50), u16(45), u16(0x0808), u16(0), u16(0), u16(0),
    u32(0), u32(0xffffffff), u32(0xffffffff), u16(nameValue.length), u16(extra.length), nameValue, extra);
}

function descriptor(entry: OnePassZipEntry, checksum: number): Uint8Array {
  return concat(u32(0x08074b50), u32(checksum), u64(entry.size), u64(entry.size));
}

export function onePassZipPrefixSize(entries: readonly Pick<OnePassZipEntry, "name" | "size">[]): number {
  const names = uniqueZipEntryNames(entries.map(entry => entry.name));
  let total = 0;
  entries.forEach((entry, index) => {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error("ZIP entry size is invalid");
    total += 50 + encoder.encode(names[index]!).length + entry.size + 24;
    if (!Number.isSafeInteger(total)) throw new Error("ZIP archive size is invalid");
  });
  return total;
}

export function onePassZipTrailerSize(entries: readonly Pick<OnePassZipEntry, "name">[]): number {
  const names = uniqueZipEntryNames(entries.map(entry => entry.name));
  return names.reduce((total, name) => total + 74 + encoder.encode(name).length, 98);
}

/**
 * R2 requires every multipart part except the last to have one uniform size.
 * Pick a deterministic size at or below 32 MiB whose prefix remainder plus
 * the central directory fits in the final part.
 */
export function planOnePassZipMultipart(entries: readonly Pick<OnePassZipEntry, "name" | "size">[]): OnePassZipMultipartPlan {
  const prefixSize = onePassZipPrefixSize(entries);
  const trailerSize = onePassZipTrailerSize(entries);
  const archiveSize = prefixSize + trailerSize;
  if (archiveSize <= ZIP_MULTIPART_MAX_PART) {
    return { prefixSize, trailerSize, archiveSize, partSize: archiveSize, prefixPartCount: 0, finalPrefixBytes: prefixSize, partCount: 1 };
  }
  for (let count = Math.ceil(prefixSize / ZIP_MULTIPART_MAX_PART); count <= Math.floor(prefixSize / ZIP_MULTIPART_MIN_PART); count += 1) {
    const partSize = Math.floor(prefixSize / count);
    const finalPrefixBytes = prefixSize - (count * partSize);
    if (partSize < ZIP_MULTIPART_MIN_PART || partSize > ZIP_MULTIPART_MAX_PART) continue;
    if (finalPrefixBytes + trailerSize <= partSize) {
      return { prefixSize, trailerSize, archiveSize, partSize, prefixPartCount: count, finalPrefixBytes, partCount: count + 1 };
    }
  }
  throw new Error("multipart-layout-capacity");
}

function copySegment(output: Uint8Array, outputOffset: number, segment: Uint8Array, segmentOffset: number): number {
  const length = Math.min(output.length - outputOffset, segment.length - segmentOffset);
  if (length > 0) output.set(segment.subarray(segmentOffset, segmentOffset + length), outputOffset);
  return length;
}

/** Build the next exact prefix bytes, reading each source range at most once. */
export async function buildOnePassZipPrefixPart(
  bucket: OnePassZipBucket,
  entries: readonly OnePassZipEntry[],
  inputState: Readonly<OnePassZipState>,
  length: number,
): Promise<OnePassZipPartResult> {
  if (!Number.isSafeInteger(length) || length < 0 || length > ZIP_MULTIPART_MAX_PART) throw new Error("ZIP part length is invalid");
  const names = uniqueZipEntryNames(entries.map(entry => entry.name));
  const state: OnePassZipState = { ...inputState };
  const output = new Uint8Array(length);
  const completedChecksums: OnePassZipChecksum[] = [];
  let outputOffset = 0;
  let sourceBytesRead = 0;

  while (outputOffset < output.length && state.stage !== "done") {
    const entry = entries[state.entryIndex];
    if (!entry) { state.stage = "done"; break; }
    if (state.stage === "header") {
      const header = localHeader(entry, names[state.entryIndex]!);
      const copied = copySegment(output, outputOffset, header, state.segmentOffset);
      outputOffset += copied; state.segmentOffset += copied; state.archiveOffset += copied;
      if (state.segmentOffset === header.length) { state.stage = "data"; state.segmentOffset = 0; }
      continue;
    }
    if (state.stage === "data") {
      const remaining = entry.size - state.sourceOffset;
      if (remaining > 0) {
        const readLength = Math.min(remaining, output.length - outputOffset, ZIP_SOURCE_READ_CHUNK);
        const object = await bucket.get(entry.physicalKey, {
          range: { offset: state.sourceOffset, length: readLength },
          onlyIf: { etagMatches: entry.etag },
        });
        if (!object?.arrayBuffer) throw new Error("source-changed-or-disappeared");
        const bytes = new Uint8Array(await object.arrayBuffer());
        if (bytes.length !== readLength) throw new Error("source-short-read");
        output.set(bytes, outputOffset);
        if (entry.crc32 === undefined) state.crcState = crc32(bytes, state.crcState);
        outputOffset += bytes.length; state.sourceOffset += bytes.length; state.archiveOffset += bytes.length;
        sourceBytesRead += bytes.length;
      }
      if (state.sourceOffset === entry.size) {
        state.entryCrc32 = entry.crc32 ?? ((state.crcState ^ 0xffffffff) >>> 0);
        state.stage = "descriptor";
        state.segmentOffset = 0;
      }
      continue;
    }
    const value = descriptor(entry, state.entryCrc32!);
    const copied = copySegment(output, outputOffset, value, state.segmentOffset);
    outputOffset += copied; state.segmentOffset += copied; state.archiveOffset += copied;
    if (state.segmentOffset === value.length) {
      completedChecksums.push({ entryIndex: state.entryIndex, crc32: state.entryCrc32!, calculated: entry.crc32 === undefined });
      state.entryIndex += 1; state.completedFiles = state.entryIndex; state.stage = state.entryIndex === entries.length ? "done" : "header";
      state.segmentOffset = 0; state.sourceOffset = 0; state.crcState = 0xffffffff; state.entryCrc32 = null;
    }
  }
  if (outputOffset !== output.length) throw new Error("ZIP prefix part was shorter than planned");
  return { bytes: output, state, completedChecksums, sourceBytesRead };
}

export function buildOnePassZipTrailer(entries: readonly Required<Pick<OnePassZipEntry, "name" | "size" | "crc32">>[]): Uint8Array {
  const names = uniqueZipEntryNames(entries.map(entry => entry.name));
  const central: Uint8Array[] = [];
  let localOffset = 0;
  entries.forEach((entry, index) => {
    const name = encoder.encode(names[index]!); const extra = zip64Extra(entry.size, localOffset);
    central.push(concat(u32(0x02014b50), u16(45), u16(45), u16(0x0808), u16(0), u16(0), u16(0),
      u32(entry.crc32), u32(0xffffffff), u32(0xffffffff), u16(name.length), u16(extra.length), u16(0), u16(0), u16(0),
      u32(0), u32(0xffffffff), name, extra));
    localOffset += 50 + name.length + entry.size + 24;
  });
  const centralBytes = concat(...central); const zip64Offset = localOffset + centralBytes.length;
  return concat(
    centralBytes,
    u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(entries.length), u64(entries.length), u64(centralBytes.length), u64(localOffset),
    u32(0x07064b50), u32(0), u64(zip64Offset), u32(1),
    u32(0x06054b50), u16(0xffff), u16(0xffff), u16(0xffff), u16(0xffff), u32(0xffffffff), u32(0xffffffff), u16(0),
  );
}

export function joinZipBytes(left: Uint8Array, right: Uint8Array): Uint8Array { return concat(left, right); }
