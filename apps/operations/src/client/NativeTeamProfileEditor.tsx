import { useEffect, useRef, useState } from "react";
import { Card } from "@ltds/ui";
import { createNativeTeamApi, NativeTeamApiError, type NativeTeamProfile } from "./native-team-api";

type Props = { staffId: string; protectedOwner: boolean; onChanged: () => void | Promise<void> };
type Action = "profile" | "disable" | "enable";
type Snapshot = Readonly<{ action: Action; body: Readonly<{ commandId: string; expectedVersion: number; reason: string; displayName?: string }> }>;

const api = createNativeTeamApi();

export function NativeTeamProfileEditor({ staffId, protectedOwner, onChanged }: Props) {
  const [profile, setProfile] = useState<NativeTeamProfile | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const pending = useRef<Snapshot | null>(null);
  const uncertain = useRef(false);
  const mounted = useRef(true);
  const request = useRef(0);
  const identity = useRef({ staffId, epoch: 0 });
  const flight = useRef(0);
  const inFlight = useRef(false);

  if (identity.current.staffId !== staffId) {
    identity.current = { staffId, epoch: identity.current.epoch + 1 };
    request.current++;
    flight.current++;
    inFlight.current = false;
  }

  useEffect(() => {
    mounted.current = true;
    setProfile(null); setDisplayName(""); setReason(""); setStatus(""); setError("");
    setBusy(false); setLoading(false);
    pending.current = null; uncertain.current = false;
    return () => { mounted.current = false; request.current++; flight.current++; inFlight.current = false; };
  }, [staffId]);

  const load = async () => {
    const current = ++request.current;
    setLoading(true); setError(""); setStatus("");
    try {
      const value = await api.profile(staffId);
      if (!mounted.current || current !== request.current) return;
      setProfile(value); setDisplayName(value.scopedProfile.displayName); setReason("");
    } catch (cause) {
      if (!mounted.current || current !== request.current) return;
      const e = cause instanceof NativeTeamApiError ? cause : null;
      setError(e?.code === "setup_required" || e?.code === "not_found"
        ? "Native staff management is not available for this account or is turned off."
        : e?.code === "denied" || e?.code === "ended"
          ? "Access was denied or your staff session ended. Sign in again or ask an authorized administrator for access."
          : "The staff profile could not be loaded. Try loading it again.");
    } finally { if (mounted.current && current === request.current) setLoading(false); }
  };

  const run = async (snapshot: Snapshot) => {
    if (inFlight.current || !mounted.current || identity.current.staffId !== staffId) return;
    const runStaffId = staffId;
    const epoch = identity.current.epoch;
    const operation = ++flight.current;
    const isCurrent = () => mounted.current && identity.current.staffId === runStaffId
      && identity.current.epoch === epoch && flight.current === operation;
    inFlight.current = true;
    setBusy(true); setError(""); setStatus("Saving staff change…");
    try {
      await api.lifecycle(runStaffId, snapshot.action, snapshot.body);
    } catch (cause) {
      if (!isCurrent()) return;
      const e = cause instanceof NativeTeamApiError ? cause : null;
      if (e?.outcome === "unknown") {
        pending.current = snapshot;
        uncertain.current = true;
        setStatus("");
        setError("The outcome is unknown. Do not change this operation. Reload or reconcile the profile, then retry only this same action with its original command ID and details.");
      } else {
        if (!uncertain.current) pending.current = null;
        setStatus("");
        setError(e?.code === "conflict"
          ? uncertain.current ? "The original operation remains unresolved. Reload to reconcile, then retry only that same command." : "The profile changed since it was loaded. Reload the profile and review the current version before making a new change."
          : e?.code === "denied" || e?.code === "ended"
            ? uncertain.current ? "The original operation remains unresolved. Access was denied or your staff session ended; reload to reconcile, then retry only that same command." : "Access was denied or your staff session ended. No new operation was started."
            : uncertain.current ? "The original operation remains unresolved. Reload to reconcile, then retry only that same command." : "The staff change could not be completed. Reload the profile before trying a new operation.");
      }
      inFlight.current = false;
      setBusy(false);
      return;
    }
    pending.current = null;
    uncertain.current = false;
    if (!isCurrent()) return;
    setReason("");
    setStatus(snapshot.action === "profile" ? "Display name saved. Refreshing the profile…" : "Admission change saved. Access reconciliation is pending. Refreshing the profile…");
    try {
      await onChanged();
      if (!isCurrent()) return;
      const value = await api.profile(runStaffId);
      if (!isCurrent()) return;
      setProfile(value); setDisplayName(value.scopedProfile.displayName);
      setStatus(snapshot.action === "profile" ? "Display name saved. The profile has been refreshed." : "Admission change saved. Access reconciliation remains pending; the profile has been refreshed.");
    } catch {
      if (isCurrent())
        setError(snapshot.action === "profile" ? "The change was saved, but the profile could not be refreshed. Reload it to confirm the current state."
          : "The admission change was saved and access reconciliation is pending, but the profile could not be refreshed. Reload it to confirm the current state.");
    } finally {
      if (isCurrent()) {
        inFlight.current = false; setBusy(false);
      }
    }
  };

  const submit = (action: Action) => {
    if (!profile || inFlight.current || pending.current || !reason.trim()) return;
    if (action !== "profile" && protectedOwner) return;
    const body = Object.freeze({ commandId: crypto.randomUUID(),
      expectedVersion: action === "profile" ? profile.target.profileVersion : profile.target.admissionVersion,
      reason: reason.trim(), ...(action === "profile" ? { displayName: displayName.trim() } : {}) });
    const snapshot = Object.freeze({ action, body });
    pending.current = snapshot;
    void run(snapshot);
  };

  const locked = busy || pending.current !== null;
  return <Card title="Native staff profile">
    <section aria-label="Native staff profile editor" aria-busy={loading || busy}>
      <p>Load a scoped profile to review its current status. Changes are checked again by the server when submitted.</p>
      {!profile && <button type="button" className="button-orange" disabled={loading || busy} onClick={() => void load()}>
        {loading ? "Loading profile…" : "Load staff profile"}
      </button>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {status && <div className="notice" role="status">{status}</div>}
      {!profile && error && !pending.current && <button type="button" className="button-ghost" disabled={loading || busy} onClick={() => void load()}>Retry profile load</button>}
      {profile && <>
        <dl>
          <dt>Login email</dt><dd>{profile.scopedProfile.loginEmail}</dd>
          <dt>Admission</dt><dd>{profile.target.admissionActive ? "Active" : "Archived"}</dd>
        </dl>
        <p>Login-email replacement is unavailable here. Linking your own verified email is a separate process.</p>
        <label>Display name
          <input value={displayName} maxLength={160} disabled={locked} onChange={event => setDisplayName(event.target.value)} />
        </label>
        <label>Reason for change
          <textarea value={reason} maxLength={500} required disabled={locked} onChange={event => setReason(event.target.value)} />
        </label>
        <div>
          <button type="button" className="button-orange" disabled={locked || !reason.trim() || !displayName.trim()} onClick={() => submit("profile")}>Save display name</button>
          {profile.target.admissionActive
            ? <button type="button" className="button-danger" disabled={locked || protectedOwner || !reason.trim()} onClick={() => submit("disable")}>Archive staff admission</button>
            : <button type="button" className="button-ghost" disabled={locked || protectedOwner || !reason.trim()} onClick={() => submit("enable")}>Restore staff admission</button>}
        </div>
        {protectedOwner && <p>Admission changes are disabled for this protected owner.</p>}
        {pending.current && <div className="notice error" role="alert">
          <p>The same operation is still pending. Reload the profile first to reconcile its outcome; a retry will resend the original operation unchanged.</p>
          <button type="button" className="button-ghost" disabled={busy || loading} onClick={() => void load()}>Reload profile</button>
          <button type="button" className="button-orange" disabled={busy} onClick={() => void run(pending.current!)}>Retry same operation</button>
        </div>}
        <button type="button" className="button-ghost" disabled={busy || loading} onClick={() => void load()}>Reload profile</button>
      </>}
    </section>
  </Card>;
}
