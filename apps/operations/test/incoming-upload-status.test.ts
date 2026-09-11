import { describe, expect, it } from "vitest";
import { incomingUploadStatus } from "../src/client/incoming-upload-status";

describe("independent Incoming verification and pickup labels", () => {
  it.each([
    ["awaiting_verification", "Awaiting verification"],
    ["scanning", "Verifying upload"],
    ["verified", "Verified · awaiting server pickup"],
    ["retry", "Verification will retry"],
    ["rejected", "Verification needs review"],
  ] as const)("describes %s independently", (verificationState, label) => {
    expect(incomingUploadStatus({ status: "quarantined", pickupState: "awaiting_pickup", verificationState }).label).toBe(label);
  });
  it("keeps verified pickup progress distinct from scanning", () => {
    expect(incomingUploadStatus({ status: "quarantined", verificationState: "verified", pickupState: "scanning" }).label).toBe("Server pickup in progress");
    expect(incomingUploadStatus({ status: "quarantined", verificationState: "verified", pickupState: "retry" }).label).toBe("Server pickup will retry");
  });
  it("does not let stale verification metadata override terminal upload state", () => {
    expect(incomingUploadStatus({ status: "accepted", verificationState: "scanning" }).label).toBe("Accepted by server");
    expect(incomingUploadStatus({ status: "rejected", verificationState: "verified" }).label).toBe("Rejected");
    expect(incomingUploadStatus({ status: "uploading", verificationState: "verified" }).label).toBe("uploading");
  });
  it("preserves old deployment labels without inventing verification", () => {
    expect(incomingUploadStatus({ status: "quarantined" }).label).toBe("Awaiting server pickup");
    expect(incomingUploadStatus({ status: "quarantined", pickupState: "scanning" }).label).toBe("Server verification in progress");
    expect(incomingUploadStatus({ status: "quarantined", pickupState: "retry" }).detail).toContain("does not mean malware");
  });
  it("distinguishes basic-check publication from scanner results", () => {
    const result = incomingUploadStatus({ status: "quarantined", verificationState: "awaiting_verification", promotion: { state: "ready", objectAvailability: "present" } });
    expect(result.label).toBe("Ready for server pickup");
    expect(result.detail).toContain("not an antivirus scan");
    expect(incomingUploadStatus({ status: "quarantined", promotion: { state: "ready" } }).label).toBe("Published for server pickup");
  });
  it("does not infer basic checks from a queued promotion intent", () => {
    for (const state of ["pending", "copying"] as const) {
      const result = incomingUploadStatus({ status: "quarantined", verificationState: "awaiting_verification", promotion: { state } });
      expect(result.label).toBe(state === "pending" ? "Server pickup preparation queued" : "Preparing pickup files");
      expect(result.detail).toContain("not confirmed");
      expect(result.detail).not.toContain("Basic upload checks passed");
    }
  });
  it("does not equate a missing object or uncertain publication with local delivery", () => {
    const missing = incomingUploadStatus({ status: "quarantined", promotion: { state: "ready", objectAvailability: "missing" } });
    expect(missing.label).toBe("No longer in R2");
    expect(missing.detail).toContain("no server download receipt");
    expect(incomingUploadStatus({ status: "quarantined", promotion: { state: "publishing" } }).label).toBe("Publication needs confirmation");
    expect(incomingUploadStatus({ status: "quarantined", promotion: { state: "ready", objectAvailability: "changed" } }).label).toBe("Published file needs review");
  });
  it("never allows publication metadata to override rejection or expiry", () => {
    for (const status of ["rejected", "expired"] as const) {
      expect(incomingUploadStatus({ status, promotion: { state: "ready", objectAvailability: "present" } }).label).toBe(status === "rejected" ? "Rejected" : "Expired");
    }
    expect(incomingUploadStatus({ status: "quarantined", verificationState: "rejected", promotion: { state: "ready" } }).label).toBe("Verification needs review");
  });
});
