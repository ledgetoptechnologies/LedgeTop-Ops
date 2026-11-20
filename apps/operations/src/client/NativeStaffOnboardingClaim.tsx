import { useEffect, useRef, useState } from "react";
import { createNativeTeamApi, NativeTeamApiError } from "./native-team-api";
import type { NativeStaffInvitation } from "./native-staff-onboarding-link";

const api = createNativeTeamApi();

/** This page deliberately mounts before the Operations staff session: a new
 * recipient is not an admitted employee yet. The server requires its separately
 * configured claimant Access audience and independently verifies the email. */
export function NativeStaffOnboardingClaim({ initialInvitation }: { initialInvitation: NativeStaffInvitation | null }) {
  const [invitation, setInvitation] = useState(initialInvitation);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const mounted = useRef(false), inFlight = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const confirm = async () => {
    if (!invitation || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      await api.onboardingClaim(invitation);
      if (!mounted.current) return;
      setConfirmed(true); setInvitation(null); setUncertain(false);
    } catch (cause) {
      if (!mounted.current) return;
      const e = cause instanceof NativeTeamApiError ? cause : null;
      if (e?.outcome === "unknown") setUncertain(true);
      setError(e?.code === "setup_required" || e?.code === "not_found"
        ? "Employee invitation confirmation is not enabled here. Contact the person who invited you."
        : e?.code === "denied" || e?.code === "ended"
          ? "This sign-in could not confirm the invitation. Sign in with the email that received it, or ask the inviter to review its status."
          : e?.code === "invalid_request" ? "The invitation is invalid. Ask the inviter for a new link."
            : "Confirmation could not be verified. Retry the same invitation; do not request a second employee record.");
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };

  return <main className="account-page">
    <section className="card" aria-labelledby="staff-invitation-title" aria-busy={busy}>
      <p>Ledge Top</p><h1 id="staff-invitation-title">Confirm your employee invitation</h1>
      {confirmed ? <div role="status">
        <h2>Email confirmation received</h2>
        <p>An authorized administrator must review your invitation before your employee account is activated. This step grants no Operations, file or Logs permissions.</p>
      </div> : invitation ? <>
        <p>Continue with the Cloudflare sign-in for the email that received this invitation. Your identity will be checked again when you confirm.</p>
        {error && <div className="notice error" role="alert">{error}</div>}
        {uncertain && <p role="status">The earlier attempt is unresolved. Retry uses this same invitation unchanged.</p>}
        <button type="button" className="button-orange" disabled={busy} onClick={() => void confirm()}>{busy ? "Confirming…" : uncertain ? "Retry same invitation" : "Confirm invitation"}</button>
      </> : <p role="alert">This invitation link is incomplete or invalid. Open the full private link from your inviter.</p>}
      <p><a href="/cdn-cgi/access/logout">Sign out and use another email</a></p>
      <p>After signing out, reopen the original private invitation link and use the invited email.</p>
      <p><a href="/">Back to Operations</a></p>
    </section>
  </main>;
}
