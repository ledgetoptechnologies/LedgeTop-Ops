import { describe, expect, it } from "vitest";
import { projectAlphaAccessTokenExpiryDiagnostic } from "../src/worker/project-alpha-access-token-expiry";
import type { Env } from "../src/worker/types";

const NOW = Date.parse("2026-09-08T12:00:00Z");
function report(values: Partial<Env> = {}) {
  return projectAlphaAccessTokenExpiryDiagnostic(values as Env, NOW);
}

describe("Project Alpha Access service-token expiry diagnostic", () => {
  it("reports only the non-secret LTDS/LTT expiration state", () => {
    const value = report({
      PROJECT_ALPHA_LTDS_ACCESS_SERVICE_TOKEN_EXPIRES_AT: "2036-07-14T00:00:00Z",
      PROJECT_ALPHA_LTT_ACCESS_SERVICE_TOKEN_EXPIRES_AT: "2026-10-01T00:00:00Z",
      PROJECT_ALPHA_API_KEY: "must-not-appear",
      PROJECT_ALPHA_CONNECTOR_CREDENTIALS: JSON.stringify({ token: "must-not-appear" }),
    });
    expect(value).toEqual({ generatedAt: "2026-09-08T12:00:00.000Z", healthy: false, connectors: [
      { connector: "ltds", label: "Ledge Top Drone Services", state: "healthy", expiresAt: "2036-07-14T00:00:00.000Z", daysRemaining: 3596 },
      { connector: "ltt", label: "Ledge Top Technologies", state: "expires_soon", expiresAt: "2026-10-01T00:00:00.000Z", daysRemaining: 22 },
    ] });
    expect(JSON.stringify(value)).not.toContain("must-not-appear");
  });

  it("uses conservative state for absent, malformed, expired and annual-renewal timestamps", () => {
    const value = report({
      PROJECT_ALPHA_LTDS_ACCESS_SERVICE_TOKEN_EXPIRES_AT: "2027-08-01T00:00:00Z",
      PROJECT_ALPHA_LTT_ACCESS_SERVICE_TOKEN_EXPIRES_AT: "not-a-date",
    });
    expect(value.connectors.map(item => [item.connector, item.state, item.expiresAt, item.daysRemaining])).toEqual([
      ["ltds", "renewal_due", "2027-08-01T00:00:00.000Z", 326],
      ["ltt", "invalid", null, null],
    ]);
    expect(report().connectors.every(item => item.state === "unconfigured")).toBe(true);
    expect(report({ PROJECT_ALPHA_LTDS_ACCESS_SERVICE_TOKEN_EXPIRES_AT: "2026-09-07T23:59:59Z" }).connectors[0]!.state).toBe("expired");
  });
});
