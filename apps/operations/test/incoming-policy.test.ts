import { describe, expect, it } from "vitest";
import {
  INCOMING_UPLOADS_DISABLED_CODE,
  INCOMING_UPLOADS_DISABLED_MESSAGE,
  incomingPublicRequestDecision,
  incomingUploadsCapability,
} from "../src/worker/incoming-policy";

describe("incoming upload capability policy", () => {
  it("is disabled by default and requires the exact true value", () => {
    expect(incomingUploadsCapability({})).toEqual({ enabled: false, reason: "disabled" });
    expect(incomingUploadsCapability({ INCOMING_UPLOADS_ENABLED: "false" })).toEqual({
      enabled: false,
      reason: "disabled",
    });
    expect(incomingUploadsCapability({ INCOMING_UPLOADS_ENABLED: "TRUE" })).toEqual({
      enabled: false,
      reason: "disabled",
    });
    expect(incomingUploadsCapability({ INCOMING_UPLOADS_ENABLED: "1" })).toEqual({
      enabled: false,
      reason: "disabled",
    });
    expect(incomingUploadsCapability({ INCOMING_UPLOADS_ENABLED: "true" })).toEqual({
      enabled: true,
      reason: "available",
    });
  });

  it("keeps every contributor route disabled while the capability is off", () => {
    expect(incomingPublicRequestDecision({}, "GET", "/r/request-id")).toBe("disabled");
    expect(incomingPublicRequestDecision({}, "POST", "/api/public/requests/request-id/authorize")).toBe("disabled");
    expect(incomingPublicRequestDecision({}, "POST", "/api/public/requests/request-id/files/init")).toBe("disabled");
  });

  it("exempts only the exact internal TrueNAS completion callback", () => {
    expect(incomingPublicRequestDecision({}, "POST", "/api/internal/uploads/upload-id/accepted"))
      .toBe("internal-completion");
    expect(incomingPublicRequestDecision({}, "GET", "/api/internal/uploads/upload-id/accepted")).toBe("disabled");
    expect(incomingPublicRequestDecision({}, "POST", "/api/internal/uploads/upload-id/accepted/extra")).toBe("disabled");
    expect(incomingPublicRequestDecision({}, "POST", "/api/internal/uploads//accepted")).toBe("disabled");
  });

  it("publishes a stable, clear disabled response contract", () => {
    expect(INCOMING_UPLOADS_DISABLED_CODE).toBe("incoming_uploads_disabled");
    expect(INCOMING_UPLOADS_DISABLED_MESSAGE).toBe("Incoming uploads are currently disabled");
  });
});
