import { Brand } from "@ltds/ui";
import { ACCESS_LOGOUT, useAccessEmail, useAccessSignOut } from "./access-session";

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
  const [signingOut, signOut] = useAccessSignOut("/");
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
