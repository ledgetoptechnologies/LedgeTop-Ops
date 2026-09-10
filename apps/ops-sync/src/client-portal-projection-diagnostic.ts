type ProjectionKind = "portal" | "catalog" | "service_assignments";
type FailurePhase = "transport" | "receiver";

const RECEIVER_CODES = new Set([
  "invalid",
  "disabled",
  "source-mismatch",
  "source-unavailable",
  "delivery-mismatch",
  "temporarily-unavailable",
  "rejected",
]);

/**
 * Produces the bounded observability record for an already authenticated
 * portal-projection handoff. Runtime exceptions, response bodies, and unknown
 * receiver codes are deliberately not represented here.
 */
export function clientPortalProjectionFailureDiagnostic(input: {
  projectionKind: ProjectionKind;
  sourceId: string;
  eventId: string;
  phase: FailurePhase;
  receiverCode?: unknown;
  retryable: boolean;
}): Record<string, string | boolean> {
  return {
    event: "ops_sync_client_portal_projection_failed",
    projectionKind: input.projectionKind,
    sourceId: input.sourceId,
    eventId: input.eventId,
    phase: input.phase,
    receiverCode: typeof input.receiverCode === "string" && RECEIVER_CODES.has(input.receiverCode)
      ? input.receiverCode : "unknown",
    retryable: input.retryable === true,
  };
}
