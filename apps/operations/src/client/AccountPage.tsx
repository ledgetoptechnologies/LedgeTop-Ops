import { useCallback, useEffect, useRef, useState } from "react";
import { Card, Skeleton, StatusPill, requestText } from "@ltds/ui";
import { ApiError } from "./api";
import { ACCESS_LOGOUT, useAccessSignOut } from "./access-session";
import { confirmAction } from "./confirm-action";
import {
  LINK_LOGIN_PATH, createLoginLinkIntent, loadLoginLinks, loginLinksUnavailable, pendingFromVerificationUrl, removeLoginLink,
  savePendingLoginLink, type LoginLinkBinding, type LoginLinkIntent, type LoginLinks,
} from "./login-links-api";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const when = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
};

/** The signed-in person's own account: who they are and, for the main owner, which other emails open this profile. */
export function AccountPage({ user }: { user: { displayName: string; email: string; status: string; profileType: string } }) {
  return <div className="account-page">
    <Card title="Profile">
      <dl className="account-facts">
        <div><dt>Name</dt><dd>{user.displayName}</dd></div>
        <div><dt>Email</dt><dd>{user.email}</dd></div>
        <div><dt>Profile</dt><dd>{user.status} {user.profileType}</dd></div>
      </dl>
    </Card>
    <SignInEmails />
  </div>;
}

type State = { kind: "loading" } | { kind: "hidden" } | { kind: "error" } | { kind: "ready"; links: LoginLinks };

function SignInEmails() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [intent, setIntent] = useState<LoginLinkIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const load = useCallback((signal?: AbortSignal) => loadLoginLinks(signal)
    .then(links => setState({ kind: "ready", links }))
    .catch(caught => { if (!signal?.aborted) setState(loginLinksUnavailable(caught) ? { kind: "hidden" } : { kind: "error" }); }), []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const pendingLink = intent ? pendingFromVerificationUrl(intent.verificationUrl) : null;
  const [signingOut, continueAsTarget] = useAccessSignOut(LINK_LOGIN_PATH, () => { if (pendingLink) savePendingLoginLink(pendingLink); });
  const [steppingUp, signInWithMain] = useAccessSignOut("/account");

  const run = async (task: () => Promise<void>) => {
    if (working.current) return;
    working.current = true; setBusy(true);
    try { await task(); } finally { working.current = false; setBusy(false); }
  };
  const add = () => run(async () => {
    const email = await requestText({
      title: "Add a sign-in email", label: "Email", confirmLabel: "Create link",
      description: "You'll confirm it by signing in with that email. The link works once and expires after 15 minutes.",
      validate: value => EMAIL.test(value.trim()) ? null : "Enter a full email address.",
    });
    if (!email) return;
    setNotice(null); setIntent(null);
    try {
      const created = await createLoginLinkIntent(email.trim());
      if (!pendingFromVerificationUrl(created.verificationUrl)) throw new Error("unexpected link");
      setIntent(created);
    } catch (caught) {
      // A lost response can't be recovered: never resend, offer a fresh link instead.
      setNotice({ tone: "error", text: caught instanceof ApiError && caught.status < 500 && caught.status !== 409
        ? caught.message : "The link couldn't be confirmed as created. Create a new link to try again." });
    }
  });
  const remove = (binding: LoginLinkBinding) => run(async () => {
    if (!await confirmAction(`Remove ${binding.email}? It will no longer open this Operations profile.`)) return;
    setNotice(null);
    try {
      await removeLoginLink(binding);
      setNotice({ tone: "ok", text: `${binding.email} was removed.` });
    } catch (caught) {
      setNotice({ tone: "error", text: caught instanceof ApiError && caught.status === 409
        ? "This email changed somewhere else. Review the list and try again." : `${binding.email} couldn't be removed. Try again.` });
    }
    await load();
  });
  const copyLink = async () => {
    if (!intent) return;
    try { await navigator.clipboard.writeText(intent.verificationUrl); setNotice({ tone: "ok", text: "Link copied. Open it in a browser signed in with the email you're adding." }); }
    catch { setNotice({ tone: "error", text: "The link couldn't be copied. Use “Sign out and continue” instead." }); }
  };

  if (state.kind === "hidden") return null;
  return <Card title="Sign-in emails" className="account-sign-in-emails">
    {state.kind === "loading" && <Skeleton lines={3} />}
    {state.kind === "error" && <div className="notice error">Sign-in emails couldn't be loaded. <button type="button" className="button-ghost" onClick={() => { setState({ kind: "loading" }); void load(); }}>Try again</button></div>}
    {state.kind === "ready" && (() => {
      const { links } = state, active = links.bindings.filter(binding => binding.status === "active");
      const onLinkedEmail = links.currentEmail.toLowerCase() !== links.canonicalEmail.toLowerCase();
      return <>
        <p className="muted">Each email here opens this same Operations profile. Your main email can't be removed.</p>
        <ul className="account-email-list">
          <li><span><strong>{links.canonicalEmail}</strong></span><StatusPill tone="success">Main</StatusPill></li>
          {active.map(binding => <li key={binding.id}>
            <span><strong>{binding.email}</strong><small>Linked {when(binding.createdAt)}</small></span>
            {links.canManage && <button type="button" className="button-ghost" disabled={busy} onClick={() => void remove(binding)}>Remove</button>}
          </li>)}
        </ul>
        {onLinkedEmail && <p className="muted">You're signed in with {links.currentEmail}, a linked email.</p>}
        {!links.canManage && <div className="account-step-up">
          <p>To add or remove sign-in emails, sign in with your main email{onLinkedEmail ? ` (${links.canonicalEmail})` : ""}.</p>
          {onLinkedEmail && <a className="button button-ghost" href={ACCESS_LOGOUT} onClick={signInWithMain} aria-disabled={steppingUp || undefined}>
            {steppingUp ? "Signing out…" : "Sign in with main email"}</a>}
        </div>}
        {notice && <div className={`notice${notice.tone === "error" ? " error" : ""}`} role="status">{notice.text}</div>}
        {links.canManage && intent && pendingLink && <div className="account-link-ready" role="status">
          <p><strong>Link ready for {intent.targetEmail}.</strong> It expires {when(intent.expiresAt)}.</p>
          <p className="muted">Sign out here and sign in as {intent.targetEmail} to confirm it. Signing out of Cloudflare Access affects every Ledge Top app in this browser. To confirm in another browser, copy the link instead.</p>
          <div className="account-actions">
            <a className="button button-orange" href={ACCESS_LOGOUT} onClick={continueAsTarget} aria-disabled={signingOut || undefined}>
              {signingOut ? "Signing out…" : `Sign out and continue as ${intent.targetEmail}`}</a>
            <button type="button" className="button-ghost" onClick={() => void copyLink()}>Copy link</button>
            <button type="button" className="button-ghost" onClick={() => setIntent(null)}>Done</button>
          </div>
        </div>}
        {links.canManage && !intent && <div className="account-actions">
          <button type="button" className="button-orange" disabled={busy} onClick={() => void add()}>Add a sign-in email</button>
        </div>}
      </>;
    })()}
  </Card>;
}
