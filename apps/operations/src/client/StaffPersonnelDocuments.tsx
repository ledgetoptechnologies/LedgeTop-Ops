import { useEffect, useRef, useState } from "react";
import { Dialog, EmptyState, StatusPill } from "@ltds/ui";
import "./StaffPersonnelDocuments.css";

/**
 * Private employee documents (agreements, tax forms, onboarding). Admin-only, separate from every client upload path:
 * requests go only to /api/staff-personnel with their own CSRF token. Records are archived, never deleted.
 */

type Capability = "staff.documents.read" | "staff.documents.upload" | "staff.documents.manage" | "staff.profile.archive" | "staff.profile.restore";
type Retention = { hold: boolean; reviewAfter: string | null; reviewNote: string; version: number };
export type PersonnelDocument = {
  id: string; staffId: string; filename: string; category: Category; contentType: string; size: number;
  status: "uploading" | "quarantined" | "accepted" | "rejected"; createdAt: string; retention: Retention;
  /** Scanner progress for quarantined files; absent on older records. */
  scan?: { state: "pending" | "leased" | "completed" | "manual_review"; attempts: number; retryAfter: string | null; errorCode: string | null } | null;
};
type Category = "agreement" | "tax" | "onboarding" | "other";
type Listing = { profile: { archived_at: string | null; version: number } | null; documents: PersonnelDocument[] };
type Person = { id: string; display_name: string; email: string };

const BASE = "/api/staff-personnel/profiles/";
const MAX_BYTES = 25 * 1024 * 1024;
export const CATEGORY_LABELS: Record<Category, string> = {
  agreement: "Agreement or noncompete", tax: "Tax form (W-4, W-9, 1099)", onboarding: "Onboarding", other: "Other",
};
const TYPES: Record<string, string> = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", txt: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const ACCEPT = Object.keys(TYPES).map(extension => "." + extension).join(",");

/** Plain words for every server refusal; never the raw code. */
const PROBLEMS: Record<string, string> = {
  personnel_denied: "You don't have permission for this person's documents.",
  not_found: "Employee documents aren't turned on yet, or this record no longer exists.",
  personnel_unavailable: "Employee documents are unavailable right now. Try again shortly.",
  personnel_storage_unavailable: "Document storage isn't set up yet, so nothing can be uploaded or opened.",
  document_too_large: "That file is over 25 MB.",
  empty_document: "That file is empty.",
  unsupported_document: "That file type isn't accepted, or the file doesn't match its extension. Use PDF, JPG, PNG, DOCX, XLSX or TXT.",
  invalid_filename: "Rename the file (no slashes or hidden characters, up to 160 characters) and try again.",
  invalid_category: "Choose a document type.",
  document_not_accepted: "This document hasn't passed its virus scan, so it can't be opened.",
  document_integrity_conflict: "This document's stored copy doesn't match its record, so it won't be opened. Contact your administrator.",
  version_conflict: "Someone else changed this record. It has been refreshed; review it and try again.",
  command_conflict: "A different change already used this request. Refresh and try again.",
  personnel_self_archive_denied: "You can't archive your own profile.",
  upload_in_progress: "This upload is still being saved. Wait a moment, then retry the same upload.",
  invalid_request: "That change wasn't accepted. Check the fields and try again.",
};
const problem = (code: string | undefined, status: number) => (code && PROBLEMS[code]) || `The request failed (${status}).`;

class PersonnelError extends Error {
  constructor(readonly status: number, readonly code: string | undefined) { super(problem(code, status)); }
  /** A definite refusal; resending the same request won't change it. */
  get definite() { return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429; }
}

