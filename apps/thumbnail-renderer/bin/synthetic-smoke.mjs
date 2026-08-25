import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { renderThumbnail } from "../src/render.mjs";
import { runTool } from "../src/process.mjs";

function minimalPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    "<< /Length 27 >>\nstream\n0.9 g 0 0 612 792 re f\nendstream",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
}

const root = "/work/synthetic-smoke";
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true, mode: 0o700 });
try {
  const image = path.join(root, "source.png");
  const imageOutput = path.join(root, "image.webp");
  await runTool("vips", ["black", image, "1000", "800"], { cwd: root, timeoutMs: 30_000 });
  const imageResult = await renderThumbnail({ mediaKind: "image", sourcePath: image, outputPath: imageOutput, workspace: root, maxPixels: 512_000_000, timeoutMs: 30_000 });

  const pdf = path.join(root, "source.pdf");
  const pdfOutput = path.join(root, "pdf.webp");
  await writeFile(pdf, minimalPdf(), { mode: 0o600 });
  const pdfResult = await renderThumbnail({ mediaKind: "pdf", sourcePath: pdf, outputPath: pdfOutput, workspace: root, maxPixels: 512_000_000, timeoutMs: 30_000 });
  process.stdout.write(`${JSON.stringify({ image: imageResult, pdf: pdfResult })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
