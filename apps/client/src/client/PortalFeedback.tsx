import { useEffect, useRef, useState } from "react";
import { Card, StatusPill } from "@ltds/ui";
import { CLIENT_FEEDBACK_MESSAGE_LIMIT, type ClientFeedbackDetail, type ClientFeedbackItem, type ClientFeedbackTargetInput } from "@ltds/shared";
import type { RequestError } from "./bulk-download";
import { feedbackPath, feedbackStatusLabel, loadFeedback, loadFeedbackDetail, safeFeedbackTargetPath, submitFeedback } from "./feedback-api";
import "./PortalFeedback.css";

export function LeaveFeedback({ target, label, compact = false, nativeWorkspaceId = null }: { target: ClientFeedbackTargetInput; label: string; compact?: boolean; nativeWorkspaceId?: string | null }) {
  const [open, setOpen] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [saved, setSaved] = useState<ClientFeedbackItem | null>(null);
  const [invalidated, setInvalidated] = useState(false);
  const operation = useRef<{ key: string; message: string } | null>(null), pending = useRef<AbortController | null>(null);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const targetKey = JSON.stringify(target);
  useEffect(() => {
    setOpen(false); setMessage(""); setError(""); setBusy(false); setSaved(null); setInvalidated(false); operation.current = null;
    return () => { pending.current?.abort(); pending.current = null; };
  }, [targetKey]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  const close = () => { if (pending.current) return; setOpen(false); trigger.current?.focus(); };
  async function send() {
    if (pending.current || invalidated || !message.trim()) return;
    const current = operation.current ?? { key: crypto.randomUUID(), message: message.trim() };
    operation.current = current;
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError("");
    try {
      const result = await submitFeedback(target, current.message, current.key, controller.signal, nativeWorkspaceId);
      if (controller.signal.aborted || pending.current !== controller) return;
      setSaved(result); setOpen(false); setMessage(""); operation.current = null; trigger.current?.focus();
    } catch (caught) {
      if (controller.signal.aborted || pending.current !== controller) return;
      const status = (caught as RequestError).status;
      if ((caught as RequestError).body?.code === "feedback_target_unavailable") {
        setInvalidated(true); setError("Feedback is not available for this item until its client and project connection is configured. Refresh after the connection is ready."); return;
      }
      if (status === 400 || status === 429) operation.current = null;
      if ([401, 403, 404, 409, 410].includes(status ?? 0)) setInvalidated(true);
      setError([401, 403, 404, 409, 410].includes(status ?? 0) ? "This feedback target or your access changed. Refresh this page before submitting." : status === 429 ? "Too many submissions. Wait a moment before trying again." : status === 400 ? "Your feedback could not be accepted. Check the message and try again." : "We could not confirm your feedback was received. Retry to check the same submission.");
    } finally { if (!controller.signal.aborted && pending.current === controller) { pending.current = null; setBusy(false); } }
  }
  return <div className={`portal-feedback-entry${compact ? " is-compact" : ""}`} ref={root}>
    <button ref={trigger} type="button" className="button-ghost button-small" disabled={busy} aria-expanded={open} onClick={() => { setOpen(value => !value); setSaved(null); }}>Leave Feedback</button>
    {saved && <p role="status">Feedback sent. <a href={feedbackPath(saved.id)}>View feedback</a></p>}
    {open && <section className="portal-feedback-composer" aria-label={`Feedback about ${label}`} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
      <h3>Leave Feedback</h3><p><strong>About:</strong> {label}</p>
      <label>Your feedback<textarea ref={input} value={message} onChange={event => { if (!operation.current) setMessage(event.target.value); }} readOnly={Boolean(operation.current)} maxLength={CLIENT_FEEDBACK_MESSAGE_LIMIT} rows={4} /></label>
      <small>{message.length.toLocaleString()} / {CLIENT_FEEDBACK_MESSAGE_LIMIT.toLocaleString()} characters</small>
      {error && <p role="alert">{error}</p>}
      <div className="portal-feedback-actions"><button type="button" className="button-orange" disabled={busy || invalidated || !message.trim()} onClick={() => void send()}>{busy ? "Sending…" : operation.current ? "Retry submission" : "Send feedback"}</button><button type="button" className="button-ghost" disabled={busy} onClick={close}>Cancel</button></div>
    </section>}
  </div>;
}

export function PortalFeedback({ id, nativeWorkspaceId = null }: { id?: string | null; nativeWorkspaceId?: string | null }) {
  const [items, setItems] = useState<ClientFeedbackItem[]>([]), [detail, setDetail] = useState<ClientFeedbackDetail | null>(null);
  const [cursor, setCursor] = useState<string | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null), sequence = useRef(0);
  const retryCursor = useRef<string | null>(null);
  async function load(next: string | null = null) {
    if (next && pending.current) return;
    pending.current?.abort(); const controller = new AbortController(), run = ++sequence.current; pending.current = controller;
    setLoading(true); setError(""); retryCursor.current = next;
    try {
      const result = id ? await loadFeedbackDetail(id, controller.signal, nativeWorkspaceId) : await loadFeedback(next, controller.signal, nativeWorkspaceId);
      if (controller.signal.aborted || run !== sequence.current) return;
      if ("feedback" in result) setDetail(result);
      else { setItems(current => [...new Map((next ? [...current, ...result.items] : result.items).map(item => [item.id, item])).values()]); setCursor(result.nextCursor); }
    } catch (caught) {
      if (controller.signal.aborted || run !== sequence.current) return;
      if ([401, 403, 404, 409, 410].includes((caught as RequestError).status ?? 0)) { setItems([]); setDetail(null); setCursor(null); retryCursor.current = null; }
      setError("Feedback could not be loaded. Your access or the item may have changed.");
    } finally { if (!controller.signal.aborted && run === sequence.current) { pending.current = null; setLoading(false); } }
  }
  useEffect(() => { setItems([]); setDetail(null); setCursor(null); void load(); return () => { pending.current?.abort(); pending.current = null; sequence.current += 1; }; }, [id, nativeWorkspaceId]);
  return <div className="portal-feedback-page">
    <header><div><span className="eyebrow">Your feedback</span><h1>{id ? "Feedback details" : "Feedback"}</h1><p>Feedback you submitted in this workspace. Your team decides how best to handle it.</p></div>{id && <a className="button button-ghost" href={feedbackPath()}>All feedback</a>}</header>
    {error && <div className="portal-inline-error" role="alert"><p>{error}</p><button className="button-ghost" onClick={() => void load(retryCursor.current)}>Retry feedback</button></div>}
    {loading && <p role="status">Loading feedback…</p>}
    {detail && <Card title={detail.feedback.target.label}><FeedbackSummary item={detail.feedback} /><section className="portal-feedback-history" aria-label="Feedback history"><h3>Updates</h3>{detail.events.map(event => <article key={event.revision}><strong>{feedbackStatusLabel(event.status)}</strong><small>{new Date(event.createdAt).toLocaleString()} · {event.actor === "staff" ? "Your team" : "You"}</small>{event.note && <p>{event.note}</p>}</article>)}</section></Card>}
    {!id && <><div className="portal-feedback-list">{items.map(item => <Card key={item.id}><a href={feedbackPath(item.id)}><h2>{item.target.label}</h2></a><FeedbackSummary item={item} /></Card>)}</div>{!loading && !error && !items.length && <p>{cursor ? "No available feedback in this page. Continue to check more records." : "No feedback submitted yet. Use Leave Feedback on a project, folder, or file."}</p>}{cursor && <button className="button-ghost" disabled={loading} onClick={() => void load(cursor)}>Load more feedback</button>}</>}
  </div>;
}
function FeedbackSummary({ item }: { item: ClientFeedbackItem }) {
  const path = item.target.available ? safeFeedbackTargetPath(item.target.actionPath) : null;
  return <div className="portal-feedback-summary"><StatusPill tone={item.status === "done" ? "success" : "neutral"}>{feedbackStatusLabel(item.status)}</StatusPill><p>{item.message}</p>
    {item.completionNote && <div><strong>Completion note</strong><p>{item.completionNote}</p></div>}
    {path ? <a className="button button-ghost" href={path}>Open {item.target.kind}</a> : <p>The original item is no longer available in your current access.</p>}
  </div>;
}
