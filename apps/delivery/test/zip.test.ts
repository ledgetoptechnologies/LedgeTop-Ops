import { describe, expect, it } from "vitest";
import { buildZipLayout, crc32, readZipPart, streamZip } from "../src/worker/zip";
import { normalizedSourceFilename, preparedKey } from "../src/worker/artifacts";

async function bytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader(); const chunks: Uint8Array[] = [];
  while (true) { const next = await reader.read(); if (next.done) break; chunks.push(next.value); }
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0)); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

describe("streaming ZIP writer", () => {
  it("writes a valid stored archive with nested names", async () => {
    const result = await bytes(streamZip([{ name: "edited/photo.txt", size: 5, open: async () => new Blob(["hello"]).stream() }]));
    const text = new TextDecoder().decode(result);
    expect(result[0]).toBe(0x50); expect(result[1]).toBe(0x4b); expect(text).toContain("edited/photo.txt"); expect(text).toContain("hello");
    expect(result[result.length - 22]).toBe(0x50); expect(result[result.length - 21]).toBe(0x4b);
  });

  it("emits ZIP64 central-directory records and rejects changed sources", async () => {
    const result = await bytes(streamZip([{ name: "unicode/фото.txt", size: 5, open: async () => new Blob(["hello"]).stream() }]));
    const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
    let signatures: number[] = [];
    for (let offset = 0; offset + 4 <= result.length; offset += 1) signatures.push(view.getUint32(offset, true));
    expect(signatures).toContain(0x06064b50);
    expect(signatures).toContain(0x07064b50);
    await expect(bytes(streamZip([{ name: "changed.bin", size: 4, open: async () => new Blob(["hello"]).stream() }]))).rejects.toThrow("ZIP source changed");
  });

  it("reconstructs a multipart ZIP64 archive from bounded source ranges", async () => {
    const source = new TextEncoder().encode("hello");
    const checksum = (crc32(source) ^ 0xffffffff) >>> 0;
    const layout = buildZipLayout([{ key: "Jobs/client/hello.txt", name: "Client Name/hello.txt", size: source.length, crc32: checksum }]);
    const bucket = { async get(_key: string, options?: { range: { offset: number; length: number } }) {
      const range = options!.range;
      return { async arrayBuffer() { return source.slice(range.offset, range.offset + range.length).buffer; } };
    } };
    const first = await readZipPart(bucket, layout, 0, 37);
    const rest = await readZipPart(bucket, layout, 37, layout.archiveSize - 37);
    const archive = new Uint8Array(first.length + rest.length); archive.set(first); archive.set(rest, first.length);
    expect(new TextDecoder().decode(archive)).toContain("Client Name/hello.txt");
    expect(new TextDecoder().decode(archive)).toContain("hello");
    expect(new DataView(archive.buffer).getUint32(0, true)).toBe(0x04034b50);
  });

  it("rejects short R2 range reads instead of zero-filling an archive", async () => {
    const source = new TextEncoder().encode("hello");
    const layout = buildZipLayout([{ key: "Jobs/client/hello.txt", name: "hello.txt", size: source.length, crc32: 0 }]);
    const bucket = { async get() { return { async arrayBuffer() { return source.slice(0, 1).buffer; } }; } };
    await expect(readZipPart(bucket, layout, layout.entries[0]!.local.length, source.length)).rejects.toThrow("short range");
  });
});

describe("TrueNAS prepared artifacts", () => {
  it("uses the normalized full source filename and manifest-last variants", async () => {
    const source = "jobs\\2026//Client//photo.JPG";
    expect(normalizedSourceFilename(source)).toBe("photo.JPG");
    await expect(preparedKey(source, "thumb")).resolves.toMatch(/^jobs\/2026\/Client\/_ltds\/previews\/[a-f0-9]{64}\/thumb\.webp$/);
    await expect(preparedKey(source, "preview")).resolves.toMatch(/^jobs\/2026\/Client\/_ltds\/previews\/[a-f0-9]{64}\/preview\.webp$/);
    await expect(preparedKey(source, "poster")).resolves.toMatch(/^jobs\/2026\/Client\/_ltds\/previews\/[a-f0-9]{64}\/poster\.webp$/);
  });
});
