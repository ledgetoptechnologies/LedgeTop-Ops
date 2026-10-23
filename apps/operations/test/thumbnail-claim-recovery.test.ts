import { describe, expect, it, vi } from "vitest";
import { dispatchThumbnailRendererApi } from "../src/worker/thumbnail-renderer-api";

const SECRET = "synthetic-thumbnail-secret-with-at-least-32-characters";
const sourceKey = "Jobs/Clients/private-test/client-file.jpg";
const network = "D1_ERROR: Network connection lost";
const reset = "D1_ERROR: Internal error in D1 DB storage caused object to be reset; reference = private-reference";

describe("thumbnail claim dependency recovery", () => {
  it("keeps a successful unified idle poll at 200 without a retry hint or R2 access", async () => {
    const head = vi.fn();
    const response = await dispatchThumbnailRendererApi(new Request(
      "https://incoming.example.test/api/internal/thumbnail-renderer/v1/claim?includeKind=all",
      { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } },
    ), {
      THUMBNAIL_RENDERER_EXPECTED_HOST: "incoming.example.test", THUMBNAIL_INGEST_SECRET: SECRET,
      DELIVERY_DB: { prepare() { return { bind() { return this; },
        async run() { return { meta: { changes: 1 } }; }, async first() { return null; } }; } },
      DATA_BUCKET: { head },
    } as never);
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ status: "idle" });
    expect(response!.headers.get("Retry-After")).toBeNull();
    expect(head).not.toHaveBeenCalled();
  });
  it.each([
    ["health_write", network, 503],
    ["candidate_read", reset, 503],
    ["lease_write", network, 503],
    ["candidate_read", "D1_ERROR: no such column: render_not_before", 500],
    ["candidate_read", "D1_ERROR: UNIQUE constraint failed: private-value", 500],
    ["candidate_read", "unrelated Network connection lost", 500],
    ["source_head", network, 500],
  ] as const)("classifies %s without replay or private exception text", async (failingPhase, message, status) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let leaseWrites = 0;
    const counts = { health: 0, candidate: 0, source: 0 };
    const prepare = (sql: string) => {
      const statement = {
        bind(..._values: unknown[]) { return statement; },
        async run() {
          if (sql.includes("INSERT INTO delivery_sync_health")) {
            counts.health++;
            if (failingPhase === "health_write") throw new Error(message);
          } else {
            // Simulate a lease committed before its transport response failed.
            leaseWrites++;
            if (failingPhase === "lease_write") throw new Error(message);
          }
          return { meta: { changes: 1 } };
        },
        async first() {
          counts.candidate++;
          if (failingPhase === "candidate_read") throw new Error(message);
          return { source_key: sourceKey, source_etag: "private-etag", source_size: 100,
            thumbnail_key: "_ltds/derivatives/thumbnails/v1/managed/private.webp", attempt_count: 0 };
        },
      };
      return statement;
    };
    try {
      const response = await dispatchThumbnailRendererApi(new Request(
        "https://incoming.example.test/api/internal/thumbnail-renderer/v1/claim?includeKind=all",
        { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } },
      ), {
        THUMBNAIL_RENDERER_EXPECTED_HOST: "incoming.example.test", THUMBNAIL_INGEST_SECRET: SECRET,
        DELIVERY_DB: { prepare }, DATA_BUCKET: { async head() {
          counts.source++;
          if (failingPhase === "source_head") throw new Error(message);
          return { httpEtag: '"private-etag"', size: 100, httpMetadata: { contentType: "image/jpeg" } };
        } },
      } as never);
      expect(response?.status).toBe(status);
      const body = await response!.json() as { error: string; correlationId: string };
      expect(body.error).toBe(status === 503 ? "claim_database_unavailable" : "claim_internal_error");
      expect(body.correlationId).toMatch(/^[a-f0-9-]{36}$/);
      expect(response!.headers.get("X-Request-Id")).toBe(body.correlationId);
      expect(response!.headers.get("Retry-After")).toBe(status === 503 ? "30" : null);
      expect(JSON.parse(log.mock.calls[0]![0])).toEqual({ event: "thumbnail.renderer.claim.error",
        phase: failingPhase, errorCode: body.error, correlationId: body.correlationId });
      const output = JSON.stringify([body, log.mock.calls]);
      for (const privateValue of [SECRET, sourceKey, "private-reference", "private-etag", "render_not_before", message])
        expect(output).not.toContain(privateValue);
      expect(counts.health).toBe(1);
      expect(counts.candidate).toBe(failingPhase === "health_write" ? 0 : 1);
      expect(counts.source).toBe(["source_head", "lease_write"].includes(failingPhase) ? 1 : 0);
      expect(leaseWrites).toBe(failingPhase === "lease_write" ? 1 : 0);
    } finally { log.mockRestore(); }
  });
});
