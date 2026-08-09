import { open, stat } from "node:fs/promises";
import { HARD_LIMITS } from "./config.mjs";
import { RendererError } from "./errors.mjs";

export async function validateWebpFile(filePath) {
  const details = await stat(filePath);
  if (details.size < 30 || details.size > HARD_LIMITS.outputBytes) throw new RendererError("invalid_output", false);
  const file = await open(filePath, "r");
  const bytes = Buffer.alloc(details.size);
  try { await file.read(bytes, 0, bytes.length, 0); } finally { await file.close(); }
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP" || bytes.readUInt32LE(4) + 8 !== bytes.length) throw new RendererError("invalid_output", false);
  let dimensions = null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const chunk = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > bytes.length) throw new RendererError("invalid_output", false);
    if (["EXIF", "XMP ", "ICCP", "ANIM", "ANMF"].includes(chunk)) throw new RendererError("metadata_present", false);
    if (chunk === "VP8X" && length >= 10) dimensions = { width: 1 + bytes[start + 4] + (bytes[start + 5] << 8) + (bytes[start + 6] << 16), height: 1 + bytes[start + 7] + (bytes[start + 8] << 8) + (bytes[start + 9] << 16) };
    else if (chunk === "VP8 " && length >= 10 && bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a) dimensions = { width: bytes.readUInt16LE(start + 6) & 0x3fff, height: bytes.readUInt16LE(start + 8) & 0x3fff };
    else if (chunk === "VP8L" && length >= 5 && bytes[start] === 0x2f) { const bits = bytes.readUInt32LE(start + 1); dimensions = { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }; }
    offset = start + length + (length % 2);
  }
  if (!dimensions || dimensions.width !== HARD_LIMITS.outputWidth || dimensions.height !== HARD_LIMITS.outputHeight) throw new RendererError("invalid_output", false);
  return { ...dimensions, outputBytes: details.size, bytes };
}
