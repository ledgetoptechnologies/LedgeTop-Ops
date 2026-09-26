import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { ClientOnboardingRecipientBridge } from "../src/worker/client-onboarding-recipient-entrypoint";
import { consumeClientOnboardingRateLimit } from "../src/worker/client-onboarding-rate-limit";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
vi.mock("../src/worker/client-onboarding-rate-limit", () => ({ consumeClientOnboardingRateLimit: vi.fn().mockResolvedValue(true) }));

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

  it("uses separate invitation counters for read and submit while sharing the read counter with status", async () => {
    const bridge = Object.assign(Object.create(ClientOnboardingRecipientBridge.prototype), {
      env: { CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED: "true", OPS_DB: {} },
    }) as ClientOnboardingRecipientBridge;
    const invitationId = "00000000-0000-4000-8000-000000000001";
    const invitationSecret = "ab".repeat(32);
    const submissionId = "00000000-0000-4000-8000-000000000002";
    vi.mocked(consumeClientOnboardingRateLimit).mockClear();
    await bridge.session({ protocolVersion: 1, invitationId, invitationSecret });
    await bridge.status({ protocolVersion: 1, invitationId, invitationSecret, submissionId });
    await bridge.submit({ protocolVersion: 1, invitationId, invitationSecret, submissionId, fields: {} });
    const calls = vi.mocked(consumeClientOnboardingRateLimit).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0]?.[1]).toBe(calls[1]?.[1]);
    expect(calls[0]?.[1]).not.toBe(calls[2]?.[1]);
    expect(calls.map(call => call[2])).toEqual([20, 20, 8]);
  });
});
