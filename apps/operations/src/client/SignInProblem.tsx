import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Brand } from "@ltds/ui";

/** Why Operations couldn't open: the session request's status and the server's plain message. */
export type StartupFailure = { status: number | null; message: string };

/**
 * Shown when Operations can't start. A sign-in that isn't set up for Operations offers the normal
 * Cloudflare Access sign-out so another email can be used; it never links accounts or widens access.
 * With JavaScript the sign-out runs in place and returns to Operations' sign-in in one click; the plain
 * logout link stays as the fallback.
 */
export function SignInProblem({ failure }: { failure: StartupFailure }) {
  const denied = failure.status === 403, expired = failure.status === 401;
  const email = useAccessEmail(denied);
  const [signingOut, signOut] = useSignOutAndReturn();
  const title = denied ? "This email can't open Ledge Top Operations"
    : expired ? "Your sign-in has ended" : "Operations is unavailable right now";
  const detail = denied ? failure.message
    : expired ? "Sign in again to continue." : "Check your connection and try again. If this keeps happening, contact your administrator.";
  return <main className="fatal sign-in-problem" aria-labelledby="sign-in-problem-title">
    <header><Brand product="Operations" /></header>
    <div className="sign-in-problem-body">
      <h1 id="sign-in-problem-title">{title}</h1>
      {email && <p className="sign-in-problem-email">Signed in as <strong>{email}</strong></p>}
      <p role="alert">{detail}</p>
      {denied && <p className="sign-in-problem-hint">This signs you out of Cloudflare Access in this browser, so other Ledge Top apps will ask you to sign in again too. It doesn't change any account.</p>}
      <div className="sign-in-problem-actions">
        {denied || expired
          ? <a className="button button-orange" href={ACCESS_LOGOUT} onClick={signOut} aria-disabled={signingOut || undefined}>
            {signingOut ? "Signing out…" : denied ? "Sign in with a different email" : "Sign in again"}</a>
          : null}
        <button type="button" className={denied || expired ? "button-ghost" : "button-orange"} onClick={() => location.reload()}>Try again</button>
      </div>
    </div>
  </main>;
}

const ACCESS_LOGOUT = "/cdn-cgi/access/logout";

/**
 * Ends the Cloudflare Access session through its documented logout URL, then returns to this host's root, where
 * Access shows its sign-in. Any failure falls back to opening the logout URL itself; a second click while one is
 * pending does nothing.
 */
function useSignOutAndReturn() {
  const [pending, setPending] = useState(false);
  const started = useRef(false);
  const signOut = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (started.current) return;
    started.current = true;
    setPending(true);
    fetch(ACCESS_LOGOUT, { credentials: "same-origin", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(8000) })
      .then(response => response.ok || response.type === "opaqueredirect")
      .catch(() => false)
      .then(signedOut => signedOut ? location.replace("/") : location.assign(ACCESS_LOGOUT));
  };
  return [pending, signOut] as const;
}

/** The email Cloudflare Access signed this browser in with, read from Access itself; null when unknown. */
function useAccessEmail(enabled: boolean) {
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
