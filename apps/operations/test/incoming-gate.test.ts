import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));

import { dispatchIncomingPublicRequest } from "../src/worker/incoming";

const incomingEnv = {
  INCOMING_BASE_URL: "https://incoming.test",
  INCOMING_EXPECTED_HOST: "incoming.test",
};

const configuredIncomingEnv = {
  ...incomingEnv,
  DELIVERY_DB: {}, INCOMING_BUCKET: {}, TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET: "secret",
  INCOMING_SESSION_SECRET: "session", INCOMING_ACCESS_CODE_PEPPER: "pepper", INCOMING_PICKUP_SECRET: "pickup",
  R2_ACCOUNT_ID: "account", R2_INCOMING_BUCKET_NAME: "bucket", R2_ACCESS_KEY_ID: "access",
  R2_SECRET_ACCESS_KEY: "secret", INCOMING_LIFECYCLE_WORKFLOW: {},
};

describe("incoming upload route gate", () => {
  it("keeps the authenticated internal completion route outside the public-upload gate", async () => {
    const response = await dispatchIncomingPublicRequest(
      new Request("https://incoming.test/api/internal/uploads/upload-id/accepted", { method: "POST" }),
      { ...incomingEnv, INCOMING_PICKUP_SECRET: "pickup-secret" } as never,
      {} as ExecutionContext,
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
    expect(await response!.json()).toEqual({ message: "Invalid pickup credential" });
  });

  it("keeps the authenticated internal pickup-status route outside the public-upload gate", async () => {
    const response = await dispatchIncomingPublicRequest(
      new Request("https://incoming.test/api/internal/uploads/upload-id/pickup-status", { method: "POST" }),
      { ...incomingEnv, INCOMING_PICKUP_SECRET: "pickup-secret" } as never,
      {} as ExecutionContext,
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
    expect(await response!.json()).toEqual({ message: "Invalid pickup credential" });
  });

  it("keeps the authenticated verification-status route outside the public-upload gate", async () => {
    const response = await dispatchIncomingPublicRequest(
      new Request("https://incoming.test/api/internal/uploads/upload-id/verification-status", { method: "POST" }),
      { ...incomingEnv, INCOMING_PICKUP_SECRET: "pickup-secret" } as never,
      {} as ExecutionContext,
    );
    expect(response?.status).toBe(401);
  });

  it("keeps internal verification listings outside the public-upload gate", async () => {
    const response = await dispatchIncomingPublicRequest(
      new Request("https://incoming.test/api/internal/uploads/verification-candidates"),
      { ...incomingEnv, INCOMING_PICKUP_SECRET: "pickup-secret" } as never,
      {} as ExecutionContext,
    );
    expect(response?.status).toBe(401);
  });

  it("reports the quarantined incoming workflow as available", async () => {
    const response = await dispatchIncomingPublicRequest(
      new Request("https://incoming.test/health"),
      configuredIncomingEnv as never,
      {} as ExecutionContext,
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({
      status: "ok",
      service: "ltds-ops-incoming",
      incomingUploads: { enabled: true, reason: "available" },
    });
  });

  it("fails closed before serving public upload routes when prerequisites are missing", async () => {
    const response = await dispatchIncomingPublicRequest(
      new Request("https://incoming.test/r/request-id"),
      incomingEnv as never,
      {} as ExecutionContext,
    );
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({ error: "incoming_uploads_unavailable" });
  });
});
