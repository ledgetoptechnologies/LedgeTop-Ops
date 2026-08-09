import { Container } from "@cloudflare/containers";
import { CONTAINER_RENDER_MAX_OUTPUT_BYTES, ThumbnailRendererError, validWebp, validateContainerThumbnailRequest, type ContainerThumbnailErrorCode, type ContainerThumbnailRequest, type ContainerThumbnailResult } from "./thumbnail-renderer-contract";

export const CONTAINER_RENDER_TIMEOUT_MS = 180_000;
export const CONTAINER_RENDER_MAX_DIAGNOSTIC_BYTES = 4 * 1024;

async function boundedBytes(
  stream: ReadableStream<Uint8Array> | null,
  maximum: number,
  onOverflow: () => void,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximum) {
        onOverflow();
        throw new ThumbnailRendererError("invalid_output", "Container renderer output exceeded its safe limit");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function exactSizeStream(input: ReadableStream<Uint8Array>, expectedSize: number): ReadableStream<Uint8Array> {
  const reader = input.getReader();
  let received = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read();
      if (result.done) {
        if (received !== expectedSize) controller.error(new ThumbnailRendererError("invalid_input", "Source size did not match its exact version"));
        else controller.close();
        return;
      }
      received += result.value.byteLength;
      if (received > expectedSize) {
        await reader.cancel();
        controller.error(new ThumbnailRendererError("invalid_input", "Source exceeded its exact declared size"));
        return;
      }
      controller.enqueue(result.value);
    },
    async cancel(reason) { await reader.cancel(reason); },
  });
}

function mappedRendererError(exitCode: number): ThumbnailRendererError {
  const codeByExit: Record<number, ContainerThumbnailErrorCode> = {
    20: "invalid_input",
    21: "pixel_limit_exceeded",
    22: "encrypted_pdf",
    23: "output_too_large",
    24: "unsupported_format",
    25: "pdf_page_limit",
    26: "metadata_not_stripped",
    27: "resource_exhausted",
    124: "render_timeout",
  };
  const code = codeByExit[exitCode] || "render_failed";
  return new ThumbnailRendererError(code, code === "render_timeout"
    ? "Private thumbnail rendering timed out"
    : "Private thumbnail renderer rejected the source");
}

/**
 * Private RPC-only media renderer. The queue consumer transfers an authorized,
 * exact-version R2 body directly to this Durable Object. The container has no
 * internet access, receives no source key or credentials, and stores only
 * opaque temporary files on ephemeral disk.
 */
export class ThumbnailRendererContainer extends Container {
  #tail: Promise<void> = Promise.resolve();
  sleepAfter = "30s";
  enableInternet = false;
  envVars = {
    HOME: "/tmp/ltds-renderer",
    TMPDIR: "/tmp/ltds-renderer",
    VIPS_CONCURRENCY: "2",
    MALLOC_ARENA_MAX: "2",
  };

  async renderThumbnail(
    input: ReadableStream<Uint8Array>,
    request: ContainerThumbnailRequest,
  ): Promise<ContainerThumbnailResult> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.#renderThumbnail(input, request);
    } finally {
      release();
    }
  }

  async #renderThumbnail(
    input: ReadableStream<Uint8Array>,
    request: ContainerThumbnailRequest,
  ): Promise<ContainerThumbnailResult> {
    validateContainerThumbnailRequest(request);
    await this.start({ enableInternet: false });
    const runtime = this.ctx.container;
    if (!runtime) throw new ThumbnailRendererError("render_failed", "Container runtime is unavailable");

    const jobId = crypto.randomUUID();
    const directory = `/tmp/ltds-renderer/${jobId}`;
    const source = `${directory}/source.bin`;
    const output = `${directory}/thumbnail.webp`;
    let active: ExecProcess | null = null;
    const kill = () => {
      try { active?.kill(9); } catch { /* process already exited */ }
    };
    const timer = setTimeout(kill, CONTAINER_RENDER_TIMEOUT_MS);

    try {
      let process = await runtime.exec(["mkdir", "-m", "0700", "-p", directory], {
        stdout: "ignore",
        stderr: "pipe",
      });
      active = process;
      if (await process.exitCode !== 0) throw new ThumbnailRendererError("render_failed", "Container workspace creation failed");

      process = await runtime.exec(["tee", source], {
        stdin: exactSizeStream(input, request.expectedSize),
        stdout: "ignore",
        stderr: "pipe",
        env: { LTDSTHUMB_EXPECTED_SIZE: String(request.expectedSize) },
      });
      active = process;
      await boundedBytes(process.stderr, CONTAINER_RENDER_MAX_DIAGNOSTIC_BYTES, kill);
      if (await process.exitCode !== 0) {
        throw new ThumbnailRendererError("invalid_input", "Container source transfer failed");
      }

      process = await runtime.exec([
        "node",
        "/app/render-thumbnail.mjs",
        request.kind,
        source,
        output,
        String(request.expectedSize),
      ], { stdout: "ignore", stderr: "pipe" });
      active = process;
      await boundedBytes(process.stderr, CONTAINER_RENDER_MAX_DIAGNOSTIC_BYTES, kill);
      const exitCode = await process.exitCode;
      if (exitCode !== 0) throw mappedRendererError(exitCode);

      process = await runtime.exec(["cat", output], { stderr: "pipe" });
      active = process;
      const outputPromise = boundedBytes(process.stdout, CONTAINER_RENDER_MAX_OUTPUT_BYTES, kill);
      const errorPromise = boundedBytes(process.stderr, CONTAINER_RENDER_MAX_DIAGNOSTIC_BYTES, kill);
      const [bytes, , outputExitCode] = await Promise.all([outputPromise, errorPromise, process.exitCode]);
      if (outputExitCode !== 0) throw new ThumbnailRendererError("render_failed", "Container output read failed");
      if (!validWebp(bytes)) throw new ThumbnailRendererError("invalid_output", "Container returned an invalid WebP thumbnail");
      return {
        ok: true,
        bytes: Uint8Array.from(bytes).buffer,
        contentType: "image/webp",
      };
    } catch (error) {
      const safe = error instanceof ThumbnailRendererError
        ? error
        : new ThumbnailRendererError("render_failed", "Container thumbnail rendering failed");
      return { ok: false, errorCode: safe.code, message: safe.message };
    } finally {
      clearTimeout(timer);
      kill();
      try {
        const cleanup = await runtime.exec(["rm", "-rf", "--", directory], { stdout: "ignore", stderr: "pipe" });
        await Promise.all([
          boundedBytes(cleanup.stderr, CONTAINER_RENDER_MAX_DIAGNOSTIC_BYTES, () => cleanup.kill(9)),
          cleanup.exitCode,
        ]);
      } catch {
        // The ephemeral container disk is discarded on sleep. Cleanup failure
        // must not change a validated thumbnail result or expose path details.
      }
    }
  }
}
