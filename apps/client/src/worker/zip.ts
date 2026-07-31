export interface ZipSource {
  name: string;
  size: number;
  open(): Promise<ReadableStream<Uint8Array>>;
}

const encoder = new TextEncoder();
const ZIP64_EXTRA = 0x0001;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});

function u16(value: number): Uint8Array { return Uint8Array.from([value & 0xff, (value >>> 8) & 0xff]); }
function u32(value: number): Uint8Array { return Uint8Array.from([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]); }
function u64(value: number): Uint8Array {
  let current = BigInt(value); const result = new Uint8Array(8);
  for (let index = 0; index < 8; index += 1) { result[index] = Number(current & 0xffn); current >>= 8n; }
  return result;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0)); let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; } return result;
}
export function crc32(bytes: Uint8Array, previous = 0xffffffff): number {
  let crc = previous;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  return crc >>> 0;
}
function nameBytes(name: string): Uint8Array {
  const clean = name.replace(/[\0\x00-\x1f\x7f\\:*?"<>|]/g, "_") || "file";
  return encoder.encode(clean).slice(0, 240);
}
function zip64Extra(size: number, offset?: number): Uint8Array {
  const values = offset === undefined ? [size, size] : [size, size, offset];
  return concat(u16(ZIP64_EXTRA), u16(values.length * 8), ...values.map(u64));
}

// The writer emits ZIP64 records for every archive. This avoids a second pass
// just to decide whether a 32-bit offset or size will overflow and remains
// readable by ZIP64-capable clients for small archives.
export function streamZip(sources: ZipSource[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const central: Uint8Array[] = []; let offset = 0; let entryCount = 0;
      try {
        for (const source of sources) {
          if (!Number.isSafeInteger(source.size) || source.size < 0) throw new Error("ZIP entry size is invalid");
          const name = nameBytes(source.name); const extra = zip64Extra(source.size);
          const localOffset = offset;
          const local = concat(u32(0x04034b50), u16(45), u16(0x0808), u16(0), u16(0), u16(0), u32(0), u32(0xffffffff), u32(0xffffffff), u16(name.length), u16(extra.length), name, extra);
          controller.enqueue(local); offset += local.length;
          const reader = (await source.open()).getReader(); let crc = 0xffffffff; let size = 0;
          try {
            while (true) {
              const chunk = await reader.read(); if (chunk.done) break;
              if (chunk.value.byteLength) { crc = crc32(chunk.value, crc); size += chunk.value.byteLength; controller.enqueue(chunk.value); offset += chunk.value.byteLength; }
            }
          } finally { reader.releaseLock(); }
          if (size !== source.size) throw new Error("ZIP source changed while reading");
          crc = (crc ^ 0xffffffff) >>> 0;
          const descriptor = concat(u32(0x08074b50), u32(crc), u64(size), u64(size)); controller.enqueue(descriptor); offset += descriptor.length;
          const centralExtra = zip64Extra(size, localOffset);
          central.push(concat(u32(0x02014b50), u16(45), u16(45), u16(0x0808), u16(0), u16(0), u16(0), u32(crc), u32(0xffffffff), u32(0xffffffff), u16(name.length), u16(centralExtra.length), u16(0), u16(0), u16(0), u32(0), u32(0xffffffff), name, centralExtra));
          entryCount += 1;
        }
        const directoryOffset = offset; for (const entry of central) { controller.enqueue(entry); offset += entry.length; }
        const directorySize = offset - directoryOffset; const zip64Offset = offset;
        controller.enqueue(concat(u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(entryCount), u64(entryCount), u64(directorySize), u64(directoryOffset)));
        offset += 56;
        controller.enqueue(concat(u32(0x07064b50), u32(0), u64(zip64Offset), u32(1))); offset += 20;
        controller.enqueue(concat(u32(0x06054b50), u16(0xffff), u16(0xffff), u16(0xffff), u16(0xffff), u32(0xffffffff), u32(0xffffffff), u16(0)));
        controller.close();
      } catch (error) { controller.error(error); }
    },
  });
}

