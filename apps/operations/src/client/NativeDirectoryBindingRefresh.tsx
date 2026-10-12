import { useEffect, useRef, useState } from "react";
import { Card } from "@ltds/ui";
import { api } from "./api";
import { confirmAction } from "./confirm-action";

type Review = Readonly<{ commandId: string; recordId: string; sourceId: string; localVersion: number;
  priorRevision: string; liveRevision: string }>;
type RecoveryReview=Review&Readonly<{supersededCommandId:string;capturedAttempts:number}>;
type RecoveryCandidate=Review&Readonly<{recoveryCandidate:true;capturedAttempts:number}>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const revision = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)
  && (value.length < 19 || value <= "9223372036854775807");
function validReview(value: unknown, recordId: string, sourceId: string): value is Review {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.commandId === "string" && UUID.test(row.commandId) && row.recordId === recordId
    && row.sourceId === sourceId && Number.isSafeInteger(row.localVersion) && Number(row.localVersion) > 0
    && revision(row.priorRevision) && revision(row.liveRevision)
    && (row.liveRevision.length > row.priorRevision.length
      || row.liveRevision.length === row.priorRevision.length && row.liveRevision > row.priorRevision);
}
function validRecoveryReview(value:unknown,recordId:string,sourceId:string):value is RecoveryReview{
  if(!validReview(value,recordId,sourceId))return false;const row=value as Record<string,unknown>;
  return typeof row.supersededCommandId==='string'&&UUID.test(row.supersededCommandId)&&row.supersededCommandId!==row.commandId
    &&Number.isSafeInteger(row.capturedAttempts)&&Number(row.capturedAttempts)>0;
}
function validRecoveryCandidate(value:unknown,recordId:string,sourceId:string):value is RecoveryCandidate{
  if(!validReview(value,recordId,sourceId))return false;const row=value as Record<string,unknown>;
  return row.recoveryCandidate===true&&Number.isSafeInteger(row.capturedAttempts)&&Number(row.capturedAttempts)>0;
}

export function NativeDirectoryBindingRefresh({ enabled = false,recoveryEnabled=false, recordId, sourceId }: {
  enabled?: boolean;recoveryEnabled?:boolean; recordId: string; sourceId: string;
}) {
  return enabled ? <BindingRefreshBound key={`${sourceId}\0${recordId}`} recordId={recordId} sourceId={sourceId} recoveryEnabled={recoveryEnabled} /> : null;
}

