/** Reads an invitation secret from the fragment and removes it from the
 * current history entry before any request, render, analytics, or navigation. */
export function consumeInvitationToken(location: Location, history: History): string | null {
  const fragment = new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : location.hash);
  const token = fragment.get("token");
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  return token && /^[A-Za-z0-9_-]{32,256}$/.test(token) ? token : null;
}
