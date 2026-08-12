export const DIRECT_DELIVERY_UPLOADS_DISABLED_CODE = "direct_delivery_uploads_disabled";
export const DIRECT_DELIVERY_UPLOADS_DISABLED_MESSAGE = "Direct delivery uploads are currently disabled";

export interface DirectDeliveryUploadsCapability {
  enabled: boolean;
  reason: "available" | "disabled";
}

export interface DirectDeliveryUploadsPolicyConfig {
  DIRECT_DELIVERY_UPLOADS_ENABLED?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_DELIVERY_UPLOAD_ACCESS_KEY_ID?: string;
  R2_DELIVERY_UPLOAD_SECRET_ACCESS_KEY?: string;
}

export function directDeliveryUploadsCapability(
  config: DirectDeliveryUploadsPolicyConfig,
): DirectDeliveryUploadsCapability {
  if (config.DIRECT_DELIVERY_UPLOADS_ENABLED !== "true") return { enabled: false, reason: "disabled" };
  const configured = /^[a-f0-9]{32}$/i.test(config.R2_ACCOUNT_ID || "") &&
    Boolean(config.R2_BUCKET_NAME && config.R2_DELIVERY_UPLOAD_ACCESS_KEY_ID && config.R2_DELIVERY_UPLOAD_SECRET_ACCESS_KEY);
  return configured ? { enabled: true, reason: "available" } : { enabled: false, reason: "disabled" };
}
