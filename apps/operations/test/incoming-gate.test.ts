import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));

import { dispatchIncomingPublicRequest } from "../src/worker/incoming";

const incomingEnv = {
  INCOMING_BASE_URL: "https://incoming.test",
  INCOMING_EXPECTED_HOST: "incoming.test",
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

  it("reports the quarantined incoming workflow as available", async () => {
    const response = await dispatchIncomingPublicRequest(
      new Request("https://incoming.test/health"),
      incomingEnv as never,
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
});
