import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { ClientOnboardingRecipientBridge } from "../src/worker/client-onboarding-recipient-entrypoint";
import { consumeClientOnboardingRateLimit } from "../src/worker/client-onboarding-rate-limit";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
vi.mock("../src/worker/client-onboarding-rate-limit", () => ({ consumeClientOnboardingRateLimit: vi.fn().mockResolvedValue(false) }));

const root = new URL("../../../", import.meta.url);
const config = (name: string) => readFileSync(new URL(name, root), "utf8");

describe("private client onboarding recipient bridge", () => {
  it("is unavailable while its Operations gate is disabled", async () => {
    const bridge = Object.create(ClientOnboardingRecipientBridge.prototype) as ClientOnboardingRecipientBridge;
    await expect(bridge.session({ protocolVersion: 1, invitationId: "opaque", invitationSecret: "opaque" }))
      .resolves.toEqual({ ok: false, protocolVersion: 1, code: "unavailable" });
    await expect(bridge.submit({ protocolVersion: 1, invitationId: "opaque", invitationSecret: "opaque", submissionId: "opaque", fields: {} }))
      .resolves.toEqual({ ok: false, protocolVersion: 1, code: "unavailable" });
    await expect(bridge.status({ protocolVersion: 1, invitationId: "opaque", invitationSecret: "opaque", submissionId: "opaque" }))
      .resolves.toEqual({ ok: false, protocolVersion: 1, code: "unavailable" });
  });

  it("keeps both deployment gates off and avoids a public Operations route", () => {
    expect(config("apps/client/wrangler.jsonc")).toContain('"CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED": "false"');
    expect(config("apps/operations/wrangler.jsonc")).toContain('"CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED": "false"');
    expect(config("apps/client/wrangler.jsonc")).toContain('"entrypoint": "ClientOnboardingRecipientBridge"');
    expect(config("docs/staging/delivery.wrangler.json.example")).toContain('"entrypoint": "ClientOnboardingRecipientBridge"');
    expect(config("docs/staging/operations.wrangler.json.example")).toContain('"CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED": "false"');
    expect(config("apps/client/src/worker/index.ts")).toContain('"/api/client-onboarding"');
    expect(config("apps/client/src/worker/index.ts")).toContain('"/onboarding/:invitationId"');
    expect(config("apps/client/wrangler.jsonc")).toContain('"/onboarding/*"');
    expect(config("apps/operations/src/worker/index.ts")).not.toContain('"/api/client-onboarding/recipient"');
  });

  it("does not touch D1 or quota under disabled or weak-key configuration", async () => {
    const withSession = vi.fn(() => { throw Error("must not read"); });
    const request = { protocolVersion: 1 as const,
      invitationId: "00000000-0000-4000-8000-000000000001", invitationSecret: "ab".repeat(32) };
    for (const env of [
      { CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED: "false", AUDIT_IP_SECRET: "q".repeat(32), OPS_DB: { withSession } },
      { CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED: "true", AUDIT_IP_SECRET: "short", OPS_DB: { withSession } },
    ]) {
      const bridge = Object.assign(Object.create(ClientOnboardingRecipientBridge.prototype), { env }) as
        ClientOnboardingRecipientBridge;
      await expect(bridge.session(request)).resolves.toEqual(unavailableResult());
    }
    expect(withSession).not.toHaveBeenCalled();
    expect(consumeClientOnboardingRateLimit).not.toHaveBeenCalled();
  });

  it("rejects non-exact envelopes before storage or quota access", async () => {
    const withSession = vi.fn(() => { throw Error("must not read"); });
    const bridge = Object.assign(Object.create(ClientOnboardingRecipientBridge.prototype), { env: {
      CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED: "true", AUDIT_IP_SECRET: "q".repeat(32), OPS_DB: { withSession },
    } }) as ClientOnboardingRecipientBridge;
    const valid = { protocolVersion: 1 as const, invitationId: "00000000-0000-4000-8000-000000000001",
      invitationSecret: "ab".repeat(32) };
    vi.mocked(consumeClientOnboardingRateLimit).mockClear();
    await expect(bridge.session({ ...valid, extra: true } as never)).resolves.toEqual(unavailableResult());
    await expect(bridge.session(Object.create(valid) as never)).resolves.toEqual(unavailableResult());
    await expect(bridge.status({ ...valid, submissionId: "not-a-uuid" })).resolves.toEqual(unavailableResult());
    expect(withSession).not.toHaveBeenCalled();
    expect(consumeClientOnboardingRateLimit).not.toHaveBeenCalled();
  });

  it("validates the bearer before consuming a keyed invitation quota", async () => {
    const first = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ state: "pending", expires_at: "2099-01-01T00:00:00.000Z",
        submission_id: null, fields_sha256: null });
    const bridge = Object.assign(Object.create(ClientOnboardingRecipientBridge.prototype), { env: {
      CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED: "true", AUDIT_IP_SECRET: "q".repeat(32),
      OPS_DB: { withSession: () => ({ prepare: () => ({ bind: () => ({ first }) }) }) },
    } }) as ClientOnboardingRecipientBridge;
    const invitationId = "00000000-0000-4000-8000-000000000001";
    const invitationSecret = "ab".repeat(32);
    vi.mocked(consumeClientOnboardingRateLimit).mockClear();
    await expect(bridge.session({ protocolVersion: 1, invitationId, invitationSecret }))
      .resolves.toEqual(unavailableResult());
    expect(consumeClientOnboardingRateLimit).not.toHaveBeenCalled();
    vi.mocked(consumeClientOnboardingRateLimit).mockResolvedValueOnce(true);
    await bridge.session({ protocolVersion: 1, invitationId, invitationSecret });
    expect(consumeClientOnboardingRateLimit).toHaveBeenCalledWith(expect.anything(),
      expect.stringMatching(/^client-onboarding:invitation:[0-9a-f]{64}$/), 20, 60);
    expect(vi.mocked(consumeClientOnboardingRateLimit).mock.calls[0]?.[1]).not.toContain(invitationId);
  });
});

function unavailableResult() {
  return { ok: false, protocolVersion: 1, code: "unavailable" };
}
