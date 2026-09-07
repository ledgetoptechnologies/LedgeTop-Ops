import { describe, expect, it } from "vitest";
import {
  incomingPublicRequestDecision,
  incomingUploadsCapability,
} from "../src/worker/incoming-policy";

describe("incoming upload capability policy", () => {
  const configured = {
    DELIVERY_DB: {}, INCOMING_BUCKET: {}, INCOMING_BASE_URL: "https://incoming.test",
    INCOMING_EXPECTED_HOST: "incoming.test", TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET: "secret",
    INCOMING_SESSION_SECRET: "session", INCOMING_ACCESS_CODE_PEPPER: "pepper", INCOMING_PICKUP_SECRET: "pickup",
    R2_ACCOUNT_ID: "account", R2_INCOMING_BUCKET_NAME: "bucket", R2_ACCESS_KEY_ID: "access",
    R2_SECRET_ACCESS_KEY: "secret", INCOMING_LIFECYCLE_WORKFLOW: {},
  };

  it("keeps the quarantined incoming workflow available", () => {
    expect(incomingUploadsCapability(configured)).toEqual({ enabled: true, reason: "available" });
  });

  it("fails closed and reports missing prerequisites", () => {
    expect(incomingUploadsCapability({ INCOMING_BASE_URL: "https://incoming.test" })).toMatchObject({
      enabled: false,
      reason: "disabled",
      missing: expect.arrayContaining(["DELIVERY_DB", "INCOMING_BUCKET", "TURNSTILE_SECRET", "R2_ACCESS_KEY_ID"]),
    });
  });

  it("keeps the request form and its protected upload API available", () => {
    expect(incomingPublicRequestDecision(configured, "GET", "/r/request-id")).toBe("enabled");
    expect(incomingPublicRequestDecision(configured, "POST", "/api/public/requests/request-id/authorize")).toBe("enabled");
    expect(incomingPublicRequestDecision(configured, "POST", "/api/public/requests/request-id/files/init")).toBe("enabled");
    expect(incomingPublicRequestDecision({}, "GET", "/r/request-id")).toBe("disabled");
  });

  it("exempts only exact authenticated TrueNAS pickup callbacks", () => {
    expect(incomingPublicRequestDecision({}, "POST", "/api/internal/uploads/upload-id/accepted"))
      .toBe("internal-completion");
    expect(incomingPublicRequestDecision({}, "POST", "/api/internal/uploads/upload-id/pickup-status"))
      .toBe("internal-completion");
    expect(incomingPublicRequestDecision({}, "GET", "/api/internal/uploads/upload-id/pickup-status"))
      .toBe("disabled");
    expect(incomingPublicRequestDecision({}, "POST", "/api/internal/uploads/upload-id/object"))
      .toBe("disabled");
  });

  it("identifies the exact read-only health endpoint", () => {
    expect(incomingPublicRequestDecision({}, "GET", "/health")).toBe("health");
  });
});
