import path from "node:path";
import { stat } from "node:fs/promises";
import { asRendererError } from "./errors.mjs";
import { renderThumbnail } from "./render.mjs";

const [kind, sourcePath, outputPath, workspace, timeoutText] = process.argv.slice(2);
if (!["image", "pdf"].includes(kind) || !sourcePath || !outputPath || !workspace || !/^\d+$/.test(timeoutText || "")) {
  process.exitCode = 2;
} else {
  try {
    for (const candidate of [sourcePath, outputPath, workspace]) {
      if (!path.isAbsolute(candidate)) throw new Error("relative_path");
    }
    const workspaceRoot = `${path.resolve(workspace)}${path.sep}`;
    if (!path.resolve(outputPath).startsWith(workspaceRoot)) throw new Error("output_outside_workspace");
    const source = await stat(sourcePath);
    if (!source.isFile() || source.size <= 0) throw new Error("invalid_source");
    await renderThumbnail({
      mediaKind: kind,
      sourcePath,
      outputPath,
      workspace,
      maxPixels: 512_000_000,
      timeoutMs: Number(timeoutText) * 1000,
    });
  } catch (error) {
    const safe = asRendererError(error);
    console.error(JSON.stringify({ event: "queue_render_failed", code: safe.code }));
    process.exitCode = safe.retryable ? 75 : 1;
  }
}
