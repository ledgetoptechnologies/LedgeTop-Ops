import { useEffect, useRef, useState } from "react";
import { createNativeTeamApi, NativeTeamApiError, type NativeLogsEligibility } from "./native-team-api";

type Snapshot = Readonly<{ effect: "allow" | "deny"; body: Readonly<{
  commandId: string; expectedRevision: number; expectedAdmissionVersion: number; effect: "allow" | "deny"; reason: string;
}> }>;

const api = createNativeTeamApi();

export function NativeTeamLogsEligibility({ staffId }: { staffId: string }) {
  const [data, setData] = useState<NativeLogsEligibility | null>(null);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
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
    setData(null); setReason(""); setStatus(""); setError(""); setBusy(false); setLoading(false);
    pending.current = null; uncertain.current = false;
    return () => { mounted.current = false; request.current++; flight.current++; inFlight.current = false; };
  }, [staffId]);

  const load = async () => {
    const current = ++request.current;
    setLoading(true); setError(""); setStatus(""); setData(null);
    try {
      const value = await api.logsEligibility(staffId);
      if (!mounted.current || identity.current.staffId !== staffId || current !== request.current) return;
      setData(value);
    } catch (cause) {
      if (!mounted.current || identity.current.staffId !== staffId || current !== request.current) return;
      const e = cause instanceof NativeTeamApiError ? cause : null;
      setError(e?.code === "setup_required" || e?.code === "not_found"
        ? "Device log eligibility is not available for this account or is turned off."
        : e?.code === "denied" || e?.code === "ended"
          ? "Access was denied or your staff session ended. Eligibility could not be verified."
          : "Eligibility could not be verified. Try loading it again.");
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
    setBusy(true); setError(""); setStatus("Saving eligibility change…");
    try {
      await api.setLogsEligibility(runStaffId, snapshot.body);
    } catch (cause) {
      if (!isCurrent()) return;
      const e = cause instanceof NativeTeamApiError ? cause : null;
      if (e?.outcome === "unknown") {
        pending.current = snapshot; uncertain.current = true;
        setStatus("");
        setError("The outcome is unknown. Reload to reconcile, then retry only this same effect, reason, revision, and command ID.");
      } else {
        if (!uncertain.current) pending.current = null;
        setStatus("");
        setError(uncertain.current
          ? "The original command remains unresolved. Reload to reconcile, then retry only that same command."
          : e?.code === "conflict"
            ? "Eligibility changed since it was loaded. Reload and review the current revision before starting a new command."
            : e?.code === "denied" || e?.code === "ended"
              ? "Access was denied or your staff session ended. Eligibility was not changed by this attempt."
              : "The eligibility change could not be completed. Reload before starting a new command.");
      }
      inFlight.current = false; setBusy(false);
      return;
    }

    if (!isCurrent()) return;
    pending.current = null; uncertain.current = false;
    setStatus("Eligibility change saved. Reloading the current eligibility…");
    try {
      const value = await api.logsEligibility(runStaffId);
      if (!isCurrent()) return;
      setData(value);
      setReason("");
      setStatus("Eligibility change saved. Current eligibility has been refreshed.");
    } catch {
      if (isCurrent()) setError("The eligibility change was saved, but its current state could not be refreshed. Reload to verify it.");
    } finally {
      if (isCurrent()) { inFlight.current = false; setBusy(false); }
    }
  };

  const submit = (effect: "allow" | "deny") => {
    if (!data || inFlight.current || pending.current || !reason.trim()) return;
    const body = Object.freeze({ commandId: crypto.randomUUID(), expectedRevision: data.revision,
      expectedAdmissionVersion: data.admissionVersion, effect, reason: reason.trim() });
    const snapshot = Object.freeze({ effect, body });
    pending.current = snapshot;
    void run(snapshot);
  };

  const locked = busy || pending.current !== null;
  return <section aria-label="Device log eligibility" aria-busy={loading || busy}>
    <h3>Device log eligibility</h3>
    <p>The username identifies the linked account. A username by itself does not grant access to device logs.</p>
    {!data && <button type="button" className="button-orange" disabled={loading || busy} onClick={() => void load()}>
      {loading ? "Loading eligibility…" : "Load eligibility"}
    </button>}
    {error && <div className="notice error" role="alert">{error}</div>}
    {status && <div className="notice" role="status">{status}</div>}
    {!data && error && !pending.current && <button type="button" className="button-ghost" disabled={loading || busy} onClick={() => void load()}>Retry eligibility load</button>}
    {data && <>
      <dl>
        <dt>Linked username</dt><dd>{data.username ?? "No username linked"}</dd>
        <dt>Eligibility</dt><dd>{data.eligible ? "Eligible" : data.effect === "deny" ? "Not eligible (denied)" : "Not eligible"}</dd>
      </dl>
      <label>Reason for change
        <textarea value={reason} maxLength={500} required disabled={locked} onChange={event => setReason(event.target.value)} />
      </label>
      <div>
        <button type="button" className="button-orange" disabled={locked || !reason.trim() || data.eligible} onClick={() => submit("allow")}>Grant eligibility</button>
        <button type="button" className="button-ghost" disabled={locked || !reason.trim() || data.effect !== "allow"} onClick={() => submit("deny")}>Revoke eligibility</button>
      </div>
      <button type="button" className="button-ghost" disabled={busy || loading} onClick={() => void load()}>Reload eligibility</button>
    </>}
    {pending.current && <div className="notice error" role="alert">
      <p>This command remains pending. A read-only reload does not establish whether it committed. Retry sends the original command unchanged.</p>
      <button type="button" className="button-ghost" disabled={busy || loading} onClick={() => void load()}>Reload eligibility</button>
      <button type="button" className="button-orange" disabled={busy} onClick={() => void run(pending.current!)}>Retry same command</button>
    </div>}
  </section>;
}
