export interface ZipSource {
  name: string;
  size: number;
  open(): Promise<ReadableStream<Uint8Array>>;
}

const encoder = new TextEncoder();

function u16(value: number): Uint8Array {
  return Uint8Array.from([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value: number): Uint8Array {
  return Uint8Array.from([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function crc32(bytes: Uint8Array, previous = 0xffffffff): number {
  let crc = previous;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc >>> 0;
}

function nameBytes(name: string): Uint8Array { return encoder.encode(name.replace(/[\0\x00-\x1f\x7f\\:*?"<>|]/g, "_").slice(0, 240) || "file"); }

export function streamZip(sources: ZipSource[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const central: Uint8Array[] = [];
      let offset = 0;
      try {
        for (const source of sources) {
          if (!Number.isSafeInteger(source.size) || source.size < 0 || source.size > 0xffffffff) throw new Error("ZIP entry is too large");
          const name = nameBytes(source.name);
          const local = concat(u32(0x04034b50), u16(20), u16(0x0008), u16(0), u16(0), u16(0), u32(0), u32(0), u32(0), u16(name.length), u16(0), name);
          controller.enqueue(local); offset += local.length;
          const reader = (await source.open()).getReader();
          let crc = 0xffffffff; let size = 0;
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              if (chunk.value.byteLength) { crc = crc32(chunk.value, crc); size += chunk.value.byteLength; controller.enqueue(chunk.value); offset += chunk.value.byteLength; }
            }
          } finally { reader.releaseLock(); }
          crc = (crc ^ 0xffffffff) >>> 0;
          const descriptor = concat(u32(0x08074b50), u32(crc), u32(size), u32(size));
          controller.enqueue(descriptor); offset += descriptor.length;
          const centralEntry = concat(u32(0x02014b50), u16(20), u16(20), u16(0x0008), u16(0), u16(0), u16(0), u32(crc), u32(size), u32(size), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset - local.length - size - descriptor.length), name);
          central.push(centralEntry);
        }
        const directoryOffset = offset;
        for (const entry of central) { controller.enqueue(entry); offset += entry.length; }
        const directorySize = offset - directoryOffset;
        controller.enqueue(concat(u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(directorySize), u32(directoryOffset), u16(0)));
        controller.close();
      } catch (error) { controller.error(error); }
    },
  });
}
