import { ACCESS_LOGOUT, useAccessEmail, useAccessSignOut } from "./access-session";

/**
 * The way out of any page that can't open: denied, not set up yet, signed out, or simply unavailable.
 * It always offers the normal Cloudflare Access sign-out so another email can be used and a retry, and points
 * to the person who set up access. It never links accounts or widens access.
 */
export function SignInRecovery({ returnTo = "/", lead = "different", onRetry }: {
  /** Where to land after signing out; Access shows its sign-in there. */
  returnTo?: string;
  /** Which action leads: another email (denied, not set up), signing in again (ended), or retrying (unavailable). */
  lead?: "different" | "again" | "retry";
  onRetry?: () => void;
}) {
  const email = useAccessEmail();
  const [signingOut, signOut] = useAccessSignOut(returnTo);
  const signInClass = lead === "retry" ? "button-ghost" : "button-orange";
  return <div className="sign-in-recovery">
    {email && <p className="sign-in-recovery-email">Signed in as <strong>{email}</strong></p>}
    <div className="sign-in-recovery-actions">
      <a className={`button ${signInClass}`} href={ACCESS_LOGOUT} onClick={signOut} aria-disabled={signingOut || undefined}>
        {signingOut ? "Signing out…" : lead === "again" ? "Sign in again" : "Sign in with a different email"}</a>
      <button type="button" className={lead === "retry" ? "button-orange" : "button-ghost"}
        onClick={() => onRetry ? onRetry() : location.reload()}>Try again</button>
    </div>
    <p className="sign-in-recovery-hint">Signing out ends your Ledge Top sign-in in this browser, so other Ledge Top apps will ask you to sign in again too. It doesn't change any account.</p>
    <p className="sign-in-recovery-help">Still stuck? Ask your Ledge Top contact or administrator for help.</p>
  </div>;
}
