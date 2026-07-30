import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));

import { createIncomingStaffRouter, dispatchIncomingPublicRequest } from "../src/worker/incoming";

const disabledEnv = {
  INCOMING_BASE_URL: "https://incoming.test",
  INCOMING_EXPECTED_HOST: "incoming.test",
  INCOMING_UPLOADS_ENABLED: "false",
};

describe("incoming upload route gate", () => {
  it("returns the stable disabled response before public routes do any work", async () => {
    const response = await dispatchIncomingPublicRequest(
      new Request("https://incoming.test/r/request-id"),
      disabledEnv as never,
      {} as ExecutionContext,
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(503);
    expect(await response!.json()).toEqual({
      error: "incoming_uploads_disabled",
      message: "Incoming uploads are currently disabled",
    });
    expect(response!.headers.get("Cache-Control")).toBe("no-store");
  });

  it("keeps the authenticated internal completion route outside the public-upload gate", async () => {
    const response = await dispatchIncomingPublicRequest(
      new Request("https://incoming.test/api/internal/uploads/upload-id/accepted", { method: "POST" }),
      { ...disabledEnv, INCOMING_PICKUP_SECRET: "pickup-secret" } as never,
      {} as ExecutionContext,
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
    expect(await response!.json()).toEqual({ message: "Invalid pickup credential" });
  });

  it("keeps the incoming-host health check available while uploads are disabled", async () => {
    const response = await dispatchIncomingPublicRequest(
      new Request("https://incoming.test/health"),
      disabledEnv as never,
      {} as ExecutionContext,
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({
      status: "ok",
      service: "ltds-ops-incoming",
      incomingUploads: { enabled: false, reason: "disabled" },
    });
  });

  it("returns the same disabled contract from the staff incoming router", async () => {
    const response = await createIncomingStaffRouter().request("/", {}, disabledEnv as never);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "incoming_uploads_disabled",
      message: "Incoming uploads are currently disabled",
    });
  });
});