function BindingRefreshBound({ recordId, sourceId,recoveryEnabled }: { recordId: string; sourceId: string;recoveryEnabled:boolean }) {
  const [review, setReview] = useState<Review|RecoveryReview|RecoveryCandidate|null>(null), [uncertain, setUncertain] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const claimed = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const loadReview = async () => {
    if (claimed.current || uncertain) return;
    claimed.current = true; setBusy(true); setError(""); setMessage(""); setReview(null);
    try {
      const value = await api<unknown>("/api/client-hub/directory/binding-revisions/review", {
        method: "POST", body: JSON.stringify({ recordId, sourceId }),
      });
      if (!validReview(value, recordId, sourceId)) throw new Error("invalid review");
      if (mounted.current) {setReview(Object.freeze({ ...value }));setUncertain(validRecoveryCandidate(value,recordId,sourceId));}
    } catch {
      if (mounted.current) setError("The binding revision review is unavailable. No Project Alpha refresh was requested.");
    } finally { claimed.current = false; if (mounted.current) setBusy(false); }
  };
  const recover=async()=>{
    if(claimed.current||!review||!uncertain||!recoveryEnabled||'supersededCommandId' in review)return;
    claimed.current=true;const frozen=review;
    try{
      if(!await confirmAction(`Reconcile the uncertain command ${frozen.commandId} without retrying it? Only a locked Project Alpha terminal conflict can create one reviewed successor.`)||!mounted.current)return;
      setBusy(true);setError('');setMessage('');
      const value=await api<unknown>('/api/client-hub/directory/binding-revisions/recovery-review',{method:'POST',body:JSON.stringify({commandId:frozen.commandId,confirm:true})});
      if(!validRecoveryReview(value,recordId,sourceId)||value.supersededCommandId!==frozen.commandId)throw new Error('invalid recovery review');
      if(mounted.current){setReview(Object.freeze({...value}));setUncertain(false);setMessage('Project Alpha proved the old command terminal without a receipt. Review the one successor before confirming it.');}
    }catch{if(mounted.current)setError('Terminal reconciliation was unavailable or its response was lost. The old frozen command was not retried; repeat this review or reload to recover the same successor.');}
    finally{claimed.current=false;if(mounted.current)setBusy(false);}
  };
  const execute = async () => {
    if (claimed.current || !review) return;
    claimed.current = true;
    const frozen = review;
    try {
      if (!await confirmAction(`Refresh only the reviewed directory binding from revision ${frozen.priorRevision} to ${frozen.liveRevision}? This does not change the profile or grant new access.`)
        || !mounted.current) return;
      setBusy(true); setError(""); setMessage("");
      // A lost or unverifiable response cannot release this exact server-owned command.
      setUncertain(true);
      const value = await api<unknown>(`/api/client-hub/directory/binding-revisions/${'supersededCommandId' in frozen?'recovery-execute':'execute'}`, {
        method: "POST", body: JSON.stringify({ commandId: frozen.commandId, confirm: true }),
      });
      if (!mounted.current) return;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid result");
      const result = value as Record<string, unknown>;
      if (result.commandId !== frozen.commandId) throw new Error("wrong command");
      if (result.status === "acknowledged") {
        if (result.revision !== frozen.liveRevision) throw new Error("wrong revision");
        setUncertain(false); setReview(null); setMessage("The reviewed binding revision refresh was acknowledged. Refresh normal directory inventory before using the updated binding.");
      } else if ((result.status === "blocked" || result.status === "uncertain") && result.reason === "refresh_capability_unavailable"
        && result.frozenCommandRetained === true && result.latestAttemptSent === false) {
        // This invocation sent no PA write; any earlier outcome stays unresolved.
        setUncertain(true);
        setError("Project Alpha binding refresh capability is unavailable. This invocation sent no refresh write. Keep this frozen command; retry only the same command. Earlier outcomes, if any, remain unresolved.");
      } else if (result.status === "blocked" || result.status === "conflict") {
        setUncertain(false); setReview(null);
        setError("The frozen binding refresh was blocked or its review is stale. Review current state before another request.");
      } else throw new Error("unresolved result");
    } catch {
      if (mounted.current) setError("The binding refresh outcome is uncertain. Retry only the same frozen command; do not prepare a replacement.");
    } finally { claimed.current = false; if (mounted.current) setBusy(false); }
  };
  return <Card title="Directory binding revision">
    <p>Review an existing Project Alpha binding before refreshing its revision. Review reserves a server-owned command but does not send a Project Alpha write.</p>
    {!review && <button type="button" className="button-ghost" disabled={busy} onClick={() => void loadReview()}>Review binding revision</button>}
    {review && <section aria-label="Reviewed binding revision">
      <dl><dt>Local profile version</dt><dd>{review.localVersion}</dd>
        <dt>Prior binding revision</dt><dd>{review.priorRevision}</dd><dt>Live resource revision</dt><dd>{review.liveRevision}</dd>
        <dt>Frozen command</dt><dd><code>{review.commandId}</code></dd></dl>
      <p>{'recoveryCandidate' in review ? "Project Alpha's generation advanced while this command remained uncertain. Do not retry it; use read-only terminal reconciliation."
        : uncertain ? "The outcome is uncertain. Only this exact frozen command may be retried."
        : "This refresh changes only the existing binding revision, not the client profile or access grants."}</p>
      {!('recoveryCandidate' in review)&&<button type="button" className="button-orange" disabled={busy} onClick={() => void execute()}>
        {busy ? "Waiting for confirmation or refresh…" : uncertain ? "Retry same binding refresh" : 'supersededCommandId' in review ? "Confirm reviewed successor" : "Confirm binding revision refresh"}
      </button>}
      {uncertain&&recoveryEnabled&&!('supersededCommandId' in review)&&<button type="button" className="button-ghost" disabled={busy} onClick={()=>void recover()}>Review terminal conflict without retry</button>}
    </section>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </Card>;
}
