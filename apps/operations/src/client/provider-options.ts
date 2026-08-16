import type { ViewerProviderCapabilities } from "@ltds/shared";

// NodeODM 2.2.3 reports option defaults as strings even when its type says
// int/float/bool. Sending those untouched values makes the Viewer validator
// reject an otherwise untouched form, so defaults remain provider-owned and
// the browser sends explicit overrides only.
export function defaultViewerProviderOverrides(_capabilities: ViewerProviderCapabilities | null): Record<string, never> {
  return {};
}
