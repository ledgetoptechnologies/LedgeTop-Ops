import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const binding = { binding: "VERIFIED_RECIPIENT_DELIVERY_AUTHORITY", service: "ledgetop-clients-staging",
  entrypoint: "VerifiedRecipientDeliveryAuthorityIngress" };

describe("verified recipient delivery authority private wiring", () => {
  // Private generated staging files are intentionally ignored and absent in CI.
  // Check the committed templates here; the real generator's fixture suite below
  // checks the generated enrollment window without importing private artifacts.
  it("is false in committed production and staging templates and absent from production bindings", () => {
    const client = [read("../../client/wrangler.jsonc"),
      read("../../../docs/staging/delivery.wrangler.json.example")];
    for (const config of client) {
      expect(config.vars.CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_WRITER_ENABLED).toBe("false");
      expect(config.vars.CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_STATUS_ENABLED).toBe("false");
    }
    const production = read("../wrangler.jsonc");
    expect(production.vars.VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_DISPATCH_ENABLED).toBe("false");
    expect((production.services ?? []).filter((service: { binding: string }) => service.binding === binding.binding)).toEqual([]);
  });

  it("declares only the exact private staging binding while remaining disabled", () => {
    for (const config of [read("../../../docs/staging/operations.wrangler.json.example")]) {
      expect(config.vars.VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_DISPATCH_ENABLED).toBe("false");
      expect(config.vars.ENVIRONMENT).toBe("staging");
      expect(config.vars.EXPECTED_HOST).toBe("ops-staging.ledgetopdroneservices.com");
      expect(config.services.filter((service: { binding: string }) => service.binding === binding.binding)).toEqual([binding]);
    }
  });

  it("checks the real enrollment generator using isolated non-secret fixtures", () => {
    const output = execFileSync(process.execPath, ["--test", fileURLToPath(new URL(
      "../../../scripts/staging-recipient-enrollment-config.test.mjs", import.meta.url))],
      { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
    expect(output).toMatch(/(?:#|ℹ) fail 0/);
  }, 65_000);
});