async function call(path: string, init: RequestInit & { csrf?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("X-Personnel-Request", "1");
  if (init.csrf) headers.set("X-CSRF-Token", init.csrf);
  const response = await fetch(BASE + path, { ...init, credentials: "same-origin", headers, redirect: "error" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new PersonnelError(response.status, payload.error);
  }
  return response;
}

export function fileSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
const day = (value: string) => new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

function statusPill(document: PersonnelDocument) {
  switch (document.status) {
    case "accepted": return <StatusPill tone="success">Ready</StatusPill>;
    case "quarantined":
      if (document.scan?.state === "manual_review") return <StatusPill tone="danger">Scan needs attention</StatusPill>;
      if (document.scan?.state === "leased") return <StatusPill tone="warning">Scanning now</StatusPill>;
      if (document.scan?.state === "pending" && document.scan.attempts > 0) return <StatusPill tone="warning">Scan will retry</StatusPill>;
      return <StatusPill tone="warning">Waiting for virus scan</StatusPill>;
    case "rejected": return <StatusPill tone="danger">Blocked by virus scan</StatusPill>;
    default: return <StatusPill tone="warning">Upload not finished</StatusPill>;
  }
}

/** The Documents button on a staff card; opens the private panel for that person. */
export function StaffDocumentsButton({ person, self }: { person: Person; self: boolean }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="button-ghost button-small" onClick={() => setOpen(true)}>Documents</button>
    {open && <StaffPersonnelDocuments person={person} self={self} onClose={() => setOpen(false)} />}
  </>;
}

type Pending = { key: string; file: File; category: Category };

export function StaffPersonnelDocuments({ person, self, onClose }: { person: Person; self: boolean; onClose: () => void }) {
  const id = encodeURIComponent(person.id);
  const [csrf, setCsrf] = useState(""), [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [listing, setListing] = useState<Listing | null>(null), [loadError, setLoadError] = useState("");
  const [category, setCategory] = useState<Category | "">(""), [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState<Pending | null>(null), [busy, setBusy] = useState(""), [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [editing, setEditing] = useState<PersonnelDocument | null>(null), [profileAction, setProfileAction] = useState<"archive" | "restore" | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const can = (capability: Capability) => capabilities.includes(capability);

  async function load() {
    const session = await (await call(`${id}/session`)).json() as { csrfToken: string; capabilities: Capability[] };
    setCsrf(session.csrfToken); setCapabilities(session.capabilities);
    setListing(await (await call(`${id}/documents`)).json() as Listing);
  }
  useEffect(() => {
    load().catch(error => setLoadError(error instanceof Error ? error.message : "Employee documents couldn't be loaded."));
  }, [person.id]);
  const refresh = () => load().catch(error => setNotice({ tone: "error", text: (error as Error).message }));

  async function upload(request: Pending) {
    setBusy("upload"); setNotice(null);
    try {
      const response = await call(`${id}/documents`, {
        method: "POST", csrf, body: request.file,
        headers: {
          "Idempotency-Key": request.key, "X-Document-Category": request.category,
          "X-File-Name": encodeURIComponent(request.file.name.normalize("NFC")),
          "Content-Type": TYPES[request.file.name.split(".").pop()!.toLowerCase()]!,
        },
      });
      const result = await response.json() as { replayed: boolean };
      setPending(null); setFile(null); setCategory("");
      if (fileInput.current) fileInput.current.value = "";
      setNotice({ tone: "ok", text: result.replayed ? "That upload was already saved." : `${request.file.name} was uploaded. It stays locked until the virus scan finishes.` });
      await refresh();
    } catch (error) {
      // A definite refusal ends this upload; anything uncertain keeps the same request so a retry can't create a duplicate.
      if (error instanceof PersonnelError && error.definite) { setPending(null); if (error.code === "personnel_denied") await refresh(); }
      setNotice({ tone: "error", text: error instanceof PersonnelError && !error.definite
        ? `${error.message} Use "Retry upload" to resend the same file; it won't be saved twice.` : (error as Error).message });
    } finally { setBusy(""); }
  }

  function startUpload() {
    if (!file || !category) return;
    const extension = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
    if (!TYPES[extension]) { setNotice({ tone: "error", text: PROBLEMS.unsupported_document! }); return; }
    if (file.size === 0) { setNotice({ tone: "error", text: PROBLEMS.empty_document! }); return; }
    if (file.size > MAX_BYTES) { setNotice({ tone: "error", text: PROBLEMS.document_too_large! }); return; }
    const request = { key: crypto.randomUUID(), file, category };
    setPending(request);
    void upload(request);
  }

  async function download(document: PersonnelDocument) {
    setBusy(document.id); setNotice(null);
    try {
      const blob = await (await call(`${id}/documents/${encodeURIComponent(document.id)}/content`)).blob();
      const url = URL.createObjectURL(blob), link = window.document.createElement("a");
      link.href = url; link.download = document.filename; link.rel = "noopener";
      window.document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) { setNotice({ tone: "error", text: (error as Error).message }); }
    finally { setBusy(""); }
  }

  const archived = Boolean(listing?.profile?.archived_at);
  const groups = (Object.keys(CATEGORY_LABELS) as Category[])
    .map(key => ({ key, items: listing?.documents.filter(item => item.category === key) ?? [] }))
    .filter(group => group.items.length);

  return <Dialog open size="lg" onClose={onClose} title={`Documents · ${person.display_name}`}
    description="Private employee records. Only administrators with document access can see them. Records are archived, never deleted.">
    {loadError ? <div className="notice error" role="alert">{loadError}</div> : !listing ? <p role="status">Loading documents…</p> : <div className="personnel-documents">
      {archived && <div className="notice personnel-archived" role="status">
        <strong>Archived former employee</strong>
        <span>Archived {day(listing.profile!.archived_at!)}. They can't sign in or receive new documents. Existing records stay available here.</span>
      </div>}
      {notice && <div className={`notice ${notice.tone === "error" ? "error" : ""}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}
        {pending && notice.tone === "error" && <button type="button" className="button-orange button-small" disabled={busy === "upload"} onClick={() => void upload(pending)}>Retry upload</button>}
      </div>}

      {can("staff.documents.upload") && !archived && <section className="personnel-upload" aria-labelledby="personnel-upload-title">
        <h3 id="personnel-upload-title">Add a document</h3>
        <div className="personnel-upload-fields">
          <label>Type<select value={category} disabled={Boolean(pending)} onChange={event => setCategory(event.target.value as Category)}>
            <option value="">Choose…</option>
            {(Object.keys(CATEGORY_LABELS) as Category[]).map(key => <option key={key} value={key}>{CATEGORY_LABELS[key]}</option>)}
          </select></label>
          <label>File<input ref={fileInput} type="file" accept={ACCEPT} disabled={Boolean(pending)}
            onChange={event => { setFile(event.target.files?.[0] ?? null); setNotice(null); }} /></label>
          <button type="button" className="button-orange" disabled={!file || !category || Boolean(pending)} onClick={startUpload}>
            {busy === "upload" ? "Uploading…" : "Upload"}</button>
        </div>
        <small>PDF, JPG, PNG, DOCX, XLSX or TXT, up to 25 MB. New files stay locked until a virus scan clears them.</small>
      </section>}

      {groups.length ? groups.map(group => <section key={group.key} className="personnel-group" aria-label={CATEGORY_LABELS[group.key]}>
        <h3>{CATEGORY_LABELS[group.key]}</h3>
        <ul>{group.items.map(document => <li key={document.id} className="personnel-document">
          <div className="personnel-document-main">
            <strong>{document.filename}</strong>
            <small>{fileSize(document.size)} · added {day(document.createdAt)}</small>
            <div className="personnel-document-badges">
              {statusPill(document)}
              {document.retention.hold && <StatusPill tone="danger">On hold</StatusPill>}
              {document.retention.reviewAfter && <StatusPill>Review after {day(document.retention.reviewAfter + "T12:00:00")}</StatusPill>}
            </div>
            {document.status === "rejected" && <small className="personnel-document-detail">The scanner found a problem. The file can't be opened; upload a clean copy if one is needed.</small>}
            {document.status === "quarantined" && document.scan?.state === "manual_review" && <small className="personnel-document-detail">The virus scan couldn't finish after several tries, so the file stays locked. An administrator needs to check the scanner.</small>}
            {document.status === "quarantined" && document.scan?.state === "pending" && document.scan.attempts > 0 && <small className="personnel-document-detail">The last scan attempt didn't finish{document.scan.retryAfter ? `; it will try again after ${new Date(document.scan.retryAfter).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : ""}. The file stays locked until it passes.</small>}
            {document.status === "uploading" && <small className="personnel-document-detail">This upload was interrupted. Retry it from the device that started it, or ask your administrator.</small>}
          </div>
          <div className="personnel-document-actions">
            {document.status === "accepted" && can("staff.documents.read") &&
              <button type="button" className="button-ghost button-small" disabled={busy === document.id} onClick={() => void download(document)}>Download</button>}
            {can("staff.documents.manage") &&
              <button type="button" className="button-ghost button-small" onClick={() => setEditing(document)}>Retention</button>}
          </div>
        </li>)}</ul>
      </section>) : <EmptyState title="No documents yet" detail={archived ? "Nothing was kept for this person." : "Add agreements, tax forms and onboarding records here."} />}

      {!self && (archived ? can("staff.profile.restore") : can("staff.profile.archive")) && listing.profile &&
        <section className="personnel-profile-actions">
          <h3>{archived ? "Restore profile" : "Former employee"}</h3>
          <p>{archived ? "Restoring removes the archive marker only. Their sign-in stays off until an administrator turns access back on separately."
            : "Archiving turns off their sign-in and keeps every record. Nothing is deleted."}</p>
          <button type="button" className={archived ? "button-ghost" : "button-danger"} onClick={() => setProfileAction(archived ? "restore" : "archive")}>
            {archived ? "Restore profile…" : "Archive employee…"}</button>
        </section>}
    </div>}
    {editing && <RetentionEditor document={editing} csrf={csrf} staffId={id} onClose={() => setEditing(null)}
      onSaved={text => { setEditing(null); setNotice({ tone: "ok", text }); void refresh(); }}
      onConflict={() => { setEditing(null); setNotice({ tone: "error", text: PROBLEMS.version_conflict! }); void refresh(); }} />}
    {profileAction && listing?.profile && <ProfileAction action={profileAction} person={person} version={listing.profile.version} csrf={csrf} staffId={id}
      onClose={() => setProfileAction(null)}
      onDone={text => { setProfileAction(null); setNotice({ tone: "ok", text }); void refresh(); }}
      onConflict={() => { setProfileAction(null); setNotice({ tone: "error", text: PROBLEMS.version_conflict! }); void refresh(); }} />}
  </Dialog>;
}

/** Hold and review date for one document. The date is for a human review, never automatic deletion. */
function RetentionEditor({ document, csrf, staffId, onClose, onSaved, onConflict }: {
  document: PersonnelDocument; csrf: string; staffId: string; onClose: () => void; onSaved: (text: string) => void; onConflict: () => void;
}) {
  const [hold, setHold] = useState(document.retention.hold), [reviewAfter, setReviewAfter] = useState(document.retention.reviewAfter ?? "");
  const [note, setNote] = useState(""), [error, setError] = useState(""), [saving, setSaving] = useState(false);
  const command = useRef(crypto.randomUUID());
  const save = async () => {
    setSaving(true); setError("");
    try {
      await call(`${staffId}/documents/${encodeURIComponent(document.id)}/retention`, {
        method: "POST", csrf, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId: command.current, expectedVersion: document.retention.version, hold, reviewAfter: reviewAfter || null, reviewNote: note.trim() }),
      });
      onSaved(`Retention for ${document.filename} was saved.`);
    } catch (caught) {
      if (caught instanceof PersonnelError && caught.code === "version_conflict") return onConflict();
      if (caught instanceof PersonnelError && caught.definite) command.current = crypto.randomUUID();
      setError((caught as Error).message);
    } finally { setSaving(false); }
  };
  return <Dialog open size="sm" onClose={onClose} title="Retention" description={document.filename}
    footer={<><button type="button" className="button-ghost" onClick={onClose}>Cancel</button>
      <button type="button" className="button-orange" disabled={saving || !note.trim()} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button></>}>
    <div className="ltds-form personnel-form">
      <label className="personnel-check"><input type="checkbox" checked={hold} onChange={event => setHold(event.target.checked)} /> Place on hold (keep for a dispute, audit or legal request)</label>
      <label>Review after (optional)<input type="date" value={reviewAfter} onChange={event => setReviewAfter(event.target.value)} />
        <small>A reminder for a person to review this record. It never deletes anything.</small></label>
      <label>Note (required)<textarea maxLength={500} rows={3} value={note} onChange={event => setNote(event.target.value)} placeholder="Why this is being changed" /></label>
      {error && <div className="notice error" role="alert">{error}</div>}
    </div>
  </Dialog>;
}

