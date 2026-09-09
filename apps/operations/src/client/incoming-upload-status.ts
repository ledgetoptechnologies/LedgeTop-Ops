export interface IncomingStatusFacts {
  status?: string;
  pickupState?: string;
  verificationState?: "awaiting_verification" | "scanning" | "verified" | "retry" | "rejected" | "server_only";
}

/** Display facts only; download authority must be checked by the server. */
export function incomingUploadStatus(upload: IncomingStatusFacts) {
  if (upload.status === "accepted") return {
    label: "Accepted by server",
    detail: "The server verified and promoted this upload. Its temporary quarantined object has been removed.",
  };
  if (upload.status === "rejected") return {
    label: "Rejected",
    detail: "The upload did not pass the initial validation checks. Review the recorded reason if one is available.",
  };
  if (upload.status === "quarantined" && upload.verificationState) {
    if (upload.verificationState === "verified") return {
      label: upload.pickupState === "scanning" ? "Server pickup in progress"
        : upload.pickupState === "retry" ? "Server pickup will retry" : "Verified · awaiting server pickup",
      detail: "Verification passed for this upload. Server pickup is a separate step; current file availability is checked when you open its record.",
    };
    if (upload.verificationState === "scanning") return {
      label: "Verifying upload",
      detail: "The private verifier is checking this upload. It is not available to open until verification passes.",
    };
    if (upload.verificationState === "retry") return {
      label: "Verification will retry",
      detail: "Verification did not complete. The upload remains private while another attempt is scheduled; this does not mean malware was detected.",
    };
    if (upload.verificationState === "rejected") return {
      label: "Verification needs review",
      detail: "The verifier did not approve this upload. It remains private and is not available to open or collect.",
    };
    return {
      label: "Awaiting verification",
      detail: "The upload was received and is waiting for the private verifier. Verification and hourly server pickup are separate steps.",
    };
  }
  // Older deployments do not report independent verification yet.
  if (upload.status === "quarantined" && upload.pickupState === "scanning") return {
    label: "Server verification in progress",
    detail: "The server is picking up and scanning this private upload. It cannot be opened or downloaded here.",
  };
  if (upload.status === "quarantined" && upload.pickupState === "retry") return {
    label: "Server pickup will retry",
    detail: "The last private pickup attempt did not complete. The server will retry on its scheduled run; the file remains quarantined. This does not mean malware was detected.",
  };
  if (upload.status === "quarantined") return {
    label: "Awaiting server pickup",
    detail: "Upload completed and remains private until the server picks it up, checks integrity, and scans it. This status does not mean malware was detected.",
  };
  return { label: upload.status?.replaceAll("_", " ") || "Uploaded", detail: null };
}
