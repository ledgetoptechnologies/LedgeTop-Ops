import { describe, expect, it } from "vitest";
import { readBoundedJson } from "../src/worker/bounded-json";

describe("bounded JSON mutation bodies", () => {
  it("reads a valid JSON body", async () => {
    const request = new Request("https://ops.test/mutation", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: "ok" }) });
    await expect(readBoundedJson(request, 1024)).resolves.toEqual({ value: "ok" });
  });

  it("rejects an oversized declared body before reading it", async () => {
    const request = new Request("https://ops.test/mutation", { method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "100" }, body: "{}" });
    await expect(readBoundedJson(request, 16)).rejects.toMatchObject({ status: 413 });
  });

  it("rejects a chunked body that crosses the streamed limit", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"value":"'));
      controller.enqueue(new TextEncoder().encode('too-large"}'));
      controller.close();
    } });
    const request = new Request("https://ops.test/mutation", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    await expect(readBoundedJson(request, 12)).rejects.toMatchObject({ status: 413 });
  });

  it("rejects malformed JSON", async () => {
    const request = new Request("https://ops.test/mutation", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: "{" });
    await expect(readBoundedJson(request, 1024)).rejects.toMatchObject({ status: 400 });
  });
});
