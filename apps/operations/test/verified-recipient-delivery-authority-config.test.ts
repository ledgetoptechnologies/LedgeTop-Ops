import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const binding = { binding: "VERIFIED_RECIPIENT_DELIVERY_AUTHORITY", service: "ledgetop-clients-staging",
  entrypoint: "VerifiedRecipientDeliveryAuthorityIngress" };

describe("verified recipient delivery authority private wiring", () => {
  it("is false in every checked config and absent from production bindings", () => {
    const client = [read("../../client/wrangler.jsonc"), read("../../client/wrangler.staging.json"),
      read("../../client/wrangler.staging.recipient-enrollment.json")];
    for (const config of client) {
      expect(config.vars.CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_WRITER_ENABLED).toBe("false");
      expect(config.vars.CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_STATUS_ENABLED).toBe("false");
    }
    const production = read("../wrangler.jsonc");
    expect(production.vars.VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_DISPATCH_ENABLED).toBe("false");
    expect(production.services ?? []).not.toContainEqual(binding);
  });

  it("declares only the exact private staging binding while remaining disabled", () => {
    for (const config of [read("../wrangler.staging.json"), read("../wrangler.staging.recipient-enrollment.json")]) {
      expect(config.vars.VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_DISPATCH_ENABLED).toBe("false");
      expect(config.services).toContainEqual(binding);
    }
  });
});
