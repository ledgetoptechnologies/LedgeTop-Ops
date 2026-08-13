export const MAX_SOP_MARKDOWN_BYTES = 100_000;

const markdownExtension = /\.(?:md|markdown)$/i;
const markdownTypes = new Set(["", "text/markdown", "text/plain", "text/x-markdown"]);

export function decodeSopMarkdownImport(
  name: string,
  type: string,
  bytes: ArrayBuffer,
): string {
  if (!markdownExtension.test(name) || !markdownTypes.has(type.toLowerCase())) {
    throw new Error("Choose a Markdown file ending in .md or .markdown.");
  }
  if (bytes.byteLength === 0) throw new Error("The Markdown file is empty.");
  if (bytes.byteLength > MAX_SOP_MARKDOWN_BYTES) {
    throw new Error("The Markdown file exceeds the 100 KB SOP limit.");
  }
  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("The Markdown file must use valid UTF-8 text.");
  }
  if (markdown.startsWith("\uFEFF")) markdown = markdown.slice(1);
  if (markdown.includes("\0")) throw new Error("The Markdown file contains binary data.");
  if (!markdown.trim()) throw new Error("The Markdown file is empty.");
  return markdown;
}

export async function readSopMarkdownFile(file: File): Promise<string> {
  return decodeSopMarkdownImport(file.name, file.type, await file.arrayBuffer());
}
