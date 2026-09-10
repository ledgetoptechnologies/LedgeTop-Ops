export type ZipDirectoryEntry = { path: string; name: string; kind: "file" | "folder"; size?: number };
export type ZipDirectoryResult = { status: "ready"; entries: ZipDirectoryEntry[] } | { status: "unavailable"; reason: string };

const MAX_CD = 4 * 1024 * 1024, MAX_ENTRIES = 20_000, MAX_EXPANDED = 40_000;
const EOCD = 0x06054b50, CENTRAL = 0x02014b50, ZIP64_LOCATOR = 0x07064b50, ZIP64_END = 0x06064b50;
class InvalidDirectory extends Error {}
function invalid(reason: string): never { throw new InvalidDirectory(reason); }
function view(bytes: Uint8Array) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function u64(data: DataView, offset: number): number {
  const value = data.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid("zip64_invalid");
  return Number(value);
}
function normalizedPath(raw: string): string {
  if (!raw || raw.length > 2048 || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)
    || raw.includes("\\") || /[\x00-\x1f\x7f]/.test(raw)) invalid("invalid_path");
  const result = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const parts = result.split("/");
  if (parts.length > 32 || parts.some(p => !p || p === "." || p === ".." || p.length > 255)) invalid("invalid_path");
  return result;
}

/** Metadata only, not extraction or a malware verdict. Caller must enforce
 * authorization and exact object identity on each range and before response. */
