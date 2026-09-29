const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET = /^[0-9a-f]{64}$/;

/** Reads a first-use fragment secret and removes it before React or any network request starts. */
export function consumeClientOnboardingRecipientRoute(
  location: Pick<Location, "pathname" | "search" | "hash">,
  history: Pick<History, "state" | "replaceState">,
): { invitationId: string; invitationSecret: string } | null {
  const match = /^\/onboarding\/([^/]+)$/.exec(location.pathname);
  if (!match) return null;
  let invitationId = "";
  let invitationSecret = "";
  try { invitationId = decodeURIComponent(match[1]!); invitationSecret = decodeURIComponent(location.hash.slice(1)); } catch { /* invalid */ }
  if (location.hash) history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  return { invitationId: UUID.test(invitationId) ? invitationId : "", invitationSecret: SECRET.test(invitationSecret) ? invitationSecret : "" };
}
