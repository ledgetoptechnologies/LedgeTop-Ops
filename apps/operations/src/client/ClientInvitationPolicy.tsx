import { useEffect, useRef, useState } from "react";
import { Card } from "@ltds/ui";
import { ApiError } from "./api";
import { loadInvitationPolicy, policyLabels, saveInvitationPolicy, type InvitationPolicy } from "./invitation-administration-api";
import "./InvitationAdministration.css";

export function ClientInvitationPolicy({workspaceId, sourceId, contextSignal, onInvalidated}: {workspaceId: string; sourceId: string; contextSignal: AbortSignal; onInvalidated: (message: string) => void}) {
  const [opened, setOpened] = useState(false), [value, setValue] = useState<InvitationPolicy | null>(null), [selected, setSelected] = useState<InvitationPolicy["policy"]>("allowed");
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [review, setReview] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [uncertain, setUncertain] = useState(false), controller = useRef<AbortController | null>(null), epoch = useRef(0);
  const pending = useRef<{current: InvitationPolicy; policy: InvitationPolicy["policy"]; key: string} | null>(null);
  const invalidated = useRef(onInvalidated); invalidated.current = onInvalidated;
  useEffect(() => {const abort = () => {epoch.current++; controller.current?.abort();}; contextSignal.addEventListener("abort", abort); return () => {abort(); contextSignal.removeEventListener("abort", abort);};}, [contextSignal]);
  function failure(caught: unknown) {
    if (caught instanceof ApiError && [401, 403, 404, 409, 410].includes(caught.status)) {
      setValue(null); setReview(false); pending.current = null; setUncertain(false);
      invalidated.current("Invitation policy or your access changed. Refresh the client workspace before reviewing another change.");
    } else setError("Invitation policy could not be loaded. Retry when ready.");
  }
  async function load() {
    if (contextSignal.aborted || pending.current) return;
    controller.current?.abort(); const request = new AbortController(), run = ++epoch.current; controller.current = request;
    setOpened(true); setLoading(true); setError(""); setValue(null); setReview(false);
    try {const result = await loadInvitationPolicy(workspaceId, sourceId, request.signal); if (!request.signal.aborted && !contextSignal.aborted && run === epoch.current) {setValue(result); setSelected(result.policy);}}
    catch (caught) {if (!request.signal.aborted && !contextSignal.aborted && run === epoch.current) failure(caught);}
    finally {if (!request.signal.aborted && !contextSignal.aborted && run === epoch.current) {controller.current = null; setLoading(false);}}
  }
  async function save() {
    if (!value?.capabilities.canManagePolicy || busy || contextSignal.aborted) return;
    const operation = pending.current ?? {current: value, policy: selected, key: crypto.randomUUID()}; pending.current = operation;
    controller.current?.abort(); const request = new AbortController(), run = ++epoch.current; controller.current = request; setBusy(true); setError("");
    try {const result = await saveInvitationPolicy(operation.current, operation.policy, operation.key, request.signal);
      if (!request.signal.aborted && !contextSignal.aborted && run === epoch.current) {pending.current = null; setUncertain(false); setReview(false); setValue(result); setSelected(result.policy); setNotice("Invitation policy saved. Existing accepted access was not revoked.");}
    } catch (caught) {if (!request.signal.aborted && !contextSignal.aborted && run === epoch.current) {
      if (caught instanceof ApiError && [400, 401, 403, 404, 409, 410].includes(caught.status)) {pending.current = null; setUncertain(false); if (caught.status === 400) {setReview(false); setError(caught.message);} else failure(caught);}
      else {setUncertain(true); setError("The policy change is not confirmed. Retry the same change before making another.");}
    }} finally {if (!request.signal.aborted && !contextSignal.aborted && run === epoch.current) {controller.current = null; setBusy(false);}}
  }
  return <Card title="Invitation policy" className="invitation-administration">
    <p>Control new collaborator invitations for this exact portal workspace. Business records and accepted memberships are separate.</p>
    {!opened ? <button className="button-ghost" onClick={() => void load()}>Show invitation policy</button> : <>
      {loading && <p role="status">Loading invitation policy…</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
      {!uncertain && <button className="button-ghost" disabled={loading || busy} onClick={() => void load()}>Refresh invitation policy</button>}
      {value && <><p><strong>{value.workspaceName}</strong> · {value.sourceId}</p><p>Current policy: <strong>{policyLabels[value.policy]}</strong></p>
        {value.capabilities.canManagePolicy ? <><label>Invitation policy<select value={selected} disabled={busy || uncertain || review} onChange={event => {setSelected(event.target.value as InvitationPolicy["policy"]); setNotice("");}}>{Object.entries(policyLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          {!review && <button className="button-orange" disabled={busy || selected === value.policy} onClick={() => {setReview(true); setError("");}}>Review policy change</button>}
          {review && <section className="invitation-administration-confirm" aria-label="Confirm invitation policy"><h3>Change policy to {policyLabels[selected]}?</h3><p>{value.workspaceName} · {value.sourceId}</p><p>New invitations will follow this policy. Pending sign-in links may no longer be accepted. This does not revoke existing accepted access or change another workspace.</p><div className="invitation-administration-actions"><button className="button-orange" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : uncertain ? "Retry policy change" : "Confirm policy change"}</button><button className="button-ghost" disabled={busy || uncertain} onClick={() => setReview(false)}>Cancel</button></div></section>}
        </> : <p>Administrator policy-management access is required to change this setting.</p>}
      </>}
    </>}
  </Card>;
}
