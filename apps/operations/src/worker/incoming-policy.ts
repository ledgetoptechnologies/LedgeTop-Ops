
export interface IncomingUploadsCapability {
  enabled: boolean;
  reason: "available" | "disabled";
}

export type IncomingUploadsPolicyConfig = object;

export type IncomingPublicRequestDecision = "enabled" | "health" | "internal-completion";

export function incomingUploadsCapability(_config: IncomingUploadsPolicyConfig): IncomingUploadsCapability {
  return { enabled: true, reason: "available" };
}

export function incomingPublicRequestDecision(
  _config: IncomingUploadsPolicyConfig,
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
  return "enabled";
}
