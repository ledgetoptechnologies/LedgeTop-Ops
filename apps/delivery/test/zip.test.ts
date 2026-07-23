import { describe, expect, it } from "vitest";
import { streamZip } from "../src/worker/zip";

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
});
