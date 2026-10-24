import { useEffect, useRef, useState } from "react";
import { Brand } from "@ltds/ui";
import { ACCESS_LOGOUT, useAccessEmail, useAccessSignOut } from "./access-session";
import {
  LINK_LOGIN_PATH, claimLoginLink, clearPendingLoginLink, pendingFromHash, previewLoginLink, readPendingLoginLink, savePendingLoginLink,
  type ClaimResult, type LoginLinkPreview, type PendingLoginLink, type PreviewResult,
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

/** "checking"/"check-failed" are the read-only preview; "unknown" is a claim whose outcome wasn't confirmed. */
type View = "checking" | "check-failed" | "ready" | "claiming" | ClaimResult["kind"];

const when = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
};

/**
 * Standalone page, shown before Operations starts. It first reads whose profile the link joins and shows that owner's
 * name and main email; only then can the person choose "Link this email". Nothing is linked automatically.
 */
export function LinkLoginPage() {
  const [pending, setPending] = useState(takePendingLink);
  const [view, setView] = useState<View>(pending ? "checking" : "invalid");
  const [preview, setPreview] = useState<LoginLinkPreview | null>(null);
  const [message, setMessage] = useState<string | undefined>();
  const [checks, setChecks] = useState(0);
  const [copyRecovery, setCopyRecovery] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  const claiming = useRef(false);
  const email = useAccessEmail(!!pending);
  const [signingOut, signOut] = useAccessSignOut(LINK_LOGIN_PATH, () => {
    if (pending && savePendingLoginLink(pending)) return true;
    setCopyRecovery(true);
    setMessage("This browser can't keep the link while you sign out. Open the link again after you sign in with the email you're adding.");
    return false;
  });
  const settle = (result: PreviewResult | ClaimResult) => {
    if (result.kind === "linked" || result.kind === "invalid" || result.kind === "conflict") { clearPendingLoginLink(); setPending(null); }
    setMessage("message" in result ? result.message : undefined);
  };

  useEffect(() => {
    if (!pending) return;
    let active = true;
    setView("checking");
    void previewLoginLink(pending).then(result => {
      if (!active) return;
      settle(result);
      if (result.kind === "preview") { setPreview(result.preview); setView("ready"); }
      else setView(result.kind === "unknown" ? "check-failed" : result.kind);
    });
    return () => { active = false; };
    // Re-check only when asked; the pending link itself doesn't change while this page is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checks]);

  const claim = () => {
    if (!pending || !preview || claiming.current || signingOut) return;
    claiming.current = true;
    setView("claiming");
    void claimLoginLink(pending).then(result => { settle(result); setView(result.kind); }).finally(() => { claiming.current = false; });
  };
  const cancel = () => { if (signingOut) return; clearPendingLoginLink(); location.replace("/"); };
  const copyLink = async () => {
    if (!pending) return;
    const link = `${location.origin}${LINK_LOGIN_PATH}#intent=${pending.intentId}&token=${pending.token}`;
    try { await navigator.clipboard.writeText(link); setCopyMessage("Link copied. Keep it private and open it after signing in."); }
    catch { setCopyMessage("Copy isn't available. Reopen the original verification link after signing in."); }
  };

  const owner = preview ? `${preview.ownerDisplayName} (${preview.canonicalEmail})` : "";
  const copy: Record<View, [string, string]> = {
    checking: ["Checking this link…", "Checking the profile and current link status."],
    "check-failed": ["We couldn't check this link", "We couldn't confirm whether this email is linked. Check your connection and try again."],
    ready: [preview ? `Link ${preview.targetEmail} to ${preview.ownerDisplayName}’s Operations profile?` : "Link this email?",
      `It will sign in as ${owner} and get the same Operations permissions. The main email doesn't change.`],
    claiming: ["Linking this email…", "This takes a moment."],
    linked: ["This email is linked", "From now on you can sign in to Ledge Top Operations with either email."],
    invalid: ["This link can't be used", "It has expired, was already used or isn't complete. Create a new link from your Operations account, then open it here."],
    conflict: ["This link is no longer current", "It has expired or a newer link replaced it. If this email was already linked, it still signs in as before; otherwise create a new link from your Operations account."],
    "sign-in": ["Sign in with the email you're adding", "To link it, sign in with the email you're adding after this link was created, then open this page again."],
    unknown: ["We couldn't confirm the result", "We could not confirm whether the email was linked. Retry verification to check safely."],
  };
  const [title, detail] = copy[view];
  const canClaim = !!pending && !!preview && (view === "ready" || view === "unknown");
  const offerSignIn = !!pending && (view === "ready" || view === "sign-in");
  return <main className="fatal sign-in-problem link-login" aria-labelledby="link-login-title">
    <header><Brand product="Operations" /></header>
    <div className="sign-in-problem-body">
      <h1 id="link-login-title">{title}</h1>
      {email && pending && <p className="sign-in-problem-email">Signed in as <strong>{email}</strong></p>}
      {view === "ready" && preview && <dl className="link-login-owner">
        <div><dt>Profile</dt><dd>{preview.ownerDisplayName}</dd></div>
        <div><dt>Main email</dt><dd>{preview.canonicalEmail}</dd></div>
        <div><dt>Email being added</dt><dd>{preview.targetEmail}</dd></div>
        <div><dt>Link expires</dt><dd>{when(preview.expiresAt)}</dd></div>
      </dl>}
      <p role={view === "ready" || view === "claiming" || view === "checking" ? undefined : "status"}>{detail}</p>
      {message && <p className="sign-in-problem-hint" role="alert">{message}</p>}
      {offerSignIn && <p className="sign-in-problem-hint">Not the email you're adding? Signing out of Cloudflare Access affects every Ledge Top app in this browser; this page comes back after you sign in.</p>}
      <div className="sign-in-problem-actions">
        {canClaim && <button type="button" className="button-orange" disabled={signingOut} onClick={claim}>{view === "unknown" ? "Retry verification" : "Link this email to this profile"}</button>}
        {view === "claiming" && <button type="button" className="button-orange" disabled>Linking…</button>}
        {view === "check-failed" && <button type="button" className="button-orange" onClick={() => setChecks(value => value + 1)}>Try again</button>}
        {offerSignIn && <a className={`button ${view === "sign-in" ? "button-orange" : "button-ghost"}`} href={ACCESS_LOGOUT} onClick={signOut}
          aria-disabled={signingOut || undefined}>{signingOut ? "Signing out…" : "Sign in with a different email"}</a>}
        {copyRecovery && pending && <button type="button" className="button-ghost" onClick={() => void copyLink()}>Copy link</button>}
        {pending && view !== "claiming" && view !== "checking" && <button type="button" className="button-ghost" disabled={signingOut} onClick={cancel}>Cancel</button>}
        {!pending && <a className={`button ${view === "linked" ? "button-orange" : "button-ghost"}`} href="/">Open Operations</a>}
      </div>
      {copyMessage && <p role="status">{copyMessage}</p>}
    </div>
  </main>;
}
