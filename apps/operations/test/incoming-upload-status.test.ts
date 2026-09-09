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
});
