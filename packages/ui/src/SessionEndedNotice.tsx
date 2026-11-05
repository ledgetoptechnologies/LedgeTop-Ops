import { useAccessSessionEnded } from "./access-ajax";
import { SignInRecovery } from "./SignInRecovery";

/** Shown when Cloudflare Access ends the sign-in mid-visit. It never navigates by itself and leaves the page usable, so unsaved work can be copied first. */
export function SessionEndedNotice() {
  if (!useAccessSessionEnded()) return null;
  return <aside className="session-ended-notice" aria-labelledby="session-ended-title">
    <h2 id="session-ended-title">Your sign-in has ended</h2>
    <p role="alert">Sign in again to continue. Copy anything you haven't saved first.</p>
    <SignInRecovery returnTo={location.pathname + location.search} lead="again" />
  </aside>;
}
