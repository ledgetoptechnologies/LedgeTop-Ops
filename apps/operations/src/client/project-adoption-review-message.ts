type ProjectAdoptionReviewBlockedReason = "configuration" | "destination" | "authority" | "local_state" |
  "directory" | "relationship" | "remote" | "stale_evidence";

const BLOCKED_REASON_MESSAGES: Record<ProjectAdoptionReviewBlockedReason, string> = {
  configuration: "The selected Project Alpha connection is not configured for this review.",
  destination: "The Operations Project destination is already reserved or does not match the configured Project Alpha connection.",
  authority: "Your current Operations authority does not permit this exact Project adoption.",
  local_state: "The Operations Project destination is no longer unused and available for adoption.",
  directory: "The Project's linked organization or client directory identity is missing or changed.",
  relationship: "The Project's organization and client relationship is not valid for adoption.",
  remote: "Project Alpha evidence could not be validated safely.",
  stale_evidence: "Review evidence expired or identity/state changed; inspect the existing destination before creating a new review.",
};

export function projectAdoptionReviewFailureMessage(status: unknown, reason: unknown): string {
  if (status === "uncertain")
    return "Project adoption review outcome is uncertain. The same frozen request key is retained; retry only after operator review.";
  if (status === "blocked" && typeof reason === "string" && Object.hasOwn(BLOCKED_REASON_MESSAGES, reason))
    return `Project adoption review was blocked. ${BLOCKED_REASON_MESSAGES[reason as ProjectAdoptionReviewBlockedReason]} Reset only after reviewing server state; do not submit a replacement request.`;
  return "Project adoption review was not completed. Reset only after reviewing server state; do not submit a replacement request.";
}
