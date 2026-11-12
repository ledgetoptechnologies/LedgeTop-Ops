import { useEffect, useId, useRef, useState } from "react";
import { Card, EmptyState, SignInRecovery, StatusPill } from "@ltds/ui";
import { z } from "zod";
import { api, ApiError } from "./api";
import { confirmAction } from "./confirm-action";

/**
 * General requests: work a client asked about without a listed service (website, drone or anything else).
 * They go to Ledge Top's team, not to a business or account, and changing their status never creates a
 * client, project, access or anything financial.
 */
type InquiryStatus = "received" | "under_review" | "declined" | "closed";
const KIND_LABEL = { website: "Website work", drone: "Drone work", other: "Something else" } as const;
const STATUS_LABEL: Record<InquiryStatus, string> = { received: "Received", under_review: "Under review", declined: "Declined", closed: "Closed" };
const STATUS_TONE: Record<InquiryStatus, "neutral" | "success" | "warning" | "danger"> = { received: "warning", under_review: "neutral", declined: "danger", closed: "success" };
/** The status changes the server allows from each status, in the order they're offered. */
const NEXT: Record<InquiryStatus, { status: InquiryStatus; label: string }[]> = {
  received: [{ status: "under_review", label: "Start review" }, { status: "declined", label: "Decline" }],
  under_review: [{ status: "closed", label: "Mark done" }, { status: "declined", label: "Decline" }],
  declined: [{ status: "closed", label: "Close" }],
  closed: [],
};

const inquirySchema = z.object({
  id: z.string().min(1).max(512),
  kind: z.enum(["website", "drone", "other"]),
  title: z.string().min(1).max(300),
  details: z.string().max(10000),
  location: z.string().max(300).nullable().optional(),
  status: z.enum(["received", "under_review", "declined", "closed"]),
  createdAt: z.string().refine(value => Number.isFinite(Date.parse(value)), "Invalid date"),
});
const pageSchema = z.object({ items: z.array(inquirySchema).max(100), nextCursor: z.string().min(1).max(4096).nullable() });
export type StaffInquiry = z.infer<typeof inquirySchema>;

const OPEN = new Set<InquiryStatus>(["received", "under_review"]);

function loadError(caught: unknown): string {
  if (caught instanceof ApiError && caught.status === 401) return "Your session ended. Sign in again to see general requests.";
  if (caught instanceof ApiError && caught.status === 403) return "You no longer have access to general requests.";
  return "General requests couldn't be loaded right now.";
}

/** The open general-request queue for the Client Hub. Shows nothing where the server doesn't offer it yet. */
export function ClientInquiryQueue({ hideWhenEmpty = false }: { hideWhenEmpty?: boolean }) {
  // undefined: loading; null: not offered here.
  const [items, setItems] = useState<StaffInquiry[] | null | undefined>(undefined);
  const [cursor, setCursor] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [authFailure, setAuthFailure] = useState<401 | 403 | null>(null);
  const [open, setOpen] = useState<StaffInquiry | null>(null), [notice, setNotice] = useState("");
  const section = useRef<HTMLElement | null>(null), run = useRef(0);

  const load = async (next: string | null = null) => {
    const current = ++run.current;
    setBusy(true); setError(""); setAuthFailure(null);
    try {
      const params = new URLSearchParams();
      if (next) params.set("cursor", next);
      const page = pageSchema.parse(await api<unknown>(`/api/operations/inbox/inquiries${params.size ? `?${params}` : ""}`));
      if (current !== run.current) return;
      if (next && page.nextCursor === next) throw new Error("Non-advancing cursor");
      const fresh = page.items.filter(item => OPEN.has(item.status));
      setItems(previous => next ? [...new Map([...(previous ?? []), ...fresh].map(item => [item.id, item])).values()] : fresh);
      setCursor(page.nextCursor);
    } catch (caught) {
      if (current !== run.current) return;
      if (caught instanceof ApiError && (caught.status === 404 || caught.status === 405)) { setItems(null); return; }
      setError(loadError(caught));
      if (caught instanceof ApiError && (caught.status === 401 || caught.status === 403)) {
        setAuthFailure(caught.status); setItems([]); setCursor(null);
      } else if (!next) setItems(previous => previous ?? []);
    } finally { if (current === run.current) setBusy(false); }
  };
  useEffect(() => { void load(); return () => { run.current++; }; }, []);
  // A notification email links here with ?source=inquiries; bring the queue into view once it has loaded.
  useEffect(() => {
    if (items && new URLSearchParams(location.search).get("source") === "inquiries") section.current?.scrollIntoView({ block: "start" });
  }, [items !== undefined && items !== null]);

  const changed = (inquiry: StaffInquiry, status: InquiryStatus) => {
    setOpen(null);
    setNotice(`“${inquiry.title}” is now ${STATUS_LABEL[status].toLowerCase()}.`);
    setItems(previous => (previous ?? []).flatMap(item => item.id !== inquiry.id ? [item] : OPEN.has(status) ? [{ ...item, status }] : []));
  };

  if (items === null || items === undefined) return null;
  // Followed from a notification, the queue always shows, even once it's empty, so the link never lands nowhere.
  const linked = new URLSearchParams(location.search).get("source") === "inquiries";
  if (hideWhenEmpty && !linked && !items.length && !error && !notice) return null;
  return <section ref={section} id="general-requests" className="client-inquiry-queue" aria-label="General requests">
    <Card title="General requests">
      <p className="client-inquiry-intro">Website, drone and other work clients asked about without a listed service. Reviewing one doesn’t create a client, project or access.</p>
      {notice && <p className="notice" role="status">{notice}</p>}
      {error && <div className="notice error" role="alert"><p>{error}</p>{authFailure
        ? <SignInRecovery returnTo="/" lead={authFailure === 401 ? "again" : "different"} onRetry={() => void load()} />
        : <button type="button" className="button-ghost button-small" disabled={busy} onClick={() => void load()}>Try again</button>}</div>}
      {items.length ? <div className="client-request-review-list">{items.map(item => <article key={item.id}>
        <div>
          <strong>{item.title}</strong>
          <small>{[KIND_LABEL[item.kind], item.location].filter(Boolean).join(" · ")}</small>
          <p className="client-inquiry-preview">{item.details}</p>
          <small>Sent {new Date(item.createdAt).toLocaleString()}</small>
        </div>
        <div>
          <StatusPill tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</StatusPill>
          <button type="button" className="button-orange button-small" aria-label={`Review ${item.title}`} onClick={() => { setNotice(""); setOpen(item); }}>Review</button>
        </div>
      </article>)}</div>
        : !error && <EmptyState title="No open general requests" detail="New general requests from clients will appear here." />}
      {cursor && <button type="button" className="button-ghost button-small" disabled={busy} onClick={() => void load(cursor)}>Load more general requests</button>}
    </Card>
    {open && <InquiryReview inquiry={open} onClose={() => setOpen(null)} onChanged={status => changed(open, status)} />}
  </section>;
}