export async function readIncomingZipDirectory(size: number, readRange: (offset: number, length: number) => Promise<Uint8Array>): Promise<ZipDirectoryResult> {
  try {
    if (!Number.isSafeInteger(size) || size < 22) invalid("not_zip");
    const read = async (offset: number, length: number) => {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
        || length > MAX_CD || offset > size - length) invalid("malformed_central_directory");
      if (!length) return new Uint8Array();
      const bytes = await readRange(offset, length);
      if (bytes.byteLength !== length) invalid("malformed_central_directory");
      return bytes;
    };
    const tailLength = Math.min(size, 65_557);
    const tail = await read(size - tailLength, tailLength), end = view(tail);
    let e = -1;
    for (let i = tailLength - 22; i >= 0; i--) {
      if (end.getUint32(i, true) === EOCD && i + 22 + end.getUint16(i + 20, true) === tailLength) { e = i; break; }
    }
    if (e < 0) invalid("not_zip");
    if (end.getUint16(e + 4, true) || end.getUint16(e + 6, true)) invalid("multi_disk");
    let count = end.getUint16(e + 10, true), cdBytes = end.getUint32(e + 12, true), cdOffset = end.getUint32(e + 16, true);
    const diskCount = end.getUint16(e + 8, true);
    let boundary = size - tailLength + e;
    if (count === 0xffff || diskCount === 0xffff || cdBytes === 0xffffffff || cdOffset === 0xffffffff) {
      const locatorOffset = boundary - 20;
      if (locatorOffset < 0) invalid("zip64_invalid");
      const locator = view(await read(locatorOffset, 20));
      if (locator.getUint32(0, true) !== ZIP64_LOCATOR) invalid("zip64_invalid");
      if (locator.getUint32(4, true) || locator.getUint32(16, true) !== 1) invalid("multi_disk");
      const zip64Offset = u64(locator, 8);
      if (zip64Offset > locatorOffset - 56) invalid("zip64_invalid");
      const z = view(await read(zip64Offset, 56));
      if (z.getUint32(0, true) !== ZIP64_END) invalid("zip64_invalid");
      const recordLength = u64(z, 4);
      if (recordLength < 44 || recordLength !== locatorOffset - zip64Offset - 12) invalid("zip64_invalid");
      if (z.getUint32(16, true) || z.getUint32(20, true)) invalid("multi_disk");
      count = u64(z, 32);
      if (u64(z, 24) !== count) invalid("multi_disk");
      cdBytes = u64(z, 40); cdOffset = u64(z, 48); boundary = zip64Offset;
    } else if (diskCount !== count) invalid("multi_disk");
    if (count > MAX_ENTRIES) invalid("entry_limit");
    if (cdBytes > MAX_CD) invalid("central_directory_too_large");
    if (cdOffset > boundary - cdBytes || count * 46 > cdBytes) invalid("malformed_central_directory");
    const bytes = await read(cdOffset, cdBytes), cd = view(bytes);
    const entries = new Map<string, ZipDirectoryEntry>(), explicit = new Set<string>();
    let offset = 0, expandedBytes = 0;
    const insert = (entry: ZipDirectoryEntry) => {
      if (!entries.has(entry.path)) {
        expandedBytes += new TextEncoder().encode(entry.path).byteLength + 64;
        if (entries.size >= MAX_EXPANDED || expandedBytes > MAX_CD) invalid("metadata_limit");
      }
      entries.set(entry.path, entry);
    };
    for (let i = 0; i < count; i++) {
      if (offset + 46 > bytes.length || cd.getUint32(offset, true) !== CENTRAL) invalid("malformed_central_directory");
      const flags = cd.getUint16(offset + 8, true);
      if (flags & 0x41) invalid("encrypted_entries");
      const nl = cd.getUint16(offset + 28, true), xl = cd.getUint16(offset + 30, true), cl = cd.getUint16(offset + 32, true);
      const next = offset + 46 + nl + xl + cl;
      if (next > bytes.length) invalid("malformed_central_directory");
      const nameBytes = bytes.subarray(offset + 46, offset + 46 + nl);
      // Do not silently corrupt legacy non-UTF-8 filenames. Raw download remains available.
      if (!(flags & 0x800) && nameBytes.some(b => b >= 128)) invalid("filename_encoding_unsupported");
      let raw: string;
      try { raw = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes); }
      catch { invalid("filename_encoding_unsupported"); }
      const path = normalizedPath(raw);
      const attrs = cd.getUint32(offset + 38, true);
      const unixType = cd.getUint8(offset + 5) === 3 ? (attrs >>> 16) & 0o170000 : 0;
      if (unixType && unixType !== 0o100000 && unixType !== 0o040000) invalid("unsafe_special_file");
      const kind = raw.endsWith("/") || unixType === 0o040000 || Boolean(attrs & 0x10) ? "folder" : "file";
      if (unixType === 0o100000 && kind === "folder") invalid("conflicting_path");
      let memberBytes = cd.getUint32(offset + 24, true), compressedBytes = cd.getUint32(offset + 20, true), localOffset = cd.getUint32(offset + 42, true);
      let disk = cd.getUint16(offset + 34, true);
      if ([memberBytes, compressedBytes, localOffset].includes(0xffffffff) || disk === 0xffff) {
        let extra = offset + 46 + nl, found = false;
        const extraEnd = extra + xl;
        while (extra + 4 <= extraEnd) {
          const tag = cd.getUint16(extra, true), length = cd.getUint16(extra + 2, true), endExtra = extra + 4 + length;
          if (endExtra > extraEnd) invalid("zip64_invalid");
          if (tag === 1) {
            let p = extra + 4;
            const take = () => { if (p + 8 > endExtra) invalid("zip64_invalid"); const v = u64(cd, p); p += 8; return v; };
            if (memberBytes === 0xffffffff) memberBytes = take();
            if (compressedBytes === 0xffffffff) compressedBytes = take();
            if (localOffset === 0xffffffff) localOffset = take();
            if (disk === 0xffff) { if (p + 4 > endExtra) invalid("zip64_invalid"); disk = cd.getUint32(p, true); }
            found = true; break;
          }
          extra = endExtra;
        }
        if (!found) invalid("zip64_invalid");
      }
      if (disk) invalid("multi_disk");
      if (localOffset > cdOffset || compressedBytes > cdOffset - localOffset) invalid("malformed_central_directory");
      if (explicit.has(path)) invalid("duplicate_path");
      if (entries.has(path) && (entries.get(path)!.kind !== "folder" || kind !== "folder")) invalid("conflicting_path");
      const parts = path.split("/");
      for (let depth = 1; depth < parts.length; depth++) {
        const parent = parts.slice(0, depth).join("/");
        if (entries.get(parent)?.kind === "file") invalid("conflicting_path");
        if (!entries.has(parent)) insert({ path: parent, name: parts[depth - 1]!, kind: "folder" });
      }
      explicit.add(path); insert({ path, name: parts.at(-1)!, kind, ...(kind === "file" ? { size: memberBytes } : {}) }); offset = next;
    }
    if (offset !== bytes.length) invalid("malformed_central_directory");
    return { status: "ready", entries: [...entries.values()].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
  } catch (error) {
    if (error instanceof InvalidDirectory) return { status: "unavailable", reason: error.message };
    throw error;
  }
}
