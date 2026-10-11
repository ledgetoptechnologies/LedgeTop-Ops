import { useEffect, useState, type FormEvent } from "react";
import { Card, Loading } from "@ltds/ui";
import { issueNativeBillingPermission, NativeBillingPermissionOwnerApiError, readNativeBillingPermissionSession,
  revokeNativeBillingPermission, reviewNativeBillingPermission, type NativeBillingPermissionIssue,
  type NativeBillingPermissionReview, type NativeBillingPermissionSession,
  type NativeBillingPermissionRevoke, type NativeBillingPermissionResult }
  from "./operations-native-billing-permission-owner-api";
import { confirmAction } from "./confirm-action";
import "./ClientOnboardingStaff.css";

type Attempt = Readonly<{ kind: "issue"; input: NativeBillingPermissionIssue }> |
  Readonly<{ kind: "revoke"; input: NativeBillingPermissionRevoke }>;
const newId = () => crypto.randomUUID();
const denied = (error: unknown) => error instanceof NativeBillingPermissionOwnerApiError
  && [401, 403, 404, 410].includes(error.status);

export function OperationsNativeBillingPermissions() {
  const [session, setSession] = useState<NativeBillingPermissionSession | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let mounted = true;
    void readNativeBillingPermissionSession().then(value => { if (mounted) setSession(value); })
      .catch(() => { if (mounted) setUnavailable(true); });
    return () => { mounted = false; };
  }, []);
  if (unavailable) return <main className="onboarding-staff-gate"><Card><h1>Billing permission delegation unavailable</h1>
    <p role="alert">Owner session is unavailable. No delegated permission was changed.</p></Card></main>;
  if (!session) return <main className="onboarding-staff-gate"><Loading /></main>;
  return <BillingPermissionsWorkspace initialSession={session} />;
}

