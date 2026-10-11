import { useEffect, useState, type FormEvent } from "react";
import { Card, Loading } from "@ltds/ui";
import { DirectoryMaintenanceApiError, executeDirectoryMaintenance, readDirectoryMaintenanceSession,
  reviewDirectoryMaintenance, type DirectoryMaintenanceAttempt, type DirectoryMaintenanceReview,
  type DirectoryMaintenanceResult } from "./operations-directory-maintenance-api";
import { confirmAction } from "./confirm-action";
import "./ClientOnboardingStaff.css";

type Session = Awaited<ReturnType<typeof readDirectoryMaintenanceSession>>;
const denied = (error: unknown) => error instanceof DirectoryMaintenanceApiError
  && [400, 401, 403, 404, 409, 410].includes(error.status) && !error.uncertain;

export function OperationsDirectoryMaintenance() {
  const [session, setSession] = useState<Session | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let mounted = true;
    void readDirectoryMaintenanceSession().then(value => { if (mounted) setSession(value); })
      .catch(() => { if (mounted) setUnavailable(true); });
    return () => { mounted = false; };
  }, []);
  if (unavailable) return <main className="onboarding-staff-gate"><Card>
    <h1>Directory maintenance unavailable</h1>
    <p role="alert">This staging-only owner capability is unavailable or access was denied.</p>
  </Card></main>;
  if (!session) return <main className="onboarding-staff-gate"><Loading /></main>;
  return <DirectoryMaintenanceWorkspace initialSession={session} />;
}

function DirectoryMaintenanceWorkspace({ initialSession }: { initialSession: Session }) {
  const [session, setSession] = useState(initialSession);
  const [review, setReview] = useState<DirectoryMaintenanceReview | null>(null);
  const [approvalId, setApprovalId] = useState("");
  const [attempt, setAttempt] = useState<DirectoryMaintenanceAttempt | null>(null);
  const [result, setResult] = useState<DirectoryMaintenanceResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const locked = busy || attempt !== null;

  const loadReview = async () => {
    if (locked) return;
    setBusy(true); setReview(null); setResult(null); setMessage(""); setError("");
    try {
      const value = await reviewDirectoryMaintenance(session.csrfToken);
      setReview(value);
      setMessage("Private canonical plan reviewed. Download it explicitly for independent approval; this review does not install an approval or grant permission.");
    } catch (caught) {
      setError(denied(caught) ? "The review was denied. No authority changed."
        : "The private review is unavailable. No authority changed.");
    } finally { setBusy(false); }
  };

  const downloadReview = () => {
    if (!review || locked) return;
    const blob = new Blob([JSON.stringify({ plan: review.plan, planSha256: review.planSha256,
      independentBindingVerificationSha256: review.independentBindingVerificationSha256 }, null, 2)],
      { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `staging-directory-maintenance-${review.commandId}.private.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const runAttempt = async (frozen: DirectoryMaintenanceAttempt, retrying = false) => {
    setBusy(true); setError(""); setMessage("");
    try {
      const activeSession = retrying ? await readDirectoryMaintenanceSession() : session;
      if (retrying) setSession(activeSession);
      const outcome = await executeDirectoryMaintenance(activeSession.csrfToken, frozen);
      setResult(outcome); setAttempt(null); setReview(null);
      setMessage(outcome.status === "replayed" ? "The exact maintenance command was replayed."
        : "The exact maintenance command was applied.");
    } catch (caught) {
      if (retrying || !denied(caught)) {
        // A network or malformed response cannot establish whether execution committed.
        // Preserve the exact approval, command, and plan hash until authoritative replay.
        setAttempt(frozen);
        setError("Outcome uncertain. Retry only this frozen command; do not obtain a new command or change the approval ID.");
      } else {
        setAttempt(null); setReview(null);
        setError("The command was rejected or access was denied. Re-review before any new attempt.");
      }
    } finally { setBusy(false); }
  };

  const confirmExecute = async (event: FormEvent) => {
    event.preventDefault();
    if (!review || locked) return;
    const installedApprovalId = approvalId.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(installedApprovalId)) {
      setError("Enter the exact preinstalled approval ID."); return;
    }
    const frozen = { approvalId: installedApprovalId, commandId: review.commandId,
      planSha256: review.planSha256 };
    if (!await confirmAction("Execute the exact preinstalled staging maintenance approval for this reviewed plan hash?")) return;
    setAttempt(frozen);
    void runAttempt(frozen);
  };

  return <main className="onboarding-staff-gate"><Card>
    <h1>Staging directory maintenance authority</h1>
    <p>This narrow maintenance tool is staging-only. A review does not install an approval. The browser cannot create an approval or select a different target.</p>
    <button type="button" disabled={locked} onClick={() => { void loadReview(); }}>Review server-derived plan</button>
    {review && <section className="onboarding-created" aria-labelledby="maintenance-review-heading">
      <h2 id="maintenance-review-heading">Redacted review summary</h2>
      <dl>
        <div><dt>Target</dt><dd>Exact Operations staging Worker and database</dd></div>
        <div><dt>Plan SHA-256</dt><dd>{review.planSha256}</dd></div>
        <div><dt>Independent binding verification SHA-256</dt><dd>{review.independentBindingVerificationSha256}</dd></div>
        <div><dt>Snapshot rows</dt><dd>{review.snapshotRows}</dd></div>
      </dl>
      <p>The private plan includes staff details and must be handled as restricted evidence. It is not displayed on this page.</p>
      <button type="button" disabled={locked} onClick={downloadReview}>Download private plan JSON</button>
      <form className="onboarding-staff-form" onSubmit={confirmExecute}>
        <label>Exact preinstalled approval ID<input value={approvalId} disabled={locked}
          onChange={event => setApprovalId(event.target.value)} /></label>
        <button type="submit" disabled={locked}>Confirm exact approved execution</button>
      </form>
    </section>}
    {attempt && <section className="onboarding-created" aria-labelledby="maintenance-uncertain-heading">
      <h2 id="maintenance-uncertain-heading">Frozen command</h2>
      <p>The approval ID, command ID, and plan hash remain frozen. Do not submit a new command while this outcome is uncertain.</p>
      <button type="button" disabled={busy} onClick={async () => {
        if (busy) return;
        if (await confirmAction("Retry only the exact frozen maintenance command?")) void runAttempt(attempt, true);
      }}>Retry exact frozen command</button>
    </section>}
    {result && <p role="status">{result.status === "replayed" ? "Replayed" : "Applied"}: grant {result.grantId}, generation {result.resultingGeneration}.</p>}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </Card></main>;
}
