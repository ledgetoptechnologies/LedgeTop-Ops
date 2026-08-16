type WorkerLike = Pick<Worker, "postMessage" | "terminate" | "addEventListener" | "removeEventListener">;

export function hashFileOffThread(
  blob: Blob,
  onProgress?: (completed: number) => void,
  signal?: AbortSignal,
  createWorker: () => WorkerLike = () => new Worker(new URL("./file-hash-worker.ts", import.meta.url), { type: "module" }),
): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = createWorker();
    const id = crypto.randomUUID();
    const clean = () => {
      worker.removeEventListener("message", onMessage as EventListener);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const onAbort = () => { clean(); reject(new DOMException("Upload cancelled", "AbortError")); };
    const onMessage = (event: MessageEvent<{ id: string; type: string; completed?: number; sha256?: string; message?: string }>) => {
      if (event.data.id !== id) return;
      if (event.data.type === "progress") onProgress?.(event.data.completed || 0);
      else if (event.data.type === "complete" && event.data.sha256) { clean(); resolve(event.data.sha256); }
      else if (event.data.type === "error") { clean(); reject(new Error(event.data.message || "File hashing failed")); }
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.addEventListener("message", onMessage as EventListener);
    worker.postMessage({ id, blob });
  });
}
