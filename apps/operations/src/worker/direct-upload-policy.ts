export const DIRECT_DELIVERY_UPLOADS_DISABLED_CODE = "direct_delivery_uploads_disabled";
export const DIRECT_DELIVERY_UPLOADS_DISABLED_MESSAGE = "Direct delivery uploads are currently disabled";

export interface DirectDeliveryUploadsCapability {
  enabled: boolean;
  reason: "available" | "disabled";
}

export interface DirectDeliveryUploadsPolicyConfig {
  DIRECT_DELIVERY_UPLOADS_ENABLED?: string;
}

export function directDeliveryUploadsCapability(
  config: DirectDeliveryUploadsPolicyConfig,
): DirectDeliveryUploadsCapability {
  return config.DIRECT_DELIVERY_UPLOADS_ENABLED === "true"
    ? { enabled: true, reason: "available" }
    : { enabled: false, reason: "disabled" };
}
