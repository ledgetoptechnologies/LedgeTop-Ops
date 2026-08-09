import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { inspectImage, renderThumbnail, validateWebpOutput } from "../src/render.mjs";

const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([12, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(8)]);

function cleanTool(calls) {
  return async (command, args) => {
    calls.push([command, ...args]);
    if (command === "vipsheader") return { exitCode: 0, output: args[1] === "width" ? "320\n" : "240\n", diagnostic: "" };
    if (command === "vips" && args[0] === "thumbnail") {
      const output = args[2].replace(/\[.*$/, "");
      await writeFile(output, webp);
      return { exitCode: 0, output: "", diagnostic: "" };
    }
    if (command === "webpmux") return { exitCode: 0, output: "No features present.\n", diagnostic: "" };
    throw new Error(`unexpected tool ${command}`);
  };
}

test("enforces the 110 MP image cap before rendering", async () => {
  let count = 0;
  const runTool = async (_command, args) => ({ exitCode: 0, output: args[1] === "width" ? "12281" : String(++count && 9186), diagnostic: "" });
  await assert.rejects(inspectImage("source", { runTool, timeoutMs: 1, cwd: ".", maxPixels: 110_000_000 }), { code: "image_pixel_limit" });
});

test("renders a bounded metadata-free WebP with argv-only tools", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ltds-renderer-test-"));
  const source = path.join(directory, "source.bin");
  const output = path.join(directory, "thumbnail.webp");
  const calls = [];
  try {
    await writeFile(source, "synthetic");
    const result = await renderThumbnail({ mediaKind: "image", sourcePath: source, outputPath: output, workspace: directory, maxPixels: 110_000_000, timeoutMs: 1_000, runTool: cleanTool(calls) });
    assert.deepEqual(result, { width: 320, height: 240, outputBytes: webp.length });
    assert.deepEqual(await readFile(output), webp);
    assert.equal(calls.some((call) => call[0] === "vips" && call[1] === "thumbnail" && call.includes("--auto-rotate") && call.includes("--crop")), true);
    assert.equal(calls.some((call) => call[0] === "webpmux" && call[1] === "-info"), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects metadata-bearing output after a full decode check", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ltds-renderer-test-"));
  const output = path.join(directory, "thumbnail.webp");
  try {
    await writeFile(output, webp);
    const runTool = async (command, args) => {
      if (command === "vipsheader") return { exitCode: 0, output: args[1] === "width" ? "320" : "240", diagnostic: "" };
      return { exitCode: 0, output: "Size of the EXIF metadata: 10", diagnostic: "" };
    };
    await assert.rejects(validateWebpOutput(output, { runTool, timeoutMs: 100, cwd: directory }), { code: "metadata_present" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
