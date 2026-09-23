import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { ClientOnboardingRecipientBridge } from "../src/worker/client-onboarding-recipient-entrypoint";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const root = new URL("../../../", import.meta.url);
const config = (name: string) => readFileSync(new URL(name, root), "utf8");

describe("private client onboarding recipient bridge", () => {
  it("is a disabled, unavailable named entrypoint", async () => {
    const bridge = Object.create(ClientOnboardingRecipientBridge.prototype) as ClientOnboardingRecipientBridge;
    await expect(bridge.session({ protocolVersion: 1 })).resolves.toEqual({ ok: false, protocolVersion: 1, code: "unavailable" });
    await expect(bridge.submit({ protocolVersion: 1, invitationId: "opaque", invitationSecret: "opaque", submissionId: "opaque", fields: {} }))
      .resolves.toEqual({ ok: false, protocolVersion: 1, code: "unavailable" });
    await expect(bridge.status({ protocolVersion: 1, submissionId: "opaque" }))
      .resolves.toEqual({ ok: false, protocolVersion: 1, code: "unavailable" });
  });

  it("keeps both deployment gates off and avoids a public Client route", () => {
    expect(config("apps/client/wrangler.jsonc")).toContain('"CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED": "false"');
    expect(config("apps/operations/wrangler.jsonc")).toContain('"CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED": "false"');
    expect(config("apps/client/wrangler.jsonc")).toContain('"entrypoint": "ClientOnboardingRecipientBridge"');
    expect(config("docs/staging/delivery.wrangler.json.example")).toContain('"entrypoint": "ClientOnboardingRecipientBridge"');
    expect(config("docs/staging/operations.wrangler.json.example")).toContain('"CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED": "false"');
    expect(config("apps/client/src/worker/index.ts")).not.toContain("client-onboarding");
    expect(config("apps/operations/src/worker/index.ts")).not.toContain('"/api/client-onboarding/recipient"');
  });
});
