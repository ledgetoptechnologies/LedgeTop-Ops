export const INCOMING_UPLOADS_DISABLED_CODE = "incoming_uploads_disabled";
export const INCOMING_UPLOADS_DISABLED_MESSAGE = "Incoming uploads are currently disabled";

export interface IncomingUploadsCapability {
  enabled: boolean;
  reason: "available" | "disabled";
}

export interface IncomingUploadsPolicyConfig {
  INCOMING_UPLOADS_ENABLED?: string;
}

export type IncomingPublicRequestDecision = "enabled" | "disabled" | "health" | "internal-completion";

export function incomingUploadsCapability(config: IncomingUploadsPolicyConfig): IncomingUploadsCapability {
  return config.INCOMING_UPLOADS_ENABLED === "true"
    ? { enabled: true, reason: "available" }
    : { enabled: false, reason: "disabled" };
}

export function incomingPublicRequestDecision(
  config: IncomingUploadsPolicyConfig,
  method: string,
  pathname: string,
): IncomingPublicRequestDecision {
  if (method.toUpperCase() === "GET" && pathname === "/health") {
    return "health";
  }
  if (
    method.toUpperCase() === "POST"
    && /^\/api\/internal\/uploads\/[^/]+\/accepted$/.test(pathname)
  ) {
    return "internal-completion";
  }
  return incomingUploadsCapability(config).enabled ? "enabled" : "disabled";
}