function ProfileAction({ action, person, version, csrf, staffId, onClose, onDone, onConflict }: {
  action: "archive" | "restore"; person: Person; version: number; csrf: string; staffId: string;
  onClose: () => void; onDone: (text: string) => void; onConflict: () => void;
}) {
  const [reason, setReason] = useState(""), [error, setError] = useState(""), [saving, setSaving] = useState(false);
  const command = useRef(crypto.randomUUID());
  const submit = async () => {
    setSaving(true); setError("");
    try {
      await call(`${staffId}/${action}`, {
        method: "POST", csrf, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId: command.current, expectedVersion: version, reason: reason.trim() }),
      });
      onDone(action === "archive" ? `${person.display_name} was archived. Their sign-in is off and their records are kept.`
        : `${person.display_name}'s profile was restored. Their sign-in is still off until access is turned on separately.`);
    } catch (caught) {
      if (caught instanceof PersonnelError && caught.code === "version_conflict") return onConflict();
      if (caught instanceof PersonnelError && caught.definite) command.current = crypto.randomUUID();
      setError((caught as Error).message);
    } finally { setSaving(false); }
  };
  return <Dialog open size="sm" onClose={onClose} title={action === "archive" ? `Archive ${person.display_name}?` : `Restore ${person.display_name}?`}
    description={action === "archive" ? "Their sign-in turns off and they can't receive new documents. Every record is kept."
      : "This removes the archive marker only. It does not turn their sign-in back on."}
    footer={<><button type="button" className="button-ghost" onClick={onClose}>Cancel</button>
      <button type="button" className={action === "archive" ? "button-danger" : "button-orange"} disabled={saving || !reason.trim()} onClick={() => void submit()}>
        {saving ? "Saving…" : action === "archive" ? "Archive employee" : "Restore profile"}</button></>}>
    <div className="ltds-form personnel-form">
      <label>Reason (required)<textarea maxLength={500} rows={3} value={reason} onChange={event => setReason(event.target.value)}
        placeholder={action === "archive" ? "For example: left the company on Oct 31" : "Why this profile is being restored"} /></label>
      {error && <div className="notice error" role="alert">{error}</div>}
    </div>
  </Dialog>;
}
