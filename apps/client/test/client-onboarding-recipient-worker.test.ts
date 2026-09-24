import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/worker/types";
import { clientOnboardingRecipientRouter } from "../src/worker/client-onboarding-recipient";

const origin = "https://portal.example.test";
const invitationId = "00000000-0000-4000-8000-000000000001";
const invitationSecret = "ab".repeat(32);
const path = `${origin}/${invitationId}/session`;

function environment(enabled: boolean) {
  const session = vi.fn().mockResolvedValue({ ok: true, protocolVersion: 1, state: "pending" });
  const limit = vi.fn().mockResolvedValue({ success: true });
  return { env: {
    CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED: enabled ? "true" : "false",
    CLIENT_ONBOARDING_RECIPIENT_BRIDGE: { session },
    PUBLIC_SESSION_RATE_LIMITER: { limit },
  } as unknown as Env, session, limit };
}

function request(body: string, requestOrigin = origin) {
  return { method: "POST", headers: { Origin: requestOrigin, "Content-Type": "application/json" }, body };
}

describe("client onboarding recipient Worker boundary", () => {
  it("does not call the bridge while the feature flag is off", async () => {
    const { env, session, limit } = environment(false);
    const response = await clientOnboardingRecipientRouter.request(path, request(JSON.stringify({ invitationSecret })), env);
    expect(response.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests before consuming quota", async () => {
    const { env, session, limit } = environment(true);
    const response = await clientOnboardingRecipientRouter.request(path,
      request(JSON.stringify({ invitationSecret }), "https://other.example.test"), env);
    expect(response.status).toBe(403);
    expect(session).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
  });

  it("rejects an oversized actual body even without Content-Length", async () => {
    const { env, session } = environment(true);
    const response = await clientOnboardingRecipientRouter.request(path,
      request(JSON.stringify({ invitationSecret, padding: "x".repeat(13_000) })), env);
    expect(response.status).toBe(413);
    expect(session).not.toHaveBeenCalled();
  });

  it("forwards a bounded same-origin session request", async () => {
    const { env, session } = environment(true);
    const response = await clientOnboardingRecipientRouter.request(path, request(JSON.stringify({ invitationSecret })), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, state: "pending" });
    expect(session).toHaveBeenCalledWith({ protocolVersion: 1, invitationId, invitationSecret });
  });
});
