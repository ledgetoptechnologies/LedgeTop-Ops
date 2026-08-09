import { createReadStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { RendererError } from "./errors.mjs";

export async function streamToExactFile(stream, filePath, expectedBytes, maximumBytes, signal) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > maximumBytes) {
    throw new RendererError("source_too_large", false);
  }
  const file = await open(filePath, "wx", 0o600);
  const reader = stream.getReader();
  let received = 0;
  const abort = () => reader.cancel(signal.reason).catch(() => {});
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new RendererError("operation_timeout", true);
      const part = await reader.read();
      if (part.done) break;
      received += part.value.byteLength;
      if (received > maximumBytes || received > expectedBytes) {
        await reader.cancel("source-size-limit").catch(() => {});
        throw new RendererError("source_size_mismatch", false);
      }
      await file.write(part.value);
    }
    if (received !== expectedBytes) throw new RendererError("source_size_mismatch", false);
    await file.sync();
    return received;
  } catch (error) {
    await rm(filePath, { force: true }).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
    await file.close();
  }
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
