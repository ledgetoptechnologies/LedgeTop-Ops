import { describe, expect, it } from "vitest";
import { decodeSopMarkdownImport, MAX_SOP_MARKDOWN_BYTES } from "../src/client/sop-markdown-import";

const bytes = (value: string) => new TextEncoder().encode(value).buffer;

describe("SOP Markdown file import", () => {
  it("accepts strict UTF-8 Markdown and removes one BOM", () => {
    expect(decodeSopMarkdownImport("flight.MD", "text/markdown", bytes("\uFEFF# Flight\n"))).toBe("# Flight\n");
    expect(decodeSopMarkdownImport("flight.markdown", "", bytes("# Flight"))).toBe("# Flight");
  });

  it("rejects unsupported, empty, binary, invalid UTF-8, and oversized files", () => {
    expect(() => decodeSopMarkdownImport("flight.txt", "text/plain", bytes("# Flight"))).toThrow(/\.md/);
    expect(() => decodeSopMarkdownImport("flight.md", "application/octet-stream", bytes("# Flight"))).toThrow(/Markdown file/);
    expect(() => decodeSopMarkdownImport("flight.md", "text/markdown", new ArrayBuffer(0))).toThrow(/empty/);
    expect(() => decodeSopMarkdownImport("flight.md", "text/markdown", bytes("# Flight\0data"))).toThrow(/binary/);
    expect(() => decodeSopMarkdownImport("flight.md", "text/markdown", Uint8Array.from([0xc3, 0x28]).buffer)).toThrow(/UTF-8/);
    expect(() => decodeSopMarkdownImport("flight.md", "text/markdown", new ArrayBuffer(MAX_SOP_MARKDOWN_BYTES + 1))).toThrow(/100 KB/);
  });
});
