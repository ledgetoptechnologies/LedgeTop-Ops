import { useEffect, useState } from "react";
import { Card } from "@ltds/ui";
import { api } from "./api";

const PATH = "/api/client-hub/shared-profiles/authority-recovery";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
type Status = { available: boolean; pendingHeads: number; bulkPending: boolean;
  activeRecovery: { operationId: string; state: string } | null };
type Attempt = { operationId: string; body: string };
function validStatus(value: unknown): value is Status {
  if (!value || typeof value !== "object") return false;
  const v = value as Status;
  return typeof v.available === "boolean" && Number.isSafeInteger(v.pendingHeads) && v.pendingHeads >= 0
    && typeof v.bulkPending === "boolean" && (v.activeRecovery === null || !!v.activeRecovery
      && typeof v.activeRecovery.operationId === "string" && UUID.test(v.activeRecovery.operationId)
      && v.activeRecovery.state === "pending");
}
/** Owner-only mount. Clears interrupted authority fences; grants no access. */
export function SharedProfileAuthorityRecovery() {
  const [status, setStatus] = useState<Status | null>(null), [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [completed, setCompleted] = useState(false);
  useEffect(() => {
    let live = true;
    void api<unknown>(PATH).then(value => { if (live && validStatus(value) && value.available) setStatus(value); }).catch(() => {});
    return () => { live = false; };
  }, []);
  if (!status || !(status.pendingHeads > 0 || status.bulkPending || status.activeRecovery)) return null;
  const recover = async () => {
    if (busy || completed) return;
    const operationId = attempt?.operationId ?? status.activeRecovery?.operationId ?? crypto.randomUUID();
    const current = attempt ?? { operationId, body: JSON.stringify({ operationId }) };
    setAttempt(current); setBusy(true); setError(false);
    try {
      const value = await api<{ ok?: boolean; operationId?: string; state?: string; pendingHeads?: number }>(PATH, {
        method: "POST", headers: { "Idempotency-Key": current.operationId }, body: current.body,
      });
      if (value?.operationId !== current.operationId || value.ok !== true
        || !["completed", "pending"].includes(value.state ?? "") || !Number.isSafeInteger(value.pendingHeads) || value.pendingHeads! < 0
        || value.state === "completed" && value.pendingHeads !== 0)
        throw new Error("Unverified recovery acknowledgement");
      if (value.state === "completed") setCompleted(true);
      else setError(true);
    } catch { setError(true); } finally { setBusy(false); }
  };
  return <Card title="Profile editing recovery">
    <p>An interrupted access change is blocking profile editing.</p>
    <p>Recovery does not replay access changes. Review current state and retry the intended change.</p>
    {status.pendingHeads > 0 && <p>{status.pendingHeads} profile editing {status.pendingHeads === 1 ? "workspace needs" : "workspaces need"} review.</p>}
    {status.bulkPending && <p>A source or identity transition is waiting for recovery.</p>}
    {error && <p role="alert">Recovery could not be confirmed. Retry keeps the same recovery request.</p>}
    {completed ? <p role="status">Recovery completed. Review current state and retry the intended change.</p>
      : <button type="button" className="button-orange" disabled={busy} onClick={() => void recover()}>
        {busy ? "Recovering..." : attempt ? "Retry same profile editing recovery" : "Recover blocked profile editing"}
      </button>}
  </Card>;
}
