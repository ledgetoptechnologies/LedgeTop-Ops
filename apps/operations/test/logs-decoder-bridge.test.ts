import { describe, expect, it } from "vitest";
import { dispatchLogsDecoderBridge, LOGS_DECODER_LIMITS, type LogsDecoderBinding } from "../src/worker/logs-decoder-bridge";
import bridgeWorker from "../src/worker/logs-decoder-bridge-worker";
import type { Env } from "../src/worker/types";

const TOKEN = "decoder-runner-token-0123456789abcdefghijklmn";
const NEXT = "decoder-runner-token-next-0123456789abcdefghij";
const HOST = "logs-decoder.machine.example";
const AUD = "ledgetop-logs-decoder-staging";
const hex = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, "0")).join("");
const SHA = "a".repeat(64);

function fakeDecoder(calls: unknown[][]): LogsDecoderBinding {
  const ok = <T,>(value: T) => Promise.resolve({ ok: true as const, value });
  return {
    claim: input => { calls.push(["claim", input]); return ok({ sha256: SHA, attemptToken: "t1", leaseExpiresAt: "x", attempt: 1, reclaims: 0 }); },
    heartbeat: lease => { calls.push(["heartbeat", lease]); return ok({ leaseExpiresAt: "y" }); },
    readRaw: lease => { calls.push(["readRaw", lease]); return ok({ sha256: SHA, size: 3, body: new Blob([new Uint8Array([1, 2, 3])]).stream() }); },
    complete: (lease, result) => { calls.push(["complete", lease, { ...result, track: [...result.track] }]); return ok({ status: "decoded", flightId: "f1" }); },
    defer: (lease, input) => { calls.push(["defer", lease, input]); return ok({ status: "needs_parse" }); },
    retry: (lease, input) => { calls.push(["retry", lease, input]); return Promise.resolve({ ok: false as const, error: { code: "lease_stale", status: 409 } }); },
    suspend: (lease, input) => { calls.push(["suspend", lease, input]); return ok({ status: "suspended" }); },
    fail: (lease, input) => { calls.push(["fail", lease, input]); return Promise.resolve({ ok: false as const, error: { code: "internal_error", status: 500, message: "secret detail" } }); },
    reconcile: lease => { calls.push(["reconcile", lease]); return ok({ status: "lost" }); },
  };
}

async function env(extra: Record<string, unknown> = {}, calls: unknown[][] = []) {
  return { LOGS_DECODER_ENABLED: "true", LOGS_DECODER: fakeDecoder(calls), LOGS_DECODER_MACHINE_HOST: HOST, LOGS_DECODER_AUDIENCE: AUD,
    LOGS_DECODER_RUNNER_ID: "staging-90-decoder-1", LOGS_DECODER_TOKEN_SHA256: await hex(TOKEN), ...extra } as unknown as Env;
}
const request = (route: string, init: RequestInit & { token?: string | null; audience?: string; host?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.token !== null) headers.set("Authorization", `Bearer ${init.token ?? TOKEN}`);
  headers.set("X-Machine-Audience", init.audience ?? AUD);
  return new Request(`https://${init.host ?? HOST}/api/machine/logs-decoder/${route}`, { method: init.method ?? "POST", headers, body: init.body });
};

