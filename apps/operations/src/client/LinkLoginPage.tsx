import { useRef, useState } from "react";
import { Brand } from "@ltds/ui";
import { ACCESS_LOGOUT, useAccessEmail, useAccessSignOut } from "./access-session";
import {
  LINK_LOGIN_PATH, claimLoginLink, clearPendingLoginLink, pendingFromHash, readPendingLoginLink, savePendingLoginLink,
  type ClaimResult, type PendingLoginLink,
} from "./login-links-api";

/** Takes the link out of the address bar on first load, keeping it only in this tab until it is used or cancelled. */
function takePendingLink(): PendingLoginLink | null {
  const fromLink = pendingFromHash(location.hash);
  if (fromLink) {
    savePendingLoginLink(fromLink);
    history.replaceState(null, "", LINK_LOGIN_PATH);
    return fromLink;
  }
  if (location.hash) history.replaceState(null, "", LINK_LOGIN_PATH);
  return readPendingLoginLink();
}

type View = "ready" | "claiming" | ClaimResult["kind"];

/**
 * Standalone page, shown before Operations starts: confirms that the email this browser is signed in with should open
 * the same Operations profile. Nothing is linked until the person chooses "Link this email".
 */
export function LinkLoginPage() {
  const [pending, setPending] = useState(takePendingLink);
  const [view, setView] = useState<View>(pending ? "ready" : "invalid");
  const [message, setMessage] = useState<string | undefined>();
  const claiming = useRef(false);
  const email = useAccessEmail(!!pending);
  const [signingOut, signOut] = useAccessSignOut(LINK_LOGIN_PATH);
  const finish = (result: ClaimResult) => {
    if (result.kind === "linked" || result.kind === "invalid" || result.kind === "conflict") { clearPendingLoginLink(); setPending(null); }
    setMessage(result.kind === "linked" ? undefined : result.message);
    setView(result.kind);
  };
  const claim = () => {
    if (!pending || claiming.current) return;
    claiming.current = true;
    setView("claiming");
    void claimLoginLink(pending).then(finish).finally(() => { claiming.current = false; });
  };
  const cancel = () => { clearPendingLoginLink(); location.replace("/"); };
  const copy: Record<View, [string, string]> = {
    ready: ["Link this email to your Operations account?", "After linking, this email opens the same Ledge Top Operations profile as your main sign-in email. Your main email doesn't change."],
    claiming: ["Linking this email…", "This takes a moment."],
    linked: ["This email is linked", "From now on you can sign in to Ledge Top Operations with either email."],
    invalid: ["This link can't be used", "It has expired, was already used or isn't complete. Create a new link from your Operations account, then open it here."],
    conflict: ["This link is no longer current", "This email may already be linked, or a newer link replaced this one. Check your Operations account and create a new link if you still need one."],
    "sign-in": ["Sign in with the email you're adding", "To link it, sign in with the email you're adding after this link was created, then confirm again here."],
    unknown: ["We couldn't confirm the result", "We could not confirm whether the email was linked. Retry verification to check safely."],
  };
  const [title, detail] = copy[view];
  const canClaim = !!pending && (view === "ready" || view === "unknown");
  const offerSignIn = !!pending && (view === "ready" || view === "sign-in");
  return <main className="fatal sign-in-problem link-login" aria-labelledby="link-login-title">
    <header><Brand product="Operations" /></header>
    <div className="sign-in-problem-body">
      <h1 id="link-login-title">{title}</h1>
      {email && pending && <p className="sign-in-problem-email">Signed in as <strong>{email}</strong></p>}
      <p role={view === "ready" || view === "claiming" ? undefined : "status"}>{detail}</p>
      {message && view !== "ready" && <p className="sign-in-problem-hint">{message}</p>}
      {offerSignIn && <p className="sign-in-problem-hint">Not the email you're adding? Signing out of Cloudflare Access affects every Ledge Top app in this browser; this page comes back after you sign in.</p>}
      <div className="sign-in-problem-actions">
        {canClaim && <button type="button" className="button-orange" onClick={claim}>{view === "unknown" ? "Retry verification" : "Link this email"}</button>}
        {view === "claiming" && <button type="button" className="button-orange" disabled>Linking…</button>}
        {offerSignIn && <a className={`button ${view === "sign-in" ? "button-orange" : "button-ghost"}`} href={ACCESS_LOGOUT} onClick={signOut}
          aria-disabled={signingOut || undefined}>{signingOut ? "Signing out…" : "Sign in with a different email"}</a>}
        {pending && view !== "claiming" && <button type="button" className="button-ghost" onClick={cancel}>Cancel</button>}
        {!pending && <a className={`button ${view === "linked" ? "button-orange" : "button-ghost"}`} href="/">Open Operations</a>}
      </div>
    </div>
  </main>;
}
