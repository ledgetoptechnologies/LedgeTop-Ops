export interface IncomingStatusFacts {
  status?: string;
  pickupState?: string;
  verificationState?: "awaiting_verification" | "scanning" | "verified" | "retry" | "rejected" | "server_only";
  /** Server-supplied publication facts, never an inferred rclone receipt. */
  promotion?: {
    state: "pending" | "copying" | "publishing" | "ready" | "unavailable" | "failed";
    objectAvailability?: "present" | "missing" | "changed";
  } | null;
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
  if (upload.status === "expired") return {
    label: "Expired",
    detail: "The temporary upload retention period ended. This is not confirmation that the server downloaded it.",
  };
  if (upload.status === "quarantined" && upload.verificationState !== "rejected" && upload.promotion) {
    const promotion = upload.promotion;
    if (promotion.state === "ready") {
      if (promotion.objectAvailability === "missing") return {
        label: "No longer in R2",
        detail: "The published file is no longer available in the bucket. Check the TrueNAS task and local destination; Operations has no server download receipt.",
      };
      if (promotion.objectAvailability === "changed") return {
        label: "Published file needs review",
        detail: "The bucket object no longer matches the published upload. It is not available to download here.",
      };
      return {
        label: promotion.objectAvailability === "present" ? "Ready for server pickup" : "Published for server pickup",
        detail: "Basic upload checks passed, not an antivirus scan. TrueNAS collects published files on its hourly schedule; current availability is checked when you open this record.",
      };
    }
    if (promotion.state === "publishing") return {
      label: "Publication needs confirmation",
      detail: "Publication was started but its outcome is not confirmed. Operations will not create another copy automatically; check the bucket and TrueNAS destination.",
    };
    if (promotion.state === "pending" || promotion.state === "copying") return {
      label: promotion.state === "pending" ? "Preparing server pickup" : "Preparing pickup files",
      detail: "Basic upload checks passed. Operations is preparing the file for the hourly TrueNAS task; no separate server verifier is required.",
    };
    return {
      label: "Pickup preparation needs attention",
      detail: "The file could not be published for pickup. Check its current availability and recorded reason; this is not a malware verdict or a server download confirmation.",
    };
  }
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
