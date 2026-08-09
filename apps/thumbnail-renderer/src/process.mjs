import { spawn } from "node:child_process";
import { RendererError } from "./errors.mjs";

const MAX_CAPTURE_BYTES = 64 * 1024;

export async function runTool(command, args, { timeoutMs, cwd, env = {}, signal, allowFailure = false } = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new TypeError("tool arguments must be strings");
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, XDG_CACHE_HOME: "/cache", TMPDIR: cwd, VIPS_CONCURRENCY: "2", MALLOC_ARENA_MAX: "2", ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const collect = (target, count, chunk) => {
    if (count.value >= MAX_CAPTURE_BYTES) return;
    const keep = chunk.subarray(0, MAX_CAPTURE_BYTES - count.value);
    target.push(keep);
    count.value += keep.byteLength;
  };
  const stdoutCount = { value: stdoutBytes };
  const stderrCount = { value: stderrBytes };
  child.stdout.on("data", (chunk) => collect(stdout, stdoutCount, chunk));
  child.stderr.on("data", (chunk) => collect(stderr, stderrCount, chunk));

  let timedOut = false;
  const kill = () => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch { /* already exited */ }
  };
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
  timer.unref?.();
  const abort = () => kill();
  signal?.addEventListener("abort", abort, { once: true });
  let exitCode;
  try {
    exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? -1));
    });
  } catch {
    throw new RendererError("renderer_tool_unavailable", true);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
  if (timedOut || signal?.aborted) throw new RendererError("render_timeout", true);
  const output = Buffer.concat(stdout).toString("utf8");
  if (exitCode !== 0 && !allowFailure) throw new RendererError("invalid_media", false);
  return { exitCode, output, diagnostic: Buffer.concat(stderr).toString("utf8") };
}
