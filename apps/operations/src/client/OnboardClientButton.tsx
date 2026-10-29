import { useEffect, useState } from "react";
import { endpoint, json, validSession } from "./onboarding-staff-api";

export const CLIENT_ONBOARDING_PATH = "/administration/client-onboarding";

/** True only when the onboarding page would open for this person: the same read-only
 * session check that page starts with. A disabled capability, a refusal or a failure hides it. */
export function useClientOnboardingAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void json(`${endpoint}/session`, { method: "GET", signal: controller.signal, headers: { "X-Native-Staff-Request": "1" } })
      .then(value => { if (!controller.signal.aborted) setAvailable(validSession(value)); })
      .catch(() => { if (!controller.signal.aborted) setAvailable(false); });
    return () => controller.abort();
  }, []);
  return available;
}

/** One obvious way in to onboarding a new client: invite them, then review what they send. */
export function OnboardClientButton({ className = "button button-orange" }: { className?: string }) {
  return useClientOnboardingAvailable() ? <a className={className} href={CLIENT_ONBOARDING_PATH}>Onboard client</a> : null;
}
