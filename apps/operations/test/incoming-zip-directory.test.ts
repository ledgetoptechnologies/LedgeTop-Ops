import { describe, expect, it } from "vitest";
import { readIncomingZipDirectory } from "../src/worker/incoming-zip-directory";

function central(name: string, flags = 0x800, attrs = 0): Uint8Array {
  const text = new TextEncoder().encode(name), bytes = new Uint8Array(46 + text.length), data = new DataView(bytes.buffer);
  data.setUint32(0, 0x02014b50, true); data.setUint16(4, 3 << 8, true);
  data.setUint16(8, flags, true); data.setUint16(28, text.length, true); data.setUint32(38, attrs, true);
  bytes.set(text, 46); return bytes;
}
function zip(names: string[], flags = 0x800, attrs = 0, comment = new Uint8Array()) {
  const entries = names.map(name => central(name, flags, attrs)), cdSize = entries.reduce((sum, entry) => sum + entry.length, 0);
  const bytes = new Uint8Array(32 + cdSize + 22 + comment.length), data = new DataView(bytes.buffer);
  let offset = 32;
  for (const entry of entries) { bytes.set(entry, offset); offset += entry.length; }
  data.setUint32(offset, 0x06054b50, true); data.setUint16(offset + 8, names.length, true);
  data.setUint16(offset + 10, names.length, true); data.setUint32(offset + 12, cdSize, true); data.setUint32(offset + 16, 32, true);
  data.setUint16(offset + 20, comment.length, true); bytes.set(comment, offset + 22);
  return bytes;
}
const parse = (bytes: Uint8Array) => readIncomingZipDirectory(bytes.length, async (offset, length) => bytes.slice(offset, offset + length));

describe("bounded incoming ZIP directory", () => {
  it("lists Unicode names, inferred folders, explicit trailing-slash folders and sizes", async () => {
    const result = await parse(zip(["a/é.txt", "a/", "empty/"]));
    expect(result).toEqual({ status: "ready", entries: [
      { path: "a", name: "a", kind: "folder" },
      { path: "a/é.txt", name: "é.txt", kind: "file", size: 0 },
      { path: "empty", name: "empty", kind: "folder" },
    ] });
  });
  it.each(["../x", "C:/x", "/x", "x\\y", "x//y", "x/./y"])("rejects unsafe path %s", async name => {
    expect(await parse(zip([name]))).toEqual({ status: "unavailable", reason: "invalid_path" });
  });
  it("rejects encryption, duplicates, symlinks and file/folder conflicts", async () => {
    for (const bytes of [zip(["x"], 1), zip(["x", "x"]), zip(["x", "x/y"]), zip(["x/y", "x"]), zip(["x"], 0, 0o120000 << 16)]) {
      expect((await parse(bytes)).status).toBe("unavailable");
    }
  });
  it("does not silently corrupt non-UTF-8 filename encodings", async () => {
    expect(await parse(zip(["é"], 0))).toEqual({ status: "unavailable", reason: "filename_encoding_unsupported" });
  });
  it("ignores a false end signature inside a valid ZIP comment", async () => {
    const comment = new Uint8Array(60); new DataView(comment.buffer).setUint32(2, 0x06054b50, true);
    expect((await parse(zip(["photo.jpg"], 0x800, 0, comment))).status).toBe("ready");
  });
  it("rejects oversized metadata and entry counts before reading the directory", async () => {
    for (const kind of ["metadata", "entries"]) {
      const bytes = zip(["x"]), data = new DataView(bytes.buffer), end = bytes.length - 22;
      if (kind === "metadata") data.setUint32(end + 12, 4 * 1024 * 1024 + 1, true);
      else { data.setUint16(end + 8, 20_001, true); data.setUint16(end + 10, 20_001, true); }
      let calls = 0;
      const result = await readIncomingZipDirectory(bytes.length, async (offset, length) => { calls++; return bytes.slice(offset, offset + length); });
      expect(result).toEqual({ status: "unavailable", reason: kind === "metadata" ? "central_directory_too_large" : "entry_limit" });
      expect(calls).toBe(1);
    }
  });
  it("reads a valid ZIP64 directory beyond 4 GiB without allocating the archive", async () => {
    const cd = central("large.bin"), cdOffset = 2 ** 32 + 1234, zOffset = cdOffset + cd.length;
    const footer = new Uint8Array(98), data = new DataView(footer.buffer);
    data.setUint32(0, 0x06064b50, true); data.setBigUint64(4, 44n, true);
    data.setBigUint64(24, 1n, true); data.setBigUint64(32, 1n, true);
    data.setBigUint64(40, BigInt(cd.length), true); data.setBigUint64(48, BigInt(cdOffset), true);
    data.setUint32(56, 0x07064b50, true); data.setBigUint64(64, BigInt(zOffset), true); data.setUint32(72, 1, true);
    data.setUint32(76, 0x06054b50, true); data.setUint16(84, 0xffff, true); data.setUint16(86, 0xffff, true);
    data.setUint32(88, 0xffffffff, true); data.setUint32(92, 0xffffffff, true);
    const ranges: { offset: number; length: number }[] = [];
    const result = await readIncomingZipDirectory(zOffset + footer.length, async (offset, length) => {
      ranges.push({ offset, length });
      const output = new Uint8Array(length);
      for (const [start, bytes] of [[cdOffset, cd], [zOffset, footer]] as const) {
        const from = Math.max(start, offset), to = Math.min(start + bytes.length, offset + length);
        if (to > from) output.set(bytes.subarray(from - start, to - start), from - offset);
      }
      return output;
    });
    expect(result).toEqual({ status: "ready", entries: [{ path: "large.bin", name: "large.bin", kind: "file", size: 0 }] });
    expect(ranges).toHaveLength(4);
    expect(ranges.reduce((sum, range) => sum + range.length, 0)).toBe(65_557 + 20 + 56 + cd.length);
    expect(ranges.at(-1)?.offset).toBe(cdOffset);
  });
  it("rejects truncated range responses and malformed input", async () => {
    expect((await readIncomingZipDirectory(22, async () => new Uint8Array(21))).status).toBe("unavailable");
    expect((await parse(new Uint8Array(22))).status).toBe("unavailable");
  });
});