export interface ZipManifestEntry { key: string; name: string; size: number; crc32: number; etag?: string; }
export interface ZipArchiveLayout { entries: Array<ZipManifestEntry & { localOffset: number; local: Uint8Array }>; archiveSize: number; centralOffset: number; segments: Array<{ kind: "bytes" | "object"; offset: number; length: number; bytes?: Uint8Array; key?: string; etag?: string }>; }

export interface ZipRangeBucket { get(key: string, options?: { range: { offset: number; length: number }; onlyIf?: { etagMatches: string } }): Promise<{ arrayBuffer?: () => Promise<ArrayBuffer> } | null>; }

export function buildZipLayout(entries: ZipManifestEntry[]): ZipArchiveLayout {
  const layoutEntries: ZipArchiveLayout["entries"] = []; const segments: ZipArchiveLayout["segments"] = []; let offset = 0;
  for (const entry of entries) {
    const name = nameBytes(entry.name); const extra = zip64Extra(entry.size); const local = concat(u32(0x04034b50), u16(45), u16(0x0800), u16(0), u16(0), u16(0), u32(entry.crc32), u32(0xffffffff), u32(0xffffffff), u16(name.length), u16(extra.length), name, extra);
    const localOffset = offset; layoutEntries.push({ ...entry, localOffset, local }); segments.push({ kind: "bytes", offset, length: local.length, bytes: local }); offset += local.length;
    segments.push({ kind: "object", offset, length: entry.size, key: entry.key, etag: entry.etag }); offset += entry.size;
  }
  const centralOffset = offset; const central: Uint8Array[] = [];
  for (const entry of layoutEntries) {
    const name = nameBytes(entry.name); const extra = zip64Extra(entry.size, entry.localOffset);
    central.push(concat(u32(0x02014b50), u16(45), u16(45), u16(0x0800), u16(0), u16(0), u16(0), u32(entry.crc32), u32(0xffffffff), u32(0xffffffff), u16(name.length), u16(extra.length), u16(0), u16(0), u16(0), u32(0), u32(0xffffffff), name, extra));
  }
  const centralBytes = concat(...central); segments.push({ kind: "bytes", offset, length: centralBytes.length, bytes: centralBytes }); offset += centralBytes.length;
  const zip64EndOffset = offset;
  const zip64End = concat(u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(layoutEntries.length), u64(layoutEntries.length), u64(centralBytes.length), u64(centralOffset)); segments.push({ kind: "bytes", offset, length: zip64End.length, bytes: zip64End }); offset += zip64End.length;
  const locator = concat(u32(0x07064b50), u32(0), u64(zip64EndOffset), u32(1)); segments.push({ kind: "bytes", offset, length: locator.length, bytes: locator }); offset += locator.length;
  const end = concat(u32(0x06054b50), u16(0xffff), u16(0xffff), u16(0xffff), u16(0xffff), u32(0xffffffff), u32(0xffffffff), u16(0)); segments.push({ kind: "bytes", offset, length: end.length, bytes: end }); offset += end.length;
  return { entries: layoutEntries, archiveSize: offset, centralOffset, segments };
}

export async function readZipPart(bucket: ZipRangeBucket, layout: ZipArchiveLayout, start: number, length: number): Promise<Uint8Array> {
  const end = Math.min(layout.archiveSize, start + length); const output = new Uint8Array(Math.max(0, end - start));
  for (const segment of layout.segments) {
    const overlapStart = Math.max(start, segment.offset); const overlapEnd = Math.min(end, segment.offset + segment.length); if (overlapEnd <= overlapStart) continue;
    const targetOffset = overlapStart - start; const sourceOffset = overlapStart - segment.offset; const size = overlapEnd - overlapStart;
    if (segment.kind === "bytes") output.set(segment.bytes!.subarray(sourceOffset, sourceOffset + size), targetOffset);
    else {
      const object = await bucket.get(segment.key!, { range: { offset: sourceOffset, length: size }, ...(segment.etag ? { onlyIf: { etagMatches: segment.etag } } : {}) });
      if (!object?.arrayBuffer) throw new Error("ZIP source changed or disappeared");
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (bytes.length !== size) throw new Error("ZIP source returned a short range");
      output.set(bytes, targetOffset);
    }
  }
  return output;
}
