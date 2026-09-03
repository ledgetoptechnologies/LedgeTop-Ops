import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseRetryAfter,
  pollBulkDownload,
  requestJson,
  type BulkDownloadResponse,
  type BulkPollingOptions,
} from "../src/client/bulk-download";

function pollingHarness(
  responses: Array<BulkDownloadResponse | Error>,
  deadlineMs = 60 * 60 * 1_000,
) {
  let now = 0;
  const sleeps: number[] = [];
  const requestStatus = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("Test exhausted its responses");
    if (next instanceof Error) throw next;
    return next;
  });
  const options: BulkPollingOptions = {
    requestStatus,
    now: () => now,
    sleep: async milliseconds => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
    deadlineMs,
  };
  return { options, requestStatus, sleeps };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public bulk-download polling", () => {
  it("continues normal two-second polling beyond three status requests", async () => {
    const harness = pollingHarness([
      { status: "running", processedBytes: 1, totalBytes: 5 },
      { status: "running", processedBytes: 2, totalBytes: 5 },
      { status: "running", processedBytes: 3, totalBytes: 5 },
      { status: "running", processedBytes: 4, totalBytes: 5 },
      { status: "ready", downloadUrl: "/ready.zip" },
    ]);

    const result = await pollBulkDownload({ status: "queued" }, "/status", harness.options);

    expect(result.downloadUrl).toBe("/ready.zip");
    expect(harness.requestStatus).toHaveBeenCalledTimes(5);
    expect(harness.sleeps).toEqual([2_000, 2_000, 2_000, 2_000, 2_000]);
  });

  it("delivers monotonic CRC and assembly progress to the UI", async () => {
    const observed: Array<{ progress?: number; message?: string }> = [];
    const harness = pollingHarness([
      { status: "running", progress: 20, message: "Checking files" },
      { status: "running", progress: 50, message: "Checking files" },
      { status: "running", progress: 75, message: "Building ZIP" },
      { status: "ready", progress: 100, message: "Download ready", downloadUrl: "/ready.zip" },
    ]);
    harness.options.onProgress = response => observed.push({ progress: response.progress, message: response.message });

    await pollBulkDownload({ status: "queued" }, "/status", harness.options);

    expect(observed).toEqual([
      { progress: 20, message: "Checking files" },
      { progress: 50, message: "Checking files" },
      { progress: 75, message: "Building ZIP" },
      { progress: 100, message: "Download ready" },
    ]);
  });

  it("returns every prepared archive part instead of stopping on the first one", async () => {
    const downloads = [
      { part: 1, partCount: 2, size: 100, downloadUrl: "/part-01.zip" },
      { part: 2, partCount: 2, size: 80, downloadUrl: "/part-02.zip" },
    ];
    const harness = pollingHarness([{ status: "ready", partCount: 2, downloads }]);
    await expect(pollBulkDownload({ status: "queued" }, "/status", harness.options)).resolves.toMatchObject({ downloads });
    expect(harness.requestStatus).toHaveBeenCalledTimes(1);
  });

  it("honors Retry-After for a transient 429 and then resumes polling", async () => {
    const limited = Object.assign(new Error("Too many requests"), { status: 429, retryAfterMs: 7_000 });
    const harness = pollingHarness([limited, { status: "ready", ticket: "ticket" }]);

    const result = await pollBulkDownload({ status: "queued" }, "/status", harness.options);

    expect(result.ticket).toBe("ticket");
    expect(harness.sleeps).toEqual([2_000, 7_000]);
  });

  it("retries network and server failures with bounded exponential backoff", async () => {
    const failures = [
      new Error("network"),
      Object.assign(new Error("server"), { status: 503 }),
      new Error("network"),
      new Error("network"),
      new Error("network"),
      new Error("network"),
    ];
    const harness = pollingHarness([...failures, { status: "ready", downloadTicket: "ticket" }]);

    await pollBulkDownload({ status: "queued" }, "/status", harness.options);

    expect(harness.sleeps).toEqual([2_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it.each([
    ["failed", "The archive could not be built"],
    ["expired", "This prepared download has expired"],
    ["cancelled", "This download was cancelled"],
  ] as const)("treats %s as a terminal status", async (status, expected) => {
    const response: BulkDownloadResponse = status === "failed"
      ? { status, error: { code: "GENERAL_FAILURE", message: expected } }
      : { status };
    const harness = pollingHarness([response]);

    await expect(pollBulkDownload({ status: "queued" }, "/status", harness.options)).rejects.toThrow(expected);
    expect(harness.requestStatus).toHaveBeenCalledTimes(1);
  });

  it("stops at the one-hour deadline instead of polling forever", async () => {
    const harness = pollingHarness([{ status: "running" }], 2_000);

    await expect(pollBulkDownload({ status: "queued" }, "/status", harness.options)).rejects.toThrow(
      "The download is still being prepared",
    );
    expect(harness.requestStatus).not.toHaveBeenCalled();
    expect(harness.sleeps).toEqual([2_000]);
  });
});

describe("Retry-After parsing", () => {
  it("supports delta seconds and HTTP dates", () => {
    expect(parseRetryAfter("12", 0)).toBe(12_000);
    expect(parseRetryAfter("Thu, 01 Jan 1970 00:00:05 GMT", 1_000)).toBe(4_000);
    expect(parseRetryAfter("invalid", 0)).toBeUndefined();
  });

  it("attaches Retry-After metadata to request errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "Please wait and try again." }),
      { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "9" } },
    )));

    await expect(requestJson("/status")).rejects.toMatchObject({
      message: "Please wait and try again.",
      status: 429,
      retryAfterMs: 9_000,
    });
  });

  it("sends the selected opaque workspace only to authenticated client APIs", async () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
    vi.stubGlobal("window", { sessionStorage: storage });
    storage.setItem("ltds.client.workspace.v2", "workspace-a");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await requestJson("/api/client/projects");
    await requestJson("/api/client/v2/workspaces");
    await requestJson("/api/public/shares/public-a/manifest");

    const first = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
    const second = new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit).headers);
    const third = new Headers((fetchMock.mock.calls[2]?.[1] as RequestInit).headers);
    expect(first.get("X-LTDS-Workspace-Id")).toBe("workspace-a");
    expect(second.has("X-LTDS-Workspace-Id")).toBe(false);
    expect(third.has("X-LTDS-Workspace-Id")).toBe(false);
  });
});
