import { describe, expect, it, vi } from "vitest";
import {
  signViewerServiceRequest,
  ViewerServiceClient,
  ViewerServiceError,
  viewerServiceConfigured,
  viewerServiceOrigin,
} from "@ltds/shared";

const secret = "viewer-shared-secret-32-characters-minimum";
const share = {
  id: "share-one",
  modelId: "model-one",
  versionPolicy: "latest",
  modelVersionId: null,
  hasPassword: true,
  permissions: { view: true, measure: true, cameras: true, download: false },
  label: "Client demo",
  createdBy: "ops:staff-one",
  createdAt: "2026-08-16T12:00:00.000Z",
  updatedAt: "2026-08-16T12:00:00.000Z",
  expiresAt: "2026-08-23T12:00:00.000Z",
  revokedAt: null,
  revokedBy: null,
  revokeReason: null,
  accessCount: 0,
  lastAccessedAt: null,
  shareClass: "staff" as const,
  sourceAuthorization: null,
};

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
        sourceAuthorization: { type: "model_association", id: "association-one", version: 7 },
      });
      expect(init?.headers).toMatchObject({ "Idempotency-Key": "viewer-session-key-0001" });
      expect(init?.redirect).toBe("manual");
      expect(init?.cache).toBe("no-store");
      return Response.json({
        grant: "00000000-0000-4000-8000-000000000001",
        grantExpiresAt: "2026-08-15T05:01:00.000Z",
        sessionTtlSeconds: 900,
        modelVersionId: "version-one",
        redeemUrl: "https://viewer.example.test/api/v1/sessions/redeem",
        embedUrl: "https://evil.example.test/embed/one",
      }, { status: 201 });
    });
    const client = new ViewerServiceClient({ baseUrl: "https://viewer.example.test", keyId: "ops-v1", secret }, fetcher as typeof fetch);
    await expect(client.createSession({
      modelId: "model-one", modelVersionId: "version-one", subject: "client:identity-one",
      audience: "client", idempotencyKey: "viewer-session-key-0001",
      authorizationExpiresAt: "2026-08-15T05:30:00.000Z",
      sourceAuthorization: { type: "model_association", id: "association-one", version: 7 },
    })).rejects.toBeInstanceOf(ViewerServiceError);
  });

  it("revokes an exact model-association authorization with a signed idempotent request", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe("/api/v1/published-sessions/source-authorization");
      expect(init?.method).toBe("DELETE");
      expect(init?.redirect).toBe("manual");
      expect(init?.headers).toMatchObject({ "Idempotency-Key": "viewer-source-revoke-0001" });
      expect(JSON.parse(String(init?.body))).toEqual({
        sourceAuthorization: { type: "model_association", id: "association-one", version: 7 },
      });
      return Response.json({
        sourceAuthorization: { type: "model_association", id: "association-one", version: 7 },
        revokedGrants: 1, revokedSessions: 2,
      });
    });
    const client = new ViewerServiceClient(
      { baseUrl: "https://viewer.example.test", keyId: "ops-v1", secret }, fetcher as typeof fetch,
    );
    await expect(client.revokePublishedSessionSourceAuthorization({
      sourceAuthorization: { type: "model_association", id: "association-one", version: 7 },
      idempotencyKey: "viewer-source-revoke-0001",
    })).resolves.toEqual({
      sourceAuthorization: { type: "model_association", id: "association-one", version: 7 },
      revokedGrants: 1, revokedSessions: 2,
    });
  });

  it("rejects a session grant for any model version other than the pinned request", async () => {
    const fetcher = vi.fn(async () => Response.json({
      grant: "00000000-0000-4000-8000-000000000001",
      grantExpiresAt: "2026-08-15T05:01:00.000Z",
      sessionTtlSeconds: 900,
      modelVersionId: "version-two",
      redeemUrl: "https://viewer.example.test/api/v1/sessions/redeem",
      embedUrl: "https://viewer.example.test/session/00000000-0000-4000-8000-000000000001",
    }, { status: 201 }));
    const client = new ViewerServiceClient({ baseUrl: "https://viewer.example.test", keyId: "ops-v1", secret }, fetcher as typeof fetch);
    await expect(client.createSession({
      modelId: "model-one", modelVersionId: "version-one", subject: "client:identity-one",
      audience: "client", idempotencyKey: "viewer-session-key-0002",
      authorizationExpiresAt: "2026-08-15T05:30:00.000Z",
    })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("fails closed when the model catalog does not use the canonical string status", async () => {
    const fetcher = vi.fn(async () => Response.json({ models: [{
      id: "model-one", title: "Point cloud", provider: "webodm", status: 40,
      available: true, activeVersion: null, updatedAt: "2026-08-15T05:00:00.000Z",
    }] }));
    const client = new ViewerServiceClient({ baseUrl: "https://viewer.example.test", keyId: "ops-v1", secret }, fetcher as typeof fetch);
    await expect(client.listModels()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("creates, lists, and revokes public shares without returning the raw token", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/models/model-one/shares" && init?.method === "POST") {
        expect(init.headers).toMatchObject({ "Idempotency-Key": "viewer-share-create-0001" });
        expect(init.redirect).toBe("manual");
        expect(init.cache).toBe("no-store");
        expect(JSON.parse(String(init.body))).toMatchObject({
          versionPolicy: "latest",
          createdBy: "ops:staff-one",
          password: "correct horse battery staple",
          expiresAt: "2026-08-23T12:00:00.000Z",
        });
        return Response.json({
          share,
          token: "a-secure-token-that-is-not-forwarded",
          viewUrl: "https://viewer.example.test/view/a-secure-token-that-is-not-forwarded",
          embedUrl: "https://viewer.example.test/embed/a-secure-token-that-is-not-forwarded",
        }, { status: 201 });
      }
      if (url.pathname === "/api/v1/models/model-one/shares") return Response.json({ shares: [share] });
      if (url.pathname === "/api/v1/shares/share-one" && init?.method === "DELETE") {
        expect(init.headers).toMatchObject({ "Idempotency-Key": "viewer-share-revoke-0001" });
        expect(JSON.parse(String(init.body))).toEqual({ reason: "Demo complete" });
        return Response.json({ share: {
          ...share,
          revokedAt: "2026-08-17T12:00:00.000Z",
          revokedBy: "ops-v1",
          revokeReason: "Demo complete",
        } });
      }
      return new Response(null, { status: 404 });
    });
    const client = new ViewerServiceClient({ baseUrl: "https://viewer.example.test", keyId: "ops-v1", secret }, fetcher as typeof fetch);
    expect(await client.listPublicShares("model-one")).toEqual([share]);
    const created = await client.createPublicShare({
      modelId: "model-one",
      idempotencyKey: "viewer-share-create-0001",
      createdBy: "ops:staff-one",
      label: "Client demo",
      expiresAt: "2026-08-23T12:00:00.000Z",
      password: "correct horse battery staple",
    });
    expect(created).toEqual({
      share,
      viewUrl: "https://viewer.example.test/view/a-secure-token-that-is-not-forwarded",
      embedUrl: "https://viewer.example.test/embed/a-secure-token-that-is-not-forwarded",
    });
    expect(created).not.toHaveProperty("token");
    await expect(client.revokePublicShare({
      shareId: "share-one", idempotencyKey: "viewer-share-revoke-0001", reason: "Demo complete",
    })).resolves.toMatchObject({ id: "share-one", revokedAt: "2026-08-17T12:00:00.000Z" });
  });

  it("rejects a cross-origin public share URL", async () => {
    const fetcher = vi.fn(async () => Response.json({
      share,
      token: "a-secure-token-that-is-not-forwarded",
      viewUrl: "https://evil.example.test/view/a-secure-token-that-is-not-forwarded",
      embedUrl: "https://viewer.example.test/embed/a-secure-token-that-is-not-forwarded",
    }, { status: 201 }));
    const client = new ViewerServiceClient({ baseUrl: "https://viewer.example.test", keyId: "ops-v1", secret }, fetcher as typeof fetch);
    await expect(client.createPublicShare({
      modelId: "model-one", idempotencyKey: "viewer-share-create-0002", createdBy: "ops:staff-one",
      expiresAt: "2026-08-23T12:00:00.000Z",
    })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects same-origin capability URLs that do not contain the returned token", async () => {
    const fetcher = vi.fn(async () => Response.json({
      share,
      token: "a-secure-token-that-is-not-forwarded",
      viewUrl: "https://viewer.example.test/admin-login.html",
      embedUrl: "https://viewer.example.test/embed/a-secure-token-that-is-not-forwarded",
    }, { status: 201 }));
    const client = new ViewerServiceClient({ baseUrl: "https://viewer.example.test", keyId: "ops-v1", secret }, fetcher as typeof fetch);
    await expect(client.createPublicShare({
      modelId: "model-one", idempotencyKey: "viewer-share-create-0003", createdBy: "ops:staff-one",
      expiresAt: "2026-08-23T12:00:00.000Z",
    })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("bounds Viewer metadata responses and preserves idempotency conflicts", async () => {
    const oversized = vi.fn(async () => new Response("{}", {
      headers: { "Content-Type": "application/json", "Content-Length": String(2 * 1024 * 1024 + 1) },
    }));
    const oversizedClient = new ViewerServiceClient({ baseUrl: "https://viewer.example.test", keyId: "ops-v1", secret }, oversized as typeof fetch);
    await expect(oversizedClient.listModels()).rejects.toMatchObject({ code: "invalid_response" });

    const conflict = vi.fn(async () => Response.json(
      { error: "Idempotency-Key was already used for a different request" },
      { status: 409 },
    ));
    const conflictClient = new ViewerServiceClient({ baseUrl: "https://viewer.example.test", keyId: "ops-v1", secret }, conflict as typeof fetch);
    await expect(conflictClient.revokePublicShare({
      shareId: "share-one", idempotencyKey: "viewer-share-revoke-0002", reason: "Demo complete",
    })).rejects.toMatchObject({ code: "conflict", status: 409 });
  });

  it("uses Worker-compatible manual redirect handling and rejects every redirect", async () => {
    const redirected = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { Location: "https://evil.example.test/capture" },
      });
    });
    const client = new ViewerServiceClient({
      baseUrl: "https://viewer.example.test",
      keyId: "ops-v1",
      secret,
    }, redirected as typeof fetch);
    await expect(client.listModels()).rejects.toMatchObject({ code: "unavailable", status: 503 });
    expect(redirected).toHaveBeenCalledOnce();
  });
});
