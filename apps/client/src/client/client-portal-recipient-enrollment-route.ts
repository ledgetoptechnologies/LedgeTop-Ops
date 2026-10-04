const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{64}$/;

/**
 * Consumes the one-time portal enrollment token before React or any request
 * starts. The token is returned only in memory and is never accepted from a
 * query parameter.
 */
export function consumeClientPortalRecipientEnrollmentRoute(
  location: Pick<Location, "pathname" | "search" | "hash">,
  history: Pick<History, "state" | "replaceState">,
): { intentId: string; opaqueToken: string } | null {
  const match = /^\/portal\/recipient-enrollment\/([^/]+)$/.exec(location.pathname);
  if (!match) return null;
  // Snapshot before replaceState mutates a real Location object.
  const hasQuery = Boolean(location.search);
  const hash = location.hash;
  let intentId = "";
  let opaqueToken = "";
  try {
    intentId = decodeURIComponent(match[1]!);
    opaqueToken = decodeURIComponent(hash.slice(1));
  } catch { /* invalid */ }
  if (hasQuery || hash) history.replaceState(history.state, "", location.pathname);
  return {
    intentId: !hasQuery && UUID.test(intentId) ? intentId : "",
    opaqueToken: !hasQuery && TOKEN.test(opaqueToken) ? opaqueToken : "",
  };
}