function InquiryReview({ inquiry, onClose, onChanged }: { inquiry: StaffInquiry; onClose: () => void; onChanged: (status: InquiryStatus) => void }) {
  const dialog = useRef<HTMLDialogElement | null>(null), titleId = useId();
  const [saving, setSaving] = useState<InquiryStatus | null>(null), [error, setError] = useState("");
  const [authFailure, setAuthFailure] = useState<401 | 403 | null>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) { try { element.showModal(); } catch { element.setAttribute("open", ""); } }
  }, []);
  const change = async (status: InquiryStatus) => {
    if (saving) return;
    if (status === "declined" && !await confirmAction(`Decline “${inquiry.title}”? The client will see it as declined.`)) return;
    setSaving(status); setError(""); setAuthFailure(null);
    try {
      await api(`/api/operations/inbox/inquiries/${encodeURIComponent(inquiry.id)}`, { method: "PATCH", body: JSON.stringify({ status }) });
      onChanged(status);
    } catch (caught) {
      const code = caught instanceof ApiError ? caught.status : 0;
      setAuthFailure(code === 401 || code === 403 ? code : null);
      setError(code === 401 ? "Your session ended. Sign in again, then try this change again."
        : code === 403 ? "You no longer have access to change this request."
        : code === 404 ? "This request is no longer available. Refresh the page to see the current queue."
        : code === 409 ? "Someone else already changed this request. Refresh the page to see its current status."
        : "The status couldn’t be changed. Try again.");
    } finally { setSaving(null); }
  };
  return <dialog ref={dialog} className="client-inquiry-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
    <header>
      <div><span className="eyebrow">General request · {KIND_LABEL[inquiry.kind]}</span><h2 id={titleId}>{inquiry.title}</h2></div>
      <button type="button" className="button-ghost button-small" disabled={saving !== null} onClick={onClose}>Close</button>
    </header>
    <dl className="client-inquiry-facts">
      <div><dt>Kind of work</dt><dd>{KIND_LABEL[inquiry.kind]}</dd></div>
      <div><dt>Status</dt><dd><StatusPill tone={STATUS_TONE[inquiry.status]}>{STATUS_LABEL[inquiry.status]}</StatusPill></dd></div>
      <div><dt>Sent</dt><dd>{new Date(inquiry.createdAt).toLocaleString()}</dd></div>
      {inquiry.location && <div><dt>Location</dt><dd>{inquiry.location}</dd></div>}
    </dl>
    <h3>What they need</h3>
    <p className="client-inquiry-details">{inquiry.details}</p>
    {error && <div className="notice error" role="alert"><p>{error}</p>{authFailure &&
      <SignInRecovery returnTo="/" lead={authFailure === 401 ? "again" : "different"} />}</div>}
    <div className="client-inquiry-actions">{NEXT[inquiry.status].map(next =>
      <button key={next.status} type="button" className={next.status === "declined" ? "button-ghost" : "button-orange"} disabled={saving !== null}
        onClick={() => void change(next.status)}>{saving === next.status ? "Saving…" : next.label}</button>)}
    </div>
  </dialog>;
}
