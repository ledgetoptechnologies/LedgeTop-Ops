const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const OPERATIONS_NATIVE_ENROLLMENT_ORIGINS = new Set([
  "https://portal.ledgetop.app",
  "https://portal.ledgetopdroneservices.com",
  "https://portal-staging.ledgetopdroneservices.com",
  // Retain the original staging entry while its protected host is migrated.
  "https://client-staging.ledgetopdroneservices.com",
  // Playwright exercises the built portal through Vite preview on this exact origin.
  "http://127.0.0.1:4173",
]);
const OPERATIONS_NATIVE_ENROLLMENT_PATH = /^\/portal\/operations-recipient-enrollment\/[^/]+$/;

/** Shares the exact renderer boundary with Worker document-header selection. */
export function isOperationsNativeRecipientEnrollmentRoute(origin: string, pathname: string): boolean {
  return OPERATIONS_NATIVE_ENROLLMENT_ORIGINS.has(origin) && OPERATIONS_NATIVE_ENROLLMENT_PATH.test(pathname);
}

/**
 * Consumes the one-time portal enrollment token before React or any request
 * starts. The token is returned only in memory and is never accepted from a
 * query parameter.
 */
export function consumeClientPortalRecipientEnrollmentRoute(
  location: Pick<Location, "pathname" | "search" | "hash">,
  history: Pick<History, "state" | "replaceState">,
): { intentId: string; opaqueToken: string } | null {
  return consumeEnrollmentRoute(location, history, /^\/portal\/recipient-enrollment\/([^/]+)$/);
}

/** Separate native route; never interprets a legacy selection as an Ops target. */
export function consumeOperationsNativeRecipientEnrollmentRoute(
  location: Pick<Location, "origin" | "pathname" | "search" | "hash">,
  history: Pick<History, "state" | "replaceState">,
): { intentId: string; opaqueToken: string } | null {
  return consumeEnrollmentRoute(location, history, /^\/portal\/operations-recipient-enrollment\/([^/]+)$/,
    isOperationsNativeRecipientEnrollmentRoute(location.origin, location.pathname));
}

function consumeEnrollmentRoute(
  location: Pick<Location, "pathname" | "search" | "hash">,
  history: Pick<History, "state" | "replaceState">,
  pattern: RegExp,
  allowedOrigin = true,
): { intentId: string; opaqueToken: string } | null {
  const match = pattern.exec(location.pathname);
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
  if (!allowedOrigin) return null;
  return {
    intentId: !hasQuery && UUID.test(intentId) ? intentId : "",
    opaqueToken: !hasQuery && TOKEN.test(opaqueToken) ? opaqueToken : "",
  };
}
