import { describe, expect, it, vi } from "vitest";
import { hashFileOffThread } from "../src/client/file-hash";

class FakeWorker extends EventTarget {
  terminated = false;
  postMessage(value: { id: string; blob: Blob }) {
    queueMicrotask(() => {
      this.dispatchEvent(new MessageEvent("message", { data: { id: value.id, type: "progress", completed: value.blob.size } }));
      this.dispatchEvent(new MessageEvent("message", { data: { id: value.id, type: "complete", sha256: "abc" } }));
    });
  }
  terminate() { this.terminated = true; }
}

describe("off-main-thread file hashing", () => {
  it("delegates the Blob, reports responsive progress, and terminates", async () => {
    const worker = new FakeWorker(), progress = vi.fn();
    await expect(hashFileOffThread(new Blob(["drone-data"]), progress, undefined, () => worker)).resolves.toBe("abc");
    expect(progress).toHaveBeenCalledWith(10);
    expect(worker.terminated).toBe(true);
  });

  it("terminates promptly when upload cancellation aborts hashing", async () => {
    const worker = new FakeWorker(), controller = new AbortController();
    controller.abort();
    await expect(hashFileOffThread(new Blob(["x"]), undefined, controller.signal, () => worker)).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminated).toBe(true);
  });
});
