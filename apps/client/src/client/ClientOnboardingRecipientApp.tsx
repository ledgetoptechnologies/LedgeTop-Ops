import { useEffect, useRef, useState } from "react";
import { ClientProfileOnboardingForm, type ClientProfileOnboardingValues } from "@ltds/ui/client-profile-onboarding";

type State = "opening" | "ready" | "submitting" | "uncertain" | "submitted" | "unavailable";
const fields = (value: ClientProfileOnboardingValues) => ({ clientType: value.profileType === "organization" ? "business" : "consumer",
  name: value.contactName, email: value.email, phone: value.phone, organizationName: value.organizationName,
  organizationEmail: value.generalEmail, organizationPhone: value.generalPhone, addressLine1: value.addressLine1,
  addressLine2: value.addressLine2, city: value.city, state: value.region, postalCode: value.postalCode, country: value.country });
async function post(path: string, value: object): Promise<{ state?: string }> {
  const response = await fetch(path, { method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  if (!response.ok) throw new Error(response.status >= 500 ? "uncertain" : "unavailable");
  return response.json() as Promise<{ state?: string }>;
}
export function ClientOnboardingRecipientApp({ invitationId, invitationSecret }: { invitationId: string; invitationSecret: string }) {
  const [state, setState] = useState<State>(invitationSecret ? "opening" : "unavailable");
  const submission = useRef<{ submissionId: string; fields: ReturnType<typeof fields> } | null>(null);
  const base = `/api/client-onboarding/${encodeURIComponent(invitationId)}`;
  useEffect(() => { if (invitationSecret) void post(`${base}/session`, { invitationSecret })
    .then(result => setState(result.state === "submitted" ? "submitted" : "ready"), () => setState("unavailable")); }, [base, invitationSecret]);
  const recover = async () => {
    if (!submission.current) return;
    setState("submitting");
    try {
      const result = await post(`${base}/status`, { invitationSecret, submissionId: submission.current.submissionId });
      if (result.state !== "submitted") await post(`${base}/submit`, { invitationSecret, ...submission.current });
      setState("submitted");
    } catch (error) { setState(error instanceof Error && error.message === "unavailable" ? "unavailable" : "uncertain"); }
  };
  const submit = (value: ClientProfileOnboardingValues) => {
    if (submission.current || state !== "ready") return;
    submission.current = { submissionId: crypto.randomUUID(), fields: fields(value) };
    void recover();
  };
  if (state === "opening") return <main className="portal-loading-shell" aria-busy="true" aria-label="Opening invitation" />;
  if (state === "submitted") return <main className="client-profile-onboarding"><div className="client-profile-onboarding-card"><h1>Information submitted</h1><p>Your details were received for review. You may close this page.</p></div></main>;
  if (state === "unavailable") return <main className="client-profile-onboarding"><div className="client-profile-onboarding-card"><h1>Invitation unavailable</h1><p>This invitation is invalid, expired, or no longer available.</p></div></main>;
  if (state === "uncertain") return <main className="client-profile-onboarding"><div className="client-profile-onboarding-card"><p role="alert">We could not confirm whether your submission was received.</p><button className="button-orange" onClick={() => void recover()}>Check submission</button></div></main>;
  return <main><ClientProfileOnboardingForm onSubmit={submit} submitLabel={state === "submitting" ? "Submitting…" : "Submit for Review"} /></main>;
}