describe("Logs decoder machine bridge", () => {
  it("is closed by default: unconfigured, other hosts and partial configuration never reach the decoder", async () => {
    expect(await dispatchLogsDecoderBridge(request("claim", { body: "{}" }), {} as Env)).toBeNull();
    expect(await dispatchLogsDecoderBridge(request("claim", { body: "{}", host: "ops.example" }), await env())).toBeNull();
    expect(await dispatchLogsDecoderBridge(new Request(`https://${HOST}/api/flight-logs/flights`), await env())).toBeNull();
    for (const extra of [{ LOGS_DECODER_ENABLED: "false" }, { LOGS_DECODER: undefined }, { LOGS_DECODER_AUDIENCE: "" }, { LOGS_DECODER_TOKEN_SHA256: "nothex" },
      { LOGS_DECODER_RUNNER_ID: "" }, { LOGS_DECODER_RUNNER_ID: "Bad_Id%" }]) {
      const calls: unknown[][] = [];
      const response = await dispatchLogsDecoderBridge(request("claim", { body: "{}" }), await env(extra, calls));
      expect(response?.status).toBe(404);
      expect(calls).toEqual([]);
    }
    expect((await dispatchLogsDecoderBridge(request("claim", { method: "GET" }), await env()))?.status).toBe(404);
    expect((await dispatchLogsDecoderBridge(request("flights", { body: "{}" }), await env()))?.status).toBe(404);
  });

  it("accepts only the runner's token for the configured audience, including the rotation key", async () => {
    const calls: unknown[][] = [];
    const e = await env({ LOGS_DECODER_TOKEN_SHA256_NEXT: await hex(NEXT) }, calls);
    for (const init of [{ token: null }, { token: "wrong-token-0123456789abcdefghijklmnopq" }, { audience: "ledgetop-logs-decoder-production" }])
      expect((await dispatchLogsDecoderBridge(request("claim", { body: "{}", ...init }), e))?.status).toBe(401);
    expect(calls).toEqual([]);
    expect((await dispatchLogsDecoderBridge(request("claim", { body: JSON.stringify({ requestId: "r-0000000000000001" }), token: NEXT }), e))?.status).toBe(200);
  });

  it("forwards only fixed calls and fields, streams the held raw bytes, and maps errors to fixed codes", async () => {
    const calls: unknown[][] = [];
    const e = await env({}, calls);
    const lease = { sha256: SHA, attemptToken: "t1" };
    const claim = await dispatchLogsDecoderBridge(request("claim", { body: JSON.stringify({ requestId: "r-0000000000000001", pilotId: "staff-x", runnerId: "someone-else" }) }), e);
    expect(await claim?.json()).toMatchObject({ sha256: SHA, attemptToken: "t1" });
    const raw = await dispatchLogsDecoderBridge(request("raw", { body: JSON.stringify(lease) }), e);
    expect(raw?.headers.get("X-Content-Sha256")).toBe(SHA);
    expect([...new Uint8Array(await raw!.arrayBuffer())]).toEqual([1, 2, 3]);
    const summary = Buffer.from(JSON.stringify({ telemetry_points: 3 })).toString("base64url");
    const done = await dispatchLogsDecoderBridge(request("complete", { body: new Uint8Array([0x1f, 0x8b, 9]), headers: { "X-Lease-Sha256": SHA, "X-Attempt-Token": "t1",
      "X-Content-Sha256": SHA, "X-Decoder-Version": "v1", "X-Decode-Summary": summary } }), e);
    expect(done?.status).toBe(200);
    await dispatchLogsDecoderBridge(request("defer", { body: JSON.stringify({ ...lease, errorCode: "dji_unavailable", retryAfterSeconds: 120 }) }), e);
    expect((await dispatchLogsDecoderBridge(request("retry", { body: JSON.stringify({ ...lease, errorCode: "decoder_error" }) }), e))?.status).toBe(409);
    const failed = await dispatchLogsDecoderBridge(request("fail", { body: JSON.stringify({ ...lease, errorCode: "corrupt_log" }) }), e);
    expect([failed?.status, await failed?.json()]).toEqual([502, { error: "internal_error" }]);
    await dispatchLogsDecoderBridge(request("suspend", { body: JSON.stringify({ ...lease, errorCode: "resource_capacity" }) }), e);
    expect(calls.map(call => call[0])).toEqual(["claim", "readRaw", "complete", "defer", "retry", "fail", "suspend"]);
    expect(calls[0]).toEqual(["claim", { runnerId: "staging-90-decoder-1", requestId: "r-0000000000000001" }]); // the runner id comes from configuration, never the request
    expect(calls[2]).toEqual(["complete", lease, { contentSha256: SHA, summary: { telemetry_points: 3 }, track: [0x1f, 0x8b, 9], decoderVersion: "v1" }]);
    expect(calls[3]).toEqual(["defer", lease, { errorCode: "dji_unavailable", retryAfterSeconds: 120 }]);
  });

  it("refuses oversized or malformed input before calling the decoder", async () => {
    const calls: unknown[][] = [];
    const e = await env({}, calls);
    const big = await dispatchLogsDecoderBridge(request("complete", { body: new Uint8Array(8), headers: { "X-Lease-Sha256": SHA, "X-Attempt-Token": "t1",
      "X-Decode-Summary": "e30", "Content-Length": String(LOGS_DECODER_LIMITS.trackGzipBytes + 1) } }), e);
    expect(big?.status).toBe(413);
    expect((await dispatchLogsDecoderBridge(request("heartbeat", { body: JSON.stringify({ sha256: "nothex", attemptToken: "t1" }) }), e))?.status).toBe(409);
    expect((await dispatchLogsDecoderBridge(request("claim", { body: "not json" }), e))?.status).toBe(400);
    expect((await dispatchLogsDecoderBridge(request("complete", { body: new Uint8Array(1), headers: { "X-Lease-Sha256": SHA, "X-Attempt-Token": "t1", "X-Decode-Summary": "!!" } }), e))?.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("the dedicated bridge Worker answers 404 for everything that isn't a decoder machine call, never falling through", async () => {
    const calls: unknown[][] = [];
    const e = await env({}, calls);
    for (const url of [`https://${HOST}/`, `https://${HOST}/api/flight-logs/flights`, `https://${HOST}/api/session`, `https://other.example/api/machine/logs-decoder/claim`,
      `https://${HOST}/api/machine/logs-decoder/flights`])
      expect((await bridgeWorker.fetch(new Request(url, { method: "POST", body: "{}" }), e)).status).toBe(404);
    expect((await bridgeWorker.fetch(request("claim", { body: JSON.stringify({ requestId: "r-0000000000000002" }) }), e)).status).toBe(200);
    expect(calls.map(call => call[0])).toEqual(["claim"]);
  });
});
