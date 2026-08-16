import { describe, expect, it, vi } from "vitest";
import {
  signViewerServiceRequest,
  ViewerServiceClient,
  ViewerServiceError,
  viewerServiceConfigured,
  viewerServiceOrigin,
} from "@ltds/shared";

const secret = "viewer-shared-secret-32-characters-minimum";

describe("Viewer service client", () => {
  it("matches the exact-path and exact-body HMAC golden fixture", async () => {
    const body = '{"subject":"client:abc","audience":"client"}';
    const headers = await signViewerServiceRequest({
      secret,
      keyId: "ops-v1",
      method: "post",
      pathWithQuery: "/api/v1/models/model_123/sessions?mode=embed",
      body,
      timestamp: 1_800_000_000,
      nonce: "nonce_1234567890abcdef",
    });
    expect(headers).toEqual({
      "X-LTDS-Key-Id": "ops-v1",
      "X-LTDS-Timestamp": "1800000000",
      "X-LTDS-Nonce": "nonce_1234567890abcdef",
      "X-LTDS-Content-SHA256": "b14b2dcc365fd7e476cbac1efc19c2d09977a03f7b1594027683f2e69e72f1b7",
      "X-LTDS-Signature": "k4g487VYlE3RplOplbiyTowG8o_OYnmoggCka40cfKU",
    });
    const changedBody = await signViewerServiceRequest({
      secret, keyId: "ops-v1", method: "POST",
      pathWithQuery: "/api/v1/models/model_123/sessions?mode=embed",
      body: `${body} `, timestamp: 1_800_000_000, nonce: "nonce_1234567890abcdef",
    });
    expect(changedBody["X-LTDS-Signature"]).not.toBe(headers["X-LTDS-Signature"]);
  });

  it("accepts only a bare HTTPS Viewer origin and a sufficiently strong secret", () => {
    expect(viewerServiceOrigin("https://viewer.example.test")).toBe("https://viewer.example.test");
    expect(viewerServiceOrigin("https://viewer.example.test/api")).toBeNull();
    expect(viewerServiceOrigin("http://viewer.example.test")).toBeNull();
    expect(viewerServiceConfigured({ baseUrl: "https://viewer.example.test", keyId: "ops-v1", secret })).toBe(true);
    expect(viewerServiceConfigured({ baseUrl: "https://viewer.example.test", keyId: "ops-v1", secret: "short" })).toBe(false);
  });

  it("signs the serialized session body and rejects cross-origin response URLs", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body || "");
      expect(JSON.parse(body)).toMatchObject({
        subject: "client:identity-one",
        audience: "client",
        modelVersionId: "version-one",
        authorizationExpiresAt: "2026-08-15T05:30:00.000Z",
      });
      expect(init?.headers).toMatchObject({ "Idempotency-Key": "viewer-session-key-0001" });
      return Response.json({
        grant: "00000000-0000-4000-8000-000000000001",
        grantExpiresAt: "2026-08-15T05:01:00.000Z",
        sessionTtlSeconds: 900,
        redeemUrl: "https://viewer.example.test/api/v1/sessions/redeem",
        embedUrl: "https://evil.example.test/embed/one",
      }, { status: 201 });
    });
    const client = new ViewerServiceClient({ baseUrl: "https://viewer.example.test", keyId: "ops-v1", secret }, fetcher as typeof fetch);
    await expect(client.createSession({
      modelId: "model-one", modelVersionId: "version-one", subject: "client:identity-one",
      audience: "client", idempotencyKey: "viewer-session-key-0001",
      authorizationExpiresAt: "2026-08-15T05:30:00.000Z",
    })).rejects.toBeInstanceOf(ViewerServiceError);
  });

  it("fails closed when the model catalog does not use the canonical string status", async () => {
    const fetcher = vi.fn(async () => Response.json({ models: [{
      id: "model-one", title: "Point cloud", provider: "webodm", status: 40,
      available: true, activeVersion: null, updatedAt: "2026-08-15T05:00:00.000Z",
    }] }));
    const client = new ViewerServiceClient({ baseUrl: "https://viewer.example.test", keyId: "ops-v1", secret }, fetcher as typeof fetch);
    await expect(client.listModels()).rejects.toMatchObject({ code: "invalid_response" });
  });
});
