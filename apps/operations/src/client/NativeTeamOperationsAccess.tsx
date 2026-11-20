import { useEffect, useRef, useState } from "react";
import { createOperationsAccessApi, OperationsAccessApiError, type OperationsAccessCommand, type OperationsAccessReason,
  type OperationsAccessState } from "./staff-operations-access-api";

const api = createOperationsAccessApi();

/** Titles only. Unknown server keys fall back to the permission key. */
const TITLES: Record<string, string> = {
  "operations.view_all": "View all operations, projects, and tasks",
  "sops.assign": "Assign published SOPs to visible work",
  "delivery.browse": "Browse delivery files",
  "delivery.share.create": "Create client links",
  "delivery.share.revoke": "Revoke client links",
  "delivery.share.audit": "View client-link history",
  "team.view": "View the team roster",
  "administration.view": "View administration status",
  "viewer.view": "View and open 3D models",
  "viewer.datasets.manage": "Manage Viewer projects, datasets, and imports",
  "viewer.processing.manage": "Manage processing, ground control, and providers",
  "viewer.publish": "Publish reviewed model outputs",
  "viewer.share.create": "Create public model links",
  "viewer.share.revoke": "Revoke public model links",
  "viewer.manage": "Associate models and manage client model access",
};
const REASONS: Record<OperationsAccessReason, string> = {
  self: "Your own access",
  protected_owner: "Protected owner",
  not_native_hire: "Not an Operations hire",
  target_identity_mismatch: "Sign-in needs review",
  actor_not_administrator: "Administrators only",
  actor_lacks_roles_manage: "Needs role management",
  actor_denied: "Denied for you",
  actor_lacks_permission: "Outside your access",
  target_denied: "Denied",
  inherited: "From role",
  target_inactive: "Inactive employee",
  not_command_managed: "Set elsewhere",
};
const STATES = { none: "Off", allow: "On", deny: "Denied", inherited: "On (role)" } as const;

type Pending = Readonly<{ command: OperationsAccessCommand }>;

export function NativeTeamOperationsAccess({ staffId, name }: { staffId: string; name: string }) {
  const [data, setData] = useState<OperationsAccessState | null>(null);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const mounted = useRef(true);
  const request = useRef(0);
  const inFlight = useRef(false);
  const uncertain = useRef(false);

  useEffect(() => {
    mounted.current = true;
    setData(null); setReason(""); setStatus(""); setError(""); setBusy(false); setLoading(false); setPending(null);
    uncertain.current = false;
    return () => { mounted.current = false; request.current++; inFlight.current = false; };
  }, [staffId]);

  const load = async () => {
    const current = ++request.current;
    setLoading(true); setError(""); setStatus("");
    try {
      const value = await api.read(staffId);
      if (!mounted.current || current !== request.current) return;
      setData(value);
    } catch (cause) {
      if (!mounted.current || current !== request.current) return;
      const e = cause instanceof OperationsAccessApiError ? cause : null;
      setData(null);
      setError(e?.code === "not_found" ? "Operations access is not available here."
        : e?.code === "denied" ? "You can't change Operations access." : "Operations access could not be loaded.");
    } finally { if (mounted.current && current === request.current) setLoading(false); }
  };

  /** Sends exactly this command. An uncertain outcome pins it; only the same
   * command (same commandId and body) can be retried, and never automatically. */
  const run = async (command: OperationsAccessCommand) => {
    if (inFlight.current || !mounted.current) return;
    inFlight.current = true; setBusy(true); setError(""); setStatus("Saving…");
    try {
      await api.change(staffId, command);
    } catch (cause) {
      if (!mounted.current) return;
      const e = cause instanceof OperationsAccessApiError ? cause : null;
      setStatus("");
      if (e?.outcome === "unknown") {
        uncertain.current = true;
        setPending({ command });
        setError("The result is unknown. Reload, then retry this same change.");
      } else if (uncertain.current) {
        setError("The earlier change is still unresolved. Reload, then retry the same change.");
      } else {
        setPending(null);
        setError(e?.serverError === "state_mismatch" || e?.serverError === "command_conflict"
          ? "Access changed since it was loaded. Reload and try again."
          : e?.reason ? `Not changed: ${REASONS[e.reason]}.` : "Not changed.");
      }
      inFlight.current = false; setBusy(false);
      return;
    }
    if (!mounted.current) return;
    uncertain.current = false; setPending(null); setReason("");
    try {
      const value = await api.read(staffId);
      if (mounted.current) { setData(value); setStatus("Saved."); }
    } catch {
      if (mounted.current) setError("Saved, but the current access could not be reloaded.");
    } finally { if (mounted.current) { inFlight.current = false; setBusy(false); } }
  };

  const submit = (permission: string, operation: "grant" | "revoke") => {
    if (!data || inFlight.current || pending || !reason.trim()) return;
    const command = Object.freeze({ commandId: crypto.randomUUID(), permission, operation, expectedRevision: data.revision,
      expectedAdmissionVersion: data.targetAdmissionVersion ?? 1, reason: reason.trim() });
    setPending({ command });
    void run(command);
  };

  const locked = busy || pending !== null;
  return <section className="native-operations-access" aria-label={`${name} Operations access`} aria-busy={loading || busy}>
    <h4>Operations access</h4>
    {!data && <button type="button" className="button-ghost button-small" disabled={loading || busy} onClick={() => void load()}>
      {loading ? "Loading…" : "Load Operations access"}
    </button>}
    {error && <div className="notice error" role="alert">{error}</div>}
    {status && <div className="notice" role="status">{status}</div>}
    {data && <>
      {data.targetReason && <p className="muted">{REASONS[data.targetReason]}</p>}
      <ul className="native-operations-access-list">
        {data.permissions.map(entry => {
          const title = TITLES[entry.permission] ?? entry.permission;
          return <li key={entry.permission}>
            <span>{title}</span>
            <span className="muted">{STATES[entry.state]}{entry.reason ? ` · ${REASONS[entry.reason]}` : ""}</span>
            {entry.operation && <button type="button" className={entry.operation === "grant" ? "button-orange button-small" : "button-ghost button-small"}
              aria-label={`${entry.operation === "grant" ? "Grant" : "Revoke"} ${title}`}
              disabled={locked || !entry.editable || !reason.trim()} onClick={() => submit(entry.permission, entry.operation!)}>
              {entry.operation === "grant" ? "Grant" : "Revoke"}
            </button>}
          </li>;
        })}
      </ul>
      <label>Reason for change
        <textarea value={reason} maxLength={500} disabled={locked} onChange={event => setReason(event.target.value)} />
      </label>
      <button type="button" className="button-ghost button-small" disabled={busy || loading} onClick={() => void load()}>Reload</button>
    </>}
    {pending && !busy && <div className="notice error" role="alert">
      <p>A change is unresolved.</p>
      <button type="button" className="button-ghost button-small" disabled={loading} onClick={() => void load()}>Reload</button>
      <button type="button" className="button-orange button-small" onClick={() => void run(pending.command)}>Retry same change</button>
    </div>}
  </section>;
}
