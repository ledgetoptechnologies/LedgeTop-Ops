import { useEffect, useRef, useState } from "react";
import { Card, EmptyState } from "@ltds/ui";
import { api, ApiError } from "./api";
import "./ClientInternalNotes.css";

interface Root { sourceId: string; rootNamespace: string; kind: string; publicId: string }
interface Note { id: string; version: number; title: string; body: string; createdBy: string; updatedBy: string;
  createdAt: string; updatedAt: string; revisions: Array<{ version: number; action: "created" | "updated" | "deleted";
    actorId: string; createdAt: string }> }
interface Workspace { canonicalRoot: Root; contextVersion: string; projectId?: string; notes: Note[]; capabilities: { canManageNotes: boolean } }
interface Attempt { fingerprint: string; key: string }
const rootKey = (root: Root) => JSON.stringify([root.sourceId,root.rootNamespace,root.kind,root.publicId]);
const displayDate = (value: string) => { const parsed = new Date(value); return Number.isFinite(parsed.valueOf())
  ? parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Date unavailable"; };
const attemptKey = (attempt: React.MutableRefObject<Attempt | null>, payload: unknown) => {
  const fingerprint = JSON.stringify(payload); if (attempt.current?.fingerprint === fingerprint) return attempt.current.key;
  const key = crypto.randomUUID(); attempt.current = { fingerprint, key }; return key;
};
function valid(value: unknown, root: Root, contextVersion: string, projectId?: string): value is Workspace {
  if (!value || typeof value !== "object") return false;
  const item = value as Workspace;
  return rootKey(item.canonicalRoot) === rootKey(root) && item.contextVersion === contextVersion && (!projectId || item.projectId === projectId)
    && typeof item.capabilities?.canManageNotes === "boolean" && Array.isArray(item.notes) && item.notes.length <= 100
    && new Set(item.notes.map(note => note.id)).size === item.notes.length
    && item.notes.every(note => typeof note.id === "string" && Number.isSafeInteger(note.version) && note.version > 0
      && typeof note.title === "string" && note.title.length > 0 && note.title.length <= 160
      && typeof note.body === "string" && note.body.length <= 12000 && typeof note.createdBy === "string"
      && typeof note.updatedBy === "string" && typeof note.createdAt === "string" && typeof note.updatedAt === "string"
      && Array.isArray(note.revisions) && note.revisions.every(revision => Number.isSafeInteger(revision.version) && revision.version > 0
        && ["created","updated","deleted"].includes(revision.action) && typeof revision.actorId === "string" && typeof revision.createdAt === "string"));
}

export function ClientInternalNotes({ root, contextVersion, contextSignal, onInvalidated, projectId }: {
  root: Root; contextVersion: string; contextSignal: AbortSignal; onInvalidated: (message: string) => void; projectId?: string;
}) {
  const base = `/api/client-hub/sources/${encodeURIComponent(root.sourceId)}/${root.rootNamespace}/${root.kind === "organization" ? "organizations" : "standalone"}/${encodeURIComponent(root.publicId)}`;
  const endpoint = projectId ? `${base}/business-projects/${encodeURIComponent(projectId)}/internal-notes` : `${base}/internal-notes`;
  const subject = projectId ? "project" : "client";
  const [state, setState] = useState<{ data: Workspace | null; busy: boolean; error: string }>({ data: null, busy: true, error: "" });
  const [editor, setEditor] = useState<{ id: string | null; version: number; title: string; body: string } | null>(null);
  const [editorError, setEditorError] = useState(""), [conflict, setConflict] = useState(false);
  const [status, setStatus] = useState(""), [revision, setRevision] = useState(0);
  const active = useRef(true), attempt = useRef<Attempt | null>(null), sequence = useRef(0);
  const load = async (signal: AbortSignal, request: number) => {
    try {
      const result = await api<unknown>(endpoint, { signal });
      if (!active.current || signal.aborted || request !== sequence.current) return;
      if (!valid(result, root, contextVersion, projectId)) throw new ApiError("Internal-note context changed. Refresh this workspace.", 409, {});
      setState({ data: result, busy: false, error: "" });
      setEditor(current => current?.id ? { ...current, version: result.notes.find(note => note.id === current.id)?.version ?? current.version } : current);
    } catch (error) {
      if (!active.current || signal.aborted || request !== sequence.current) return;
      const message = error instanceof Error ? error.message : "Internal notes could not be loaded.";
      if (error instanceof ApiError && [401,403,404].includes(error.status)) onInvalidated(message);
      else setState(previous => ({ ...previous, busy: false, error: message }));
    }
  };
  useEffect(() => {
    active.current = true; const controller = new AbortController(), request = ++sequence.current;
    const abort = () => controller.abort(); contextSignal.addEventListener("abort", abort);
    setState(previous => ({ ...previous, busy: true, error: "" })); void load(controller.signal, request);
    return () => { active.current = false; controller.abort(); contextSignal.removeEventListener("abort", abort); };
  }, [endpoint, contextVersion, revision]);
  const refresh = () => { attempt.current = null; setEditor(null); setEditorError(""); setConflict(false); setRevision(value => value + 1); };
  const refreshConflict = () => { attempt.current = null; setEditorError(""); setConflict(false); setRevision(value => value + 1); };
  const mutate = async (operation: "create" | "update" | "delete", draft: NonNullable<typeof editor>) => {
    if (!state.data || state.busy || contextSignal.aborted) return;
    if (operation !== "delete" && !draft.title.trim()) { setEditorError("Add a short note title before saving."); return; }
    const payload = operation === "delete" ? { expectedContextVersion: contextVersion, expectedVersion: draft.version }
      : { expectedContextVersion: contextVersion, ...(operation === "update" ? { expectedVersion: draft.version } : {}),
        title: draft.title.trim(), body: draft.body.trim() };
    const key = attemptKey(attempt, { operation, id: draft.id, payload }), controller = new AbortController(), request = ++sequence.current;
    const abort = () => controller.abort(); contextSignal.addEventListener("abort", abort, { once: true });
    setState(previous => ({ ...previous, busy: true })); setEditorError(""); setConflict(false);
    setStatus(operation === "delete" ? "Deleting note…" : "Saving note…");
    try {
      await api(operation === "create" ? endpoint : `${endpoint}/${encodeURIComponent(draft.id!)}`, { method: operation === "create" ? "POST" : operation === "update" ? "PATCH" : "DELETE",
        headers: { "Idempotency-Key": key }, body: JSON.stringify(payload), signal: controller.signal });
      if (!active.current || controller.signal.aborted || request !== sequence.current) return;
      const result = await api<unknown>(endpoint, { signal: controller.signal });
      if (!valid(result, root, contextVersion, projectId)) throw new ApiError("Internal notes changed before the save could be verified. Refresh this workspace.", 409, {});
      attempt.current = null; setState({ data: result, busy: false, error: "" }); setEditor(null);
      setStatus(operation === "delete" ? "Note deleted. Its audit history was retained." : "Internal note saved.");
    } catch (error) {
      if (!active.current || controller.signal.aborted || request !== sequence.current) return;
      const message = error instanceof Error ? error.message : "The internal note could not be saved.";
      if (error instanceof ApiError && [401,403,404].includes(error.status)) onInvalidated(message);
      else { setState(previous => ({ ...previous, busy: false })); setConflict(error instanceof ApiError && error.status === 409);
        setEditorError(error instanceof ApiError && error.status === 409 ? `${message} Reload the latest version, review your preserved draft, and save again.` : message); setStatus(""); }
    } finally { contextSignal.removeEventListener("abort", abort); }
  };
  const data = state.data;
  return <Card title="Internal notes">
    <section className="client-internal-notes" aria-label={`Internal ${subject} notes`} aria-busy={state.busy}>
      <p className="client-internal-notes-private">Operations staff only. These notes are never shown in the client portal or synchronized to Project Alpha.</p>
      {!data && state.busy && <p role="status">Loading internal notes…</p>}
      {!data && state.error && <><div role="alert"><EmptyState title="Internal notes unavailable" detail={state.error} /></div>
        <button type="button" className="button-ghost" onClick={refresh}>Retry notes</button></>}
      {data && <>
        <div className="client-internal-notes-toolbar">
          {data.capabilities.canManageNotes && !editor && <button type="button" className="button-orange" onClick={() => { attempt.current = null; setEditorError(""); setEditor({ id: null, version: 0, title: "", body: "" }); }}>Add note</button>}
          <button type="button" className="button-ghost" disabled={state.busy} onClick={refresh}>Refresh notes</button>
        </div>
        {state.error && <p role="alert">{state.error}</p>}{status && <p role="status">{status}</p>}
        {editor && <form className="client-internal-note-editor" onSubmit={event => { event.preventDefault(); void mutate(editor.id ? "update" : "create", editor); }}>
          <label>Title<input value={editor.title} maxLength={160} required onChange={event => setEditor(value => value && ({ ...value, title: event.target.value }))} /></label>
          <label>Note<textarea value={editor.body} maxLength={12000} rows={6} onChange={event => setEditor(value => value && ({ ...value, body: event.target.value }))} /></label>
          {editorError && <p className="client-internal-note-error" role="alert">{editorError}</p>}
          {conflict && <button type="button" className="button-ghost" disabled={state.busy} onClick={refreshConflict}>Reload latest version</button>}
          <div><button type="submit" className="button-orange" disabled={state.busy}>{state.busy ? "Saving…" : "Save note"}</button>
            <button type="button" className="button-ghost" disabled={state.busy} onClick={() => { attempt.current = null; setEditor(null); setEditorError(""); }}>Cancel</button></div>
        </form>}
        {!data.notes.length && !editor && <EmptyState title="No internal notes" detail={`Add private context that Operations staff should remember about this ${subject}.`} />}
        <div className="client-internal-note-list">{data.notes.map(note => <article key={note.id}>
          <header><div><h3>{note.title}</h3><small>Updated {displayDate(note.updatedAt)} · version {note.version}</small></div>
            {data.capabilities.canManageNotes && !editor && <div><button type="button" className="button-ghost" onClick={() => { attempt.current = null; setEditorError(""); setEditor({ id: note.id, version: note.version, title: note.title, body: note.body }); }}>Edit</button>
              <button type="button" className="button-danger" onClick={() => { if (confirm(`Delete “${note.title}”? The immutable audit history will be retained.`)) void mutate("delete", { id: note.id, version: note.version, title: note.title, body: note.body }); }}>Delete</button></div>}</header>
          {note.body && <p>{note.body}</p>}
          <details><summary>Audit history ({note.revisions.length})</summary><ol>{note.revisions.map(revision =>
            <li key={`${revision.version}:${revision.action}`}>{revision.action} · version {revision.version} · {displayDate(revision.createdAt)}</li>)}</ol></details>
        </article>)}</div>
      </>}
    </section>
  </Card>;
}
