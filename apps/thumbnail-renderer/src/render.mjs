import path from "node:path";
import { open, rename, rm, stat } from "node:fs/promises";
import { HARD_LIMITS } from "./config.mjs";
import { RendererError } from "./errors.mjs";
import { runTool as defaultRunTool } from "./process.mjs";

function positiveInteger(value) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new RendererError("invalid_media", false);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new RendererError("invalid_media", false);
  return parsed;
}

async function header(filePath, field, options) {
  const result = await options.runTool("vipsheader", ["-f", field, filePath], options);
  return positiveInteger(result.output);
}

export async function inspectImage(filePath, options) {
  const width = await header(filePath, "width", options);
  const height = await header(filePath, "height", options);
  if (width > Math.floor(options.maxPixels / height)) throw new RendererError("image_pixel_limit", false);
  return { width, height };
}

async function webpInfo(filePath, options) {
  const result = await options.runTool("webpmux", ["-info", filePath], { ...options, allowFailure: false });
  return `${result.output}\n${result.diagnostic || ""}`;
}

async function stripWebpMetadata(inputPath, outputPath, options) {
  let current = inputPath;
  let index = 0;
  for (const [kind, pattern] of [
    ["exif", /EXIF metadata|EXIF chunk/i],
    ["xmp", /XMP metadata|XMP chunk/i],
    ["icc", /ICC profile|ICCP chunk/i],
  ]) {
    const info = await webpInfo(current, options);
    if (!pattern.test(info)) continue;
    const next = path.join(path.dirname(outputPath), `stripped-${index++}.webp`);
    await options.runTool("webpmux", ["-strip", kind, current, "-o", next], options);
    if (current !== inputPath) await rm(current, { force: true });
    current = next;
  }
  if (current === inputPath) await rename(inputPath, outputPath);
  else await rename(current, outputPath);
}

export async function validateWebpOutput(filePath, options) {
  const details = await stat(filePath);
  if (details.size <= 12 || details.size > HARD_LIMITS.outputBytes) throw new RendererError("invalid_output", false);
  const file = await open(filePath, "r");
  const magic = Buffer.alloc(12);
  try { await file.read(magic, 0, magic.length, 0); } finally { await file.close(); }
  if (magic.toString("ascii", 0, 4) !== "RIFF" || magic.toString("ascii", 8, 12) !== "WEBP") {
    throw new RendererError("invalid_output", false);
  }
  const width = await header(filePath, "width", options);
  const height = await header(filePath, "height", options);
  if (width !== HARD_LIMITS.outputWidth || height !== HARD_LIMITS.outputHeight) throw new RendererError("invalid_output", false);
  if (/EXIF metadata|EXIF chunk|XMP metadata|XMP chunk|ICC profile|ICCP chunk/i.test(await webpInfo(filePath, options))) {
    throw new RendererError("metadata_present", false);
  }
  return { width, height, outputBytes: details.size };
}

async function rasterizePdf(sourcePath, workspace, options) {
  const prefix = path.join(workspace, "pdf-page");
  await options.runTool("pdftocairo", [
    "-f", "1", "-l", "1", "-singlefile", "-png", "-scale-to", "1024", sourcePath, prefix,
  ], options);
  return `${prefix}.png`;
}

export async function renderThumbnail({ mediaKind, sourcePath, outputPath, workspace, maxPixels, timeoutMs, signal, runTool = defaultRunTool }) {
  const options = { runTool, timeoutMs, cwd: workspace, maxPixels, signal };
  let rasterSource = sourcePath;
  if (mediaKind === "image") await inspectImage(sourcePath, options);
  else if (mediaKind === "pdf") rasterSource = await rasterizePdf(sourcePath, workspace, options);
  else throw new RendererError("unsupported_media", false);

  for (const quality of [78, 65, 50, 35]) {
    const candidate = path.join(workspace, `candidate-${quality}.webp`);
    const stripped = path.join(workspace, `candidate-${quality}-stripped.webp`);
    await runTool("vips", [
      "thumbnail",
      rasterSource,
      `${candidate}[Q=${quality},strip,smart-subsample]`,
      String(HARD_LIMITS.outputWidth),
      "--height", String(HARD_LIMITS.outputHeight),
      "--size", "both",
      "--crop", "centre",
      "--auto-rotate",
    ], options);
    await stripWebpMetadata(candidate, stripped, options);
    const details = await stat(stripped);
    if (details.size > HARD_LIMITS.outputBytes) {
      await rm(stripped, { force: true });
      continue;
    }
    const result = await validateWebpOutput(stripped, options);
    await rename(stripped, outputPath);
    return result;
  }
  throw new RendererError("output_too_large", false);
}
