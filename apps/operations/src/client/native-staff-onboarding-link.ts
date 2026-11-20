export const NATIVE_STAFF_ONBOARDING_PATH = "/staff/onboarding";
export type NativeStaffInvitation = Readonly<{ onboardingId: string; invitationSecret: string }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;

/** Invitation secrets travel only in a fragment, never a query or redirect URL. */
export function parseNativeStaffInvitation(hash: string): NativeStaffInvitation | null {
  if (!hash.startsWith("#") || hash.length > 256) return null;
  const params = new URLSearchParams(hash.slice(1));
  if ([...params.keys()].length !== 2 || params.getAll("onboardingId").length !== 1 || params.getAll("invitationSecret").length !== 1) return null;
  const onboardingId = params.get("onboardingId")!, invitationSecret = params.get("invitationSecret")!;
  return UUID.test(onboardingId) && HEX.test(invitationSecret) ? Object.freeze({ onboardingId, invitationSecret }) : null;
}

export function nativeStaffInvitationUrl(origin: string, invitation: NativeStaffInvitation): string {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || url.port
    || !UUID.test(invitation.onboardingId) || !HEX.test(invitation.invitationSecret)) throw new Error("Invalid invitation link");
  url.pathname = NATIVE_STAFF_ONBOARDING_PATH;
  url.hash = new URLSearchParams(invitation).toString();
  return url.href;
}
