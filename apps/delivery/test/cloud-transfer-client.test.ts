import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelCloudTransfer,
  cloudTransferPercent,
  startCloudTransferAuthorization,
  failedCloudTransferItems,
  isCloudAuthorizationResult,
  pollCloudTransfer,
  retryCloudTransfer,
  type CloudTransferJob,
  type CloudTransferPollingOptions,
} from "../src/client/cloud-transfer";

afterEach(() => vi.unstubAllGlobals());

function harness(responses: Array<CloudTransferJob | Error>, deadlineMs = 60_000) {
  let now = 0;
  const sleeps: number[] = [];
  const options: CloudTransferPollingOptions = {
    now: () => now,
    deadlineMs,
    sleep: async milliseconds => { sleeps.push(milliseconds); now += milliseconds; },
    requestStatus: vi.fn(async () => {
      const response = responses.shift();
      if (!response) throw new Error("Test exhausted responses");
      if (response instanceof Error) throw response;
      return response;
    }),
  };
  return { options, sleeps };
}

describe("cloud transfer requests", () => {
  it("creates selected and full-delivery jobs without ZIP requests", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ id: "job", provider: "dropbox", status: "queued" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);
    await startCloudTransferAuthorization("public/id", "dropbox", {
      selection: { items: ["one", "two"] },
      conflictMode: "rename", callbackNonce: "nonce-one",
    });
    await startCloudTransferAuthorization("public/id", "google-drive", {
      selection: { all: true },
      conflictMode: "skip", callbackNonce: "nonce-two",
    });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/public/shares/public%2Fid/cloud-transfers/oauth/dropbox/start");
    expect(JSON.parse(String((fetch.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      selection: { items: ["one", "two"] }, conflictMode: "rename", callbackNonce: "nonce-one",
    });
    expect(JSON.parse(String((fetch.mock.calls[1]?.[1] as RequestInit).body)).selection).toEqual({ all: true });
  });

  it("uses explicit cancel and retry routes", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ id: "job/id", provider: "dropbox", status: "cancelled" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);
    await cancelCloudTransfer("share/id", "job/id");
    await retryCloudTransfer("share/id", "job/id");
    expect(fetch.mock.calls.map(call => call[0])).toEqual([
      "/api/public/shares/share%2Fid/cloud-transfers/job%2Fid/cancel",
      "/api/public/shares/share%2Fid/cloud-transfers/job%2Fid/retry",
    ]);
  });
});

describe("cloud transfer polling", () => {
  it("reports progress and completes", async () => {
    const observed: string[] = [];
    const test = harness([
      { id: "job", provider: "dropbox", status: "running", processedFiles: 1, totalFiles: 2 },
      { id: "job", provider: "dropbox", status: "completed", processedFiles: 2, totalFiles: 2 },
    ]);
    test.options.onProgress = job => observed.push(job.status);
    const result = await pollCloudTransfer({ id: "job", provider: "dropbox", status: "queued" }, "/status", test.options);
    expect(result.status).toBe("completed");
    expect(observed).toEqual(["running", "completed"]);
    expect(test.sleeps).toEqual([2_000, 2_000]);
  });

  it("honors Retry-After and bounded backoff", async () => {
    const limited = Object.assign(new Error("limited"), { status: 429, retryAfterMs: 7_000 });
    const test = harness([
      limited,
      Object.assign(new Error("network"), { status: undefined }),
      Object.assign(new Error("server"), { status: 503 }),
      { id: "job", provider: "google-drive", status: "completed" },
    ]);
    await pollCloudTransfer({ id: "job", provider: "google-drive", status: "queued" }, "/status", test.options);
    expect(test.sleeps).toEqual([2_000, 7_000, 4_000, 8_000]);
  });

  it("surfaces failed terminal state", async () => {
    const test = harness([{ id: "job", provider: "dropbox", status: "failed", error: { message: "Provider rejected the copy" } }]);
    await expect(pollCloudTransfer(
      { id: "job", provider: "dropbox", status: "queued" }, "/status", test.options,
    )).rejects.toThrow("Provider rejected");
  });

  it("returns cancelled terminal state without presenting cancellation as a failure", async () => {
    const test = harness([{ id: "job", provider: "dropbox", status: "cancelled" }]);
    await expect(pollCloudTransfer(
      { id: "job", provider: "dropbox", status: "cancelling" }, "/status", test.options,
    )).resolves.toMatchObject({ status: "cancelled" });
  });
});

describe("cloud authorization messages", () => {
  it("accepts only complete typed messages", () => {
    expect(isCloudAuthorizationResult({
      type: "ltds-cloud-authorization",
      nonce: "nonce",
      jobId: "job",
      provider: "google-drive",
      ok: true,
    })).toBe(true);
    expect(isCloudAuthorizationResult({ type: "ltds-cloud-authorization", ok: true })).toBe(false);
    expect(isCloudAuthorizationResult({
      type: "ltds-cloud-authorization",
      nonce: "nonce",
      jobId: "job",
      provider: "unknown",
      ok: true,
    })).toBe(false);
  });
});

describe("cloud progress helpers", () => {
  it("uses bytes before files and clamps progress", () => {
    expect(cloudTransferPercent({
      id: "job", provider: "dropbox", status: "running",
      processedBytes: 75, totalBytes: 100, processedFiles: 10, totalFiles: 10,
    })).toBe(75);
    expect(cloudTransferPercent({
      id: "job", provider: "dropbox", status: "running", processedFiles: 7, totalFiles: 5,
    })).toBe(100);
  });

  it("returns only failed items for retry presentation", () => {
    expect(failedCloudTransferItems({
      id: "job", provider: "dropbox", status: "failed",
      items: [
        { id: "1", name: "done.jpg", status: "copied" },
        { id: "2", name: "failed.jpg", status: "failed" },
      ],
    }).map(item => item.id)).toEqual(["2"]);
  });
});