function BillingPermissionsWorkspace({ initialSession }: { initialSession: NativeBillingPermissionSession }) {
  const [session, setSession] = useState(initialSession);
  const [staffId, setStaffId] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [effect, setEffect] = useState<"allow" | "deny">("allow");
  const [review, setReview] = useState<NativeBillingPermissionReview | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const locked = busy || attempt !== null;
  const invalidateReview = () => { setReview(null); setMessage(""); setError(""); };
  const change = <T extends string>(setter: (value: T) => void) => (value: T) => { setter(value); invalidateReview(); };

  const reviewScope = async (event: FormEvent) => {
    event.preventDefault(); if (locked) return;
    const input = { staffId: staffId.trim(), resourceId: resourceId.trim() };
    setBusy(true); setReview(null); setError(""); setMessage("");
    try {
      const value = await reviewNativeBillingPermission(session.csrfToken, input);
      setReview(value);
      setMessage("Exact staff and resource scope reviewed. Only current active grants for this resource are shown.");
    } catch (caught) {
      setError(denied(caught) ? "Owner or target authorization was denied. No permission was changed."
        : "The exact staff/resource scope could not be reviewed.");
    } finally { setBusy(false); }
  };

  const execute = async (current: Attempt, retrying = false) => {
    setBusy(true); setError(""); setMessage("");
    try {
      const currentSession = retrying ? await readNativeBillingPermissionSession() : session;
      if (retrying) setSession(currentSession);
      const result: NativeBillingPermissionResult = current.kind === "issue"
        ? await issueNativeBillingPermission(currentSession.csrfToken, current.input)
        : await revokeNativeBillingPermission(currentSession.csrfToken, current.input);
      setAttempt(null); setReview(null);
      if (result.status === "conflict") {
        setError("The permission generation changed or the grant is no longer eligible. Review current scope again.");
        return;
      }
      setMessage(`Permission ${result.status} at generation ${result.generation} (${result.grantId}). Review current scope again before another change.`);
    } catch (caught) {
      if (caught instanceof NativeBillingPermissionOwnerApiError && caught.uncertain) {
        setAttempt(current);
        setError(`The ${current.kind} outcome is uncertain. Only the exact frozen operation may be retried; staff, resource, effect, and generation are locked.`);
      } else if (retrying) {
        setAttempt(current);
        setError(denied(caught)
          ? "Retry authorization was denied. The original operation outcome is still unresolved; the exact frozen operation remains locked."
          : "The retry did not reconcile the original operation. Its exact frozen body remains locked for a later retry.");
      } else {
        setAttempt(null); setReview(null);
        setError(denied(caught) ? "Owner authorization was denied. No further mutation was attempted; review again after access is restored."
          : "The operation was rejected. Review current scope before another explicit change.");
      }
    } finally { setBusy(false); }
  };

  const issue = async () => {
    if (!review || locked) return;
    const input: NativeBillingPermissionIssue = { operationId: newId(), grantId: newId(),
      expectedGeneration: review.generation, staffId: review.staffId, effect, resourceId: review.resourceId };
    if (!await confirmAction(`Issue ${input.effect} billing permission to staff ${input.staffId} for resource ${input.resourceId}?`)) return;
    void execute({ kind: "issue", input });
  };
  const revoke = async (grantId: string) => {
    if (!review || locked) return;
    const input: NativeBillingPermissionRevoke = { operationId: newId(), grantId,
      expectedGeneration: review.generation };
    if (!await confirmAction(`Revoke resource-scoped billing permission ${grantId} at generation ${input.expectedGeneration}?`)) return;
    void execute({ kind: "revoke", input });
  };

  return <main className="onboarding-staff-gate"><Card><h1>Operations-native billing permission delegation</h1>
    <p>This narrow staging tool delegates billing permission only for one exact resource. It does not bootstrap owner access, accept email identity, or expose global grants.</p>
    <form className="onboarding-staff-form" onSubmit={reviewScope}>
      <h2 className="wide">Review exact staff and resource</h2>
      <label>Exact native staff ID<input value={staffId} disabled={locked} onChange={event => change(setStaffId)(event.target.value)} /></label>
      <label>Exact operations resource ID<input value={resourceId} disabled={locked} onChange={event => change(setResourceId)(event.target.value)} /></label>
      <label>New resource permission effect<select value={effect} disabled={locked}
        onChange={event => { setEffect(event.target.value as typeof effect); invalidateReview(); }}>
        <option value="allow">Allow</option><option value="deny">Deny</option>
      </select></label>
      <button className="wide" type="submit" disabled={locked}>Review exact permission scope</button>
    </form>
    {review && <section className="onboarding-created" aria-labelledby="billing-permission-review-heading">
      <h2 id="billing-permission-review-heading">Current active resource permissions</h2>
      <p>Only unrevoked grants for this exact resource are shown. Global policy and revocation history are not exposed here.</p>
      <dl><div><dt>Staff ID</dt><dd>{review.staffId}</dd></div><div><dt>Resource ID</dt><dd>{review.resourceId}</dd></div>
        <div><dt>Expected generation</dt><dd>{review.generation}</dd></div><div><dt>Selected effect</dt><dd>{effect}</dd></div></dl>
      {review.permissions.length === 0 ? <p>No active billing permission grants were returned for this resource.</p> : <ul>
        {review.permissions.map(permission => <li key={permission.grantId}>
          <strong>{permission.effect}</strong> · Resource {permission.resourceId} · active · grant <code>{permission.grantId}</code>
          <button type="button" disabled={locked} onClick={() => revoke(permission.grantId)}>Revoke this resource grant</button>
        </li>)}
      </ul>}
      <button type="button" disabled={locked} onClick={issue}>Confirm exact resource grant</button>
    </section>}
    {attempt && <button type="button" disabled={busy} onClick={async () => {
      if (busy) return;
      if (await confirmAction(`Refresh CSRF and retry this exact frozen ${attempt.kind} operation?`)) void execute(attempt, true);
    }}>Retry same frozen {attempt.kind}</button>}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </Card></main>;
}
