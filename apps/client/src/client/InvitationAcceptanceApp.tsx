import { useEffect, useState } from "react";
import { Brand, Card, Loading } from "@ltds/ui";

type AcceptanceState =
  | { status: "submitting" }
  | { status: "accepted"; replayed: boolean }
  | { status: "error"; message: string };

async function acceptInvitation(token: string): Promise<{ replayed: boolean }> {
  const response = await fetch("/api/client/v2/invitations/accept", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    credentials: "same-origin",
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("Sign in with the invited email address, then reopen the invitation link.");
    if (response.status === 404) throw new Error("This invitation is invalid, expired, revoked, or belongs to a different email address.");
    throw new Error("The invitation could not be accepted right now. Please try the original link again later.");
  }
  const body = await response.json() as { accepted?: unknown; replayed?: unknown };
  if (body.accepted !== true || typeof body.replayed !== "boolean") throw new Error("The invitation response was invalid.");
  return { replayed: body.replayed };
}

export function InvitationAcceptanceApp({ token }: { token: string | null }) {
  const [state, setState] = useState<AcceptanceState>({ status: "submitting" });
  useEffect(() => {
    if (!token) {
      setState({ status: "error", message: "This invitation link is incomplete. Open the full link from your invitation email." });
      return;
    }
    let active = true;
    acceptInvitation(token).then(result => {
      if (active) setState({ status: "accepted", replayed: result.replayed });
    }).catch((caught: unknown) => {
      if (active) setState({ status: "error", message: caught instanceof Error ? caught.message : "The invitation could not be accepted." });
    });
    return () => { active = false; };
  }, [token]);

  return <div className="client-portal-boundary">
    <header className="client-portal-gate-header"><Brand product="Client portal" /></header>
    <main className="client-portal-gate-main" aria-live="polite">
      <Card>
        {state.status === "submitting" && <><h1>Accepting invitation</h1><p className="portal-copy">Confirming your secure workspace access…</p><Loading /></>}
        {state.status === "accepted" && <><h1>Workspace access ready</h1><p className="portal-copy">{state.replayed ? "This invitation was already accepted by your signed-in account." : "Your invitation was accepted."}</p><a className="button-primary portal-invitation-continue" href="/portal">Open client portal</a></>}
        {state.status === "error" && <><h1>Invitation unavailable</h1><p className="portal-form-error" role="alert">{state.message}</p><a className="button-ghost portal-invitation-continue" href="/portal">Go to client portal</a></>}
      </Card>
    </main>
  </div>;
}
