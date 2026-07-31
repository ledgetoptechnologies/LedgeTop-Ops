import { describe, expect, it } from "vitest";
import {
  incomingPublicRequestDecision,
  incomingUploadsCapability,
} from "../src/worker/incoming-policy";

describe("incoming upload capability policy", () => {
  it("keeps the quarantined incoming workflow available", () => {
    expect(incomingUploadsCapability({})).toEqual({ enabled: true, reason: "available" });
  });

  it("keeps the request form and its protected upload API available", () => {
    expect(incomingPublicRequestDecision({}, "GET", "/r/request-id")).toBe("enabled");
    expect(incomingPublicRequestDecision({}, "POST", "/api/public/requests/request-id/authorize")).toBe("enabled");
    expect(incomingPublicRequestDecision({}, "POST", "/api/public/requests/request-id/files/init")).toBe("enabled");
  });

  it("exempts only the exact internal TrueNAS completion callback", () => {
    expect(incomingPublicRequestDecision({}, "POST", "/api/internal/uploads/upload-id/accepted"))
      .toBe("internal-completion");
  });

  it("identifies the exact read-only health endpoint", () => {
    expect(incomingPublicRequestDecision({}, "GET", "/health")).toBe("health");
  });
});
