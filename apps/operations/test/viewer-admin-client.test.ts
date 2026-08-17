import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewerAdminClient } from "../src/client/viewer-admin-client";

const token = "a".repeat(43);
const json = (value: unknown, status = 200) => Response.json(value, { status });
const session = (expiresAt: string) => ({
  accessToken: token,
  session: { id: "session-one", subject: "ops:staff-one", permissions: ["viewer.projects.read"], expiresAt },
  units: { default: "imperial", resolved: "metric" },
});
const grant = () => json({
  grant: "g".repeat(43), grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  sessionTtlSeconds: 1800, redeemUrl: "https://viewer.example.test/api/v1/admin-sessions/redeem",
  units: { default: "imperial", resolved: "metric" },
}, 201);

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Viewer administrative browser client", () => {
  it("single-flights parallel authorization and never sends metadata through Operations", async () => {
    const opsFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => grant());
    vi.stubGlobal("fetch", opsFetch);
    let redemptions = 0;
    const viewerFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/redeem")) { redemptions += 1; return json(session(new Date(Date.now() + 30 * 60_000).toISOString())); }
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${token}`);
      return json({ projects: [] });
    });
    const client = new ViewerAdminClient("https://viewer.example.test", viewerFetch as typeof fetch);
    await Promise.all([client.request("/api/v1/projects"), client.request("/api/v1/datasets")]);
    expect(redemptions).toBe(1);
    expect(opsFetch).toHaveBeenCalledTimes(1);
    expect(opsFetch.mock.calls[0]![0]).toBe("/api/viewer/admin-grant");
  });

  it("preserves a still-valid session when proactive renewal fails, then fails after expiry", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-08-16T12:00:00Z"));
    let grantCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      grantCalls += 1;
      if (grantCalls === 1) return grant();
      return json({ error: "temporarily unavailable" }, 503);
    }));
    const viewerFetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      return path.endsWith("/redeem")
        ? json(session(new Date(Date.now() + 4 * 60_000).toISOString()))
        : json({ projects: [] });
    });
    const client = new ViewerAdminClient("https://viewer.example.test", viewerFetch as typeof fetch);
    await expect(client.request("/api/v1/projects")).resolves.toEqual({ projects: [] });
    await expect(client.request("/api/v1/projects")).resolves.toEqual({ projects: [] });
    expect(client.status().renewalError).toContain("temporarily unavailable");
    vi.advanceTimersByTime(5 * 60_000);
    await expect(client.request("/api/v1/projects")).rejects.toThrow("temporarily unavailable");
  });

  it("rejects oversized or non-JSON Viewer metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => grant()));
    let redeemed = false;
    const viewerFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (!redeemed) { redeemed = true; return json(session(new Date(Date.now() + 30 * 60_000).toISOString())); }
      return new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": String(2 * 1024 * 1024 + 1) } });
    });
    const client = new ViewerAdminClient("https://viewer.example.test", viewerFetch as typeof fetch);
    await expect(client.request("/api/v1/projects")).rejects.toThrow(/failed|oversized/i);
  });

  it("renews during a long direct upload without restarting completed chunks", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-08-16T12:00:00Z"));
    vi.stubGlobal("fetch", vi.fn(async () => grant()));
    let redemptions = 0;
    const uploaded: number[] = [];
    const viewerFetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/redeem")) {
        redemptions += 1;
        return json(session(new Date(Date.now() + (redemptions === 1 ? 6 : 30) * 60_000).toISOString()));
      }
      uploaded.push(Number(path.split("/").at(-1)));
      return json({ chunk: { index: uploaded.at(-1), byteSize: 1, sha256: "00", replayed: false } }, 201);
    });
    const client = new ViewerAdminClient("https://viewer.example.test", viewerFetch as typeof fetch);
    for (let index = 0; index < 3; index += 1) {
      await client.uploadChunk({ uploadId: "upload-one", fileId: "file-one", index, uploadToken: "upload-token", sha256: "00", body: new Blob([new Uint8Array([index])]) });
      vi.advanceTimersByTime(2 * 60_000);
    }
    expect(redemptions).toBe(2);
    expect(uploaded).toEqual([0, 1, 2]);
    expect(client.status().renewalError).toBeNull();
  });

  it("exposes only validated response metadata needed for durable 202 operations", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => grant()));
    let redeemed = false;
    const viewerFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (!redeemed) { redeemed = true; return json(session(new Date(Date.now() + 30 * 60_000).toISOString())); }
      return Response.json({ operation: { id: "operation-one" } }, {
        status: 202,
        headers: { Location: "/api/v1/operations/operation-one", "Retry-After": "2" },
      });
    });
    const client = new ViewerAdminClient("https://viewer.example.test", viewerFetch as typeof fetch);
    await expect(client.requestWithMetadata("/api/v1/finalize", { method: "POST", body: "{}" })).resolves.toMatchObject({
      status: 202, location: "/api/v1/operations/operation-one", retryAfterSeconds: 2,
      payload: { operation: { id: "operation-one" } },
    });
  });

  it("loads private dataset images with the bearer token and rejects unsafe image responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => grant()));
    let redeemed = false, mode: "image" | "wrong-type" | "oversized" = "image";
    const viewerFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (!redeemed) { redeemed = true; return json(session(new Date(Date.now() + 30 * 60_000).toISOString())); }
      expect(path).toContain("/gcp-images/");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${token}`);
      if (mode === "wrong-type") return new Response("not an image", { headers: { "Content-Type": "text/plain" } });
      if (mode === "oversized") return new Response(new Uint8Array([1]), { headers: { "Content-Type": "image/jpeg", "Content-Length": String(128 * 1024 * 1024 + 1) } });
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/jpeg", "Content-Length": "3" } });
    });
    const client = new ViewerAdminClient("https://viewer.example.test", viewerFetch as typeof fetch);
    await expect(client.requestBlob("/api/v1/datasets/dataset-one/gcp-images/image-one/content")).resolves.toMatchObject({ size: 3, type: "image/jpeg" });
    mode = "wrong-type";
    await expect(client.requestBlob("/api/v1/datasets/dataset-one/gcp-images/image-one/content")).rejects.toThrow(/unsupported image/i);
    mode = "oversized";
    await expect(client.requestBlob("/api/v1/datasets/dataset-one/gcp-images/image-one/content")).rejects.toThrow(/oversized image/i);
  });
});
