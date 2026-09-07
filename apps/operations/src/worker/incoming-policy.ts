
export interface IncomingUploadsCapability {
  enabled: boolean;
  reason: "available" | "disabled";
  missing?: string[];
}

export type IncomingUploadsPolicyConfig = Partial<{
  DELIVERY_DB: unknown;
  INCOMING_BUCKET: unknown;
  INCOMING_BASE_URL: string;
  INCOMING_EXPECTED_HOST: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET: string;
  INCOMING_SESSION_SECRET: string;
  INCOMING_ACCESS_CODE_PEPPER: string;
  INCOMING_PICKUP_SECRET: string;
  R2_ACCOUNT_ID: string;
  R2_INCOMING_BUCKET_NAME: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  INCOMING_LIFECYCLE_WORKFLOW: unknown;
}>;

export type IncomingPublicRequestDecision = "enabled" | "disabled" | "health" | "internal-completion";

const REQUIRED: ReadonlyArray<keyof IncomingUploadsPolicyConfig> = [
  "DELIVERY_DB",
  "INCOMING_BUCKET",
  "INCOMING_BASE_URL",
  "INCOMING_EXPECTED_HOST",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET",
  "INCOMING_SESSION_SECRET",
  "INCOMING_ACCESS_CODE_PEPPER",
  "INCOMING_PICKUP_SECRET",
  "R2_ACCOUNT_ID",
  "R2_INCOMING_BUCKET_NAME",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "INCOMING_LIFECYCLE_WORKFLOW",
];

export function incomingUploadsCapability(config: IncomingUploadsPolicyConfig): IncomingUploadsCapability {
  const missing = REQUIRED.filter((key) => {
    const value = config[key];
    return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
  });
  return missing.length
    ? { enabled: false, reason: "disabled", missing: missing.map(String) }
    : { enabled: true, reason: "available" };
}

export function incomingPublicRequestDecision(
  config: IncomingUploadsPolicyConfig,
  method: string,
  pathname: string,
): IncomingPublicRequestDecision {
  if (method.toUpperCase() === "GET" && pathname === "/health") {
    return "health";
  }
  if (method.toUpperCase() === "POST"
    && /^\/api\/internal\/uploads\/[^/]+\/(?:accepted|pickup-status)$/.test(pathname)) {
    return "internal-completion";
  }
  return incomingUploadsCapability(config).enabled ? "enabled" : "disabled";
}
