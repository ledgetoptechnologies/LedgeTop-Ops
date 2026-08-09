#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";

const [kind, source, output, expectedSizeValue] = process.argv.slice(2);
const expectedSize = Number(expectedSizeValue);
const MAX_IMAGE_BYTES = 512 * 1024 * 1024;
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_PIXELS = 110_000_000;
const MAX_DIMENSION = 30_000;
const MAX_PDF_PAGES = 1_000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const COMMAND_TIMEOUT_MS = 150_000;
const MAX_TOOL_OUTPUT_BYTES = 8 * 1024;

function fail(code) {
  process.stderr.write("renderer_rejected\n");
  process.exit(code);
}

function run(command, args, failureCode = 20) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_TOOL_OUTPUT_BYTES,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      VIPS_CONCURRENCY: "2",
      MALLOC_ARENA_MAX: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM") fail(124);
  if (result.error || result.status !== 0) fail(failureCode);
  return String(result.stdout || "").trim();
}

function integerHeader(field, input, failureCode = 24) {
  const value = Number(run("vipsheader", ["-f", field, input], failureCode));
  if (!Number.isSafeInteger(value) || value <= 0) fail(failureCode);
  return value;
}

function validateSourceSize(maximum) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > maximum) fail(20);
  if (statSync(source).size !== expectedSize) fail(20);
}

function validateRaster(input) {
  const width = integerHeader("width", input);
  const height = integerHeader("height", input);
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) fail(21);
}

function stripAndValidateWebp(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") fail(26);
  const chunks = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const name = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const padded = length + (length % 2);
    if (offset + 8 + padded > bytes.length) fail(26);
    if (name === "ANIM" || name === "ANMF") fail(24);
    if (!new Set(["EXIF", "XMP ", "ICCP"]).has(name)) {
      const chunk = Buffer.from(bytes.subarray(offset, offset + 8 + padded));
      if (name === "VP8X" && length >= 10) chunk[8] &= ~0x2c;
      chunks.push(chunk);
    }
    offset += 8 + padded;
  }
  if (offset !== bytes.length) fail(26);
  const payload = Buffer.concat(chunks);
  const cleaned = Buffer.alloc(12 + payload.length);
  cleaned.write("RIFF", 0, "ascii");
  cleaned.writeUInt32LE(cleaned.length - 8, 4);
  cleaned.write("WEBP", 8, "ascii");
  payload.copy(cleaned, 12);
  writeFileSync(path, cleaned, { mode: 0o600 });
  if (cleaned.length <= 20 || cleaned.length > MAX_OUTPUT_BYTES) fail(23);
  run("dwebp", [path, "-o", "/dev/null"], 26);
  if (integerHeader("width", path, 26) !== 320 || integerHeader("height", path, 26) !== 240) fail(26);
}

function renderWebp(input) {
  for (const quality of [78, 68, 58, 48, 38, 28]) {
    try { unlinkSync(output); } catch {}
    run("vipsthumbnail", [
      input,
      "--size", "320x240",
      "--smartcrop", "centre",
      "--output", `${output}[Q=${quality},strip,min_size=true]`,
    ], 24);
    stripAndValidateWebp(output);
    if (statSync(output).size <= MAX_OUTPUT_BYTES) return;
  }
  fail(23);
}

if (kind === "image") {
  validateSourceSize(MAX_IMAGE_BYTES);
  validateRaster(source);
  renderWebp(source);
} else if (kind === "pdf") {
  validateSourceSize(MAX_PDF_BYTES);
  const info = run("pdfinfo", ["-f", "1", "-l", "1", source], 20);
  if (/^Encrypted:\s+yes$/im.test(info)) fail(22);
  const pages = Number(info.match(/^Pages:\s+(\d+)$/im)?.[1]);
  if (!Number.isSafeInteger(pages) || pages <= 0) fail(20);
  if (pages > MAX_PDF_PAGES) fail(25);
  const rasterPrefix = `${output}.page`;
  run("pdftoppm", [
    "-f", "1", "-l", "1", "-singlefile",
    "-r", "120", "-scale-to-x", "1280", "-scale-to-y", "-1",
    "-png", source, rasterPrefix,
  ], 20);
  const raster = `${rasterPrefix}.png`;
  validateRaster(raster);
  renderWebp(raster);
  try { unlinkSync(raster); } catch {}
} else {
  fail(24);
}
