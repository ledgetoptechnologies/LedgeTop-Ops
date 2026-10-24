/** Viewer detects provider type and creates it disabled; creation accepts no admission settings. */
export function providerCreateBody(displayName: string, endpoint: string, token: string) {
  return { displayName: displayName.trim(), endpoint, ...(token ? { credential: { token } } : {}) };
}
