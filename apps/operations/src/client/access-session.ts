import { useEffect, useRef, useState, type MouseEvent } from "react";

export const ACCESS_LOGOUT = "/cdn-cgi/access/logout";

/**
 * Ends the Cloudflare Access session through its documented logout URL, then returns to `returnTo` on this host,
 * where Access shows its sign-in. Any failure falls back to opening the logout URL itself; a second click while one
 * is pending does nothing, and modified clicks keep the browser's own link handling.
 */
export function useAccessSignOut(returnTo = "/", beforeSignOut?: () => void) {
  const [pending, setPending] = useState(false);
  const started = useRef(false);
  const signOut = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (started.current) return;
    started.current = true;
    setPending(true);
    beforeSignOut?.();
    fetch(ACCESS_LOGOUT, { credentials: "same-origin", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(8000) })
      .then(response => response.ok || response.type === "opaqueredirect")
      .catch(() => false)
      .then(signedOut => signedOut ? location.replace(returnTo) : location.assign(ACCESS_LOGOUT));
  };
  return [pending, signOut] as const;
}

/** The email Cloudflare Access signed this browser in with, read from Access itself; null when unknown. */
export function useAccessEmail(enabled = true) {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetch("/cdn-cgi/access/get-identity", { credentials: "same-origin", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) })
      .then(response => response.ok ? response.json() : null)
      .then((value: unknown) => {
        const identity = value as { email?: unknown } | null;
        if (typeof identity?.email === "string" && identity.email.length <= 254 && identity.email.includes("@")) setEmail(identity.email);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [enabled]);
  return email;
}
