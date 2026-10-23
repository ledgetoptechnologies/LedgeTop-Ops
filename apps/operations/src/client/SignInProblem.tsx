import { useEffect, useState } from "react";
import { Brand } from "@ltds/ui";

/** Why Operations couldn't open: the session request's status and the server's plain message. */
export type StartupFailure = { status: number | null; message: string };

/**
 * Shown when Operations can't start. A sign-in that isn't set up for Operations offers the normal
 * Cloudflare Access sign-out so another email can be used; it never links accounts or widens access.
 */
export function SignInProblem({ failure }: { failure: StartupFailure }) {
  const denied = failure.status === 403, expired = failure.status === 401;
  const email = useAccessEmail(denied);
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
      {denied && <p className="sign-in-problem-hint">Signing out only ends this browser's sign-in. It doesn't change any account.</p>}
      <div className="sign-in-problem-actions">
        {denied || expired
          ? <a className="button button-orange" href="/cdn-cgi/access/logout">{denied ? "Sign in with a different email" : "Sign in again"}</a>
          : null}
        <button type="button" className={denied || expired ? "button-ghost" : "button-orange"} onClick={() => location.reload()}>Try again</button>
      </div>
    </div>
  </main>;
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
