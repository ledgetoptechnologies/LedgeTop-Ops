import { useEffect, useState } from "react";
import { Brand, Card, Loading, SignInRecovery } from "@ltds/ui";
import { clientPortalPath } from "./portal-route";

type AcceptanceState =
  | { status: "submitting" }
  | { status: "accepted"; replayed: boolean }
  | { status: "error"; message: string; uncertain: boolean };

class InvitationFailure extends Error {
  constructor(message: string, readonly uncertain: boolean) { super(message); }
}

async function acceptInvitation(token: string): Promise<{ replayed: boolean }> {
  const response = await fetch("/api/client/v2/invitations/accept", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    credentials: "same-origin",
  });
  if (!response.ok) {
    if (response.status === 401) throw new InvitationFailure("Sign in with the invited email address, then reopen the invitation link.", false);
    if (response.status === 404) throw new InvitationFailure("This invitation is invalid, expired, revoked, or belongs to a different email address.", false);
    throw new InvitationFailure("We could not verify whether your invitation was accepted. Keep this page open and try again.", true);
  }
  const body = await response.json() as { accepted?: unknown; replayed?: unknown };
  if (body.accepted !== true || typeof body.replayed !== "boolean") throw new InvitationFailure("We could not verify whether your invitation was accepted. Keep this page open and try again.", true);
  return { replayed: body.replayed };
}

export function InvitationAcceptanceApp({ token }: { token: string | null }) {
  const [state, setState] = useState<AcceptanceState>({ status: "submitting" });
  const [attempt, setAttempt] = useState(0);
  const retry = () => {
    if (!token) { location.reload(); return; }
    setState({ status: "submitting" }); setAttempt(value => value + 1);
  };
  useEffect(() => {
    if (!token) {
      setState({ status: "error", message: "This invitation link is incomplete. Open the full link from your invitation email.", uncertain: false });
      return;
    }
    let active = true;
    acceptInvitation(token).then(result => {
      if (active) setState({ status: "accepted", replayed: result.replayed });
    }).catch((caught: unknown) => {
      if (active) setState({ status: "error",
        message: caught instanceof InvitationFailure ? caught.message
          : "We could not verify whether your invitation was accepted. Keep this page open and try again.",
        uncertain: !(caught instanceof InvitationFailure) || caught.uncertain });
    });
    return () => { active = false; };
  }, [token, attempt]);

  return <div className="client-portal-boundary">
    <header className="client-portal-gate-header"><Brand product="Client portal" /></header>
    <main className="client-portal-gate-main" aria-live="polite">
      <Card>
        {state.status === "submitting" && <><h1>Accepting invitation</h1><p className="portal-copy">Confirming your secure access…</p><Loading /></>}
        {state.status === "accepted" && <><h1>Access ready</h1><p className="portal-copy">{state.replayed ? "This invitation was already accepted by your signed-in account." : "Your invitation was accepted."}</p><a className="button-primary portal-invitation-continue" href={clientPortalPath("dashboard")}>Open client portal</a></>}
        {state.status === "error" && <><h1>{state.uncertain ? "Invitation status uncertain" : "Invitation unavailable"}</h1>
          <p className="portal-form-error" role="alert">{state.message}</p>
          {state.uncertain ? <button type="button" className="button-orange" onClick={retry}>Try again</button> : <>
            <p className="portal-copy">After signing in with a different email, reopen the original secure link from your invitation.</p>
            <SignInRecovery returnTo="/portal" lead="different" onRetry={retry} />
          </>}
          <a className="button-ghost portal-invitation-continue" href={clientPortalPath("dashboard")}>Go to client portal</a></>}
      </Card>
    </main>
  </div>;
}
