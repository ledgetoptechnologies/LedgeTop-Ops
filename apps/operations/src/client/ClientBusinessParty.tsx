import { useEffect, useRef, useState, type FormEvent } from "react";
import { Card } from "@ltds/ui";
import { api, ApiError } from "./api";
import { clientDirectoryReturnPath, type ClientKind, type ClientSummary } from "./ClientDirectory";

interface BusinessRoot { sourceId: string; kind: ClientKind; recordId: string }
interface PartyMember { linkId: string | null; root: BusinessRoot; displayName: string; sourceName: string; detailPath: string | null; availability: "available" | "unavailable" }
export interface BusinessPartyReference { id: string; displayName: string; version: number; canManage: boolean; needsReview?: boolean }
interface BusinessParty extends BusinessPartyReference { kind: ClientKind; status: "active"; members: PartyMember[] }
type Operation = { action: "create"; displayName: string; roots: BusinessRoot[] }
  | { action: "add"; partyId: string; expectedVersion: number; root: BusinessRoot }
  | { action: "unlink"; partyId: string; expectedVersion: number; linkId: string };
interface Preview { action: Operation["action"]; partyId: string | null; partyVersion: number | null; displayName: string;
  kind: ClientKind; members: PartyMember[]; removedMember: PartyMember | null; contextVersion: string }
const ENDPOINT = "/api/business-parties";
const errorText = (error: unknown) => error instanceof Error ? error.message : "Customer links could not be loaded.";
const isContextError = (error: unknown) => error instanceof ApiError && [401, 403, 404, 409].includes(error.status);
const rootKey = (root: BusinessRoot) => JSON.stringify([root.sourceId, root.kind, root.recordId]);
function validRoot(root: BusinessRoot): boolean {
  return Boolean(root && /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(root.sourceId)
    && ["organization", "standalone_client"].includes(root.kind) && typeof root.recordId === "string" && root.recordId.length);
}
function validMembers(members: PartyMember[]): boolean {
  return Array.isArray(members) && members.length <= 32 && members.every(member => member && validRoot(member.root)
    && (member.linkId === null || typeof member.linkId === "string") && typeof member.displayName === "string" && typeof member.sourceName === "string"
    && ["available", "unavailable"].includes(member.availability) && (member.detailPath === null || typeof member.detailPath === "string"));
}
function previewMatchesOperation(preview: Preview, operation: Operation): boolean {
  const keys = preview.members.map(member => rootKey(member.root));
  if (new Set(keys).size !== keys.length || new Set(preview.members.map(member => member.root.sourceId)).size !== keys.length
    || preview.members.some(member => member.root.kind !== preview.kind
      || (member.availability !== "available" && !(operation.action === "unlink" && member.detailPath === null)))) return false;
  if (operation.action === "create") {
    return preview.kind === operation.roots[0]?.kind && keys.length === operation.roots.length
      && operation.roots.every(root => keys.includes(rootKey(root))) && preview.removedMember === null;
  }
  if (operation.action === "add") return preview.kind === operation.root.kind && keys.includes(rootKey(operation.root)) && preview.removedMember === null;
  return Boolean(preview.removedMember && preview.removedMember.root.kind === preview.kind
    && preview.removedMember.linkId === operation.linkId && !keys.includes(rootKey(preview.removedMember.root)));
}
function sourcePath(member: PartyMember): string {
  return `/clients/sources/${encodeURIComponent(member.root.sourceId)}/business/${member.root.kind === "organization" ? "organizations" : "standalone"}/${encodeURIComponent(member.root.recordId)}`;
}
function directoryFilters(): string { return clientDirectoryReturnPath().replace(/^\/clients/, ""); }
export function businessPartyHref(id: string): string { return `/clients/parties/${encodeURIComponent(id)}${directoryFilters()}`; }
function goToParty(id: string, status: "active" | "closed") {
  history.pushState(null, "", status === "closed" ? clientDirectoryReturnPath() : businessPartyHref(id));
  dispatchEvent(new PopStateEvent("popstate"));
}
function MemberList({ members, removing = false }: { members: PartyMember[]; removing?: boolean }) {
  return <ul className="business-party-member-list">{members.map(member => <li key={rootKey(member.root)}>
    <strong>{member.displayName}</strong><span>{member.sourceName}</span><small>{member.root.sourceId} · Record {member.root.recordId}</small>
    {member.availability === "unavailable" && <small>{removing ? "The original record is unavailable. Only its reviewed link will be removed." : "The original record is unavailable. It remains linked until separately reviewed and unlinked."}</small>}
  </li>)}</ul>;
}

/** One reviewed operation, with an unchanged idempotency body on uncertain retries. */
function PartyReview({ operation, contextSignal, onCancel, onInvalidated, onSaved }: {
  operation: Operation; onCancel: () => void; onInvalidated: (message: string) => void; onSaved: (id: string, status: "active" | "closed") => void;
  contextSignal: AbortSignal;
}) {
  const [preview, setPreview] = useState<Preview | null>(null), [error, setError] = useState("");
  const [phase, setPhase] = useState<"loading" | "ready" | "submitting" | "uncertain" | "rejected" | "error">("loading");
  const [acknowledged, setAcknowledged] = useState(false), [revision, setRevision] = useState(0);
  const read = useRef<AbortController | null>(null), write = useRef<AbortController | null>(null);
  const body = useRef<string | null>(null), heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (contextSignal.aborted) return;
    const controller = new AbortController(); read.current = controller;
    const abort = () => { controller.abort(); write.current?.abort(); };
    contextSignal.addEventListener("abort", abort);
    setPreview(null); setPhase("loading"); setError(""); setAcknowledged(false); body.current = null;
    void api<{ preview: Preview }>(`${ENDPOINT}/preview`, { method: "POST", body: JSON.stringify(operation), signal: controller.signal }).then(result => {
      if (controller.signal.aborted || contextSignal.aborted) return;
      const next = result.preview;
      if (!next || next.action !== operation.action || typeof next.contextVersion !== "string" || !next.contextVersion
        || typeof next.displayName !== "string" || !validMembers(next.members)
        || (operation.action === "create" ? next.partyId !== null : next.partyId !== operation.partyId || next.partyVersion !== operation.expectedVersion)
        || (operation.action === "unlink" && (!next.removedMember || !validMembers([next.removedMember]) || next.removedMember.linkId !== operation.linkId))
        || !previewMatchesOperation(next, operation))
        throw new Error("The link preview could not be verified. Review the records again.");
      body.current = JSON.stringify({ operation, previewContextVersion: next.contextVersion, idempotencyKey: crypto.randomUUID() });
      setPreview(next); setPhase("ready");
    }).catch(caught => {
      if (controller.signal.aborted || contextSignal.aborted) return;
      if (isContextError(caught)) { onInvalidated(errorText(caught)); return; }
      setError(errorText(caught)); setPhase("error");
    });
    return () => { contextSignal.removeEventListener("abort", abort); abort(); };
  }, [operation, revision, contextSignal]);
  useEffect(() => { if (preview && !contextSignal.aborted) heading.current?.focus(); }, [preview, contextSignal]);
  const confirm = async () => {
    if (contextSignal.aborted || write.current || !body.current || !preview || !acknowledged || !["ready", "uncertain"].includes(phase)) return;
    const controller = new AbortController(); write.current = controller;
    setPhase("submitting"); setError("");
    try {
      const result = await api<{ partyId: string; version: number; status: "active" | "closed"; replayed: boolean }>(ENDPOINT,
        { method: "POST", body: body.current, signal: controller.signal });
      if (controller.signal.aborted || contextSignal.aborted) return;
      const expectedStatus = operation.action === "unlink" && preview.members.length === 0 ? "closed" : "active";
      if (!result || typeof result.partyId !== "string" || !result.partyId || !Number.isInteger(result.version) || result.version < 1
        || result.status !== expectedStatus || (operation.action !== "create" && result.partyId !== operation.partyId))
        throw new Error("The response could not be verified. Retry this same operation to check its outcome.");
      onSaved(result.partyId, result.status);
    } catch (caught) {
      if (controller.signal.aborted || contextSignal.aborted) return;
      if (isContextError(caught)) { setPreview(null); body.current = null; onInvalidated(errorText(caught)); return; }
      setError(errorText(caught));
      setPhase(caught instanceof ApiError && caught.status < 500 && caught.status !== 408 ? "rejected" : "uncertain");
    } finally { if (write.current === controller) write.current = null; }
  };
  const busy = phase === "loading" || phase === "submitting";
  return <section className="business-party-review" aria-label="Review customer link" aria-busy={busy}>
    <h3 ref={heading} tabIndex={-1}>{operation.action === "unlink" ? "Review unlink" : "Review customer link"}</h3>
    {phase === "loading" && <p role="status">Preparing the current records for review…</p>}
    {preview && <>
      <p><strong>{preview.displayName}</strong></p>
      {preview.removedMember && <div><h4>Record to unlink</h4><MemberList members={[preview.removedMember]} removing /></div>}
      <h4>{operation.action === "unlink" ? "Records remaining together" : "Records shown as one customer"}</h4>
      {preview.members.length ? <MemberList members={preview.members} /> : <p>No records will remain. This linked customer page will close; its source record remains in the directory.</p>}
      <p>Only the Client Hub grouping changes. Source records, project history, portal logins, permissions, billing, invitations and notifications are unchanged.</p>
      {operation.action === "unlink" && <p>The unlinked record will appear separately in the directory. This does not delete any source data.</p>}
      <label className="business-party-confirm"><input type="checkbox" checked={acknowledged} disabled={busy || phase === "uncertain"}
        onChange={event => setAcknowledged(event.target.checked)} />{operation.action === "unlink" ? "I reviewed the record to unlink." : "I reviewed these records and confirm they represent the same customer."}</label>
    </>}
    {error && <p role="alert">{error}</p>}
    {phase === "uncertain" && <p>The result is not confirmed. Retry to check the same operation; it will not create a second link. Closing this review does not undo an operation already accepted.</p>}
    <div className="business-party-actions">
      {preview && ["ready", "submitting", "uncertain"].includes(phase) && <button type="button" className="button-orange" disabled={!acknowledged || busy} onClick={() => void confirm()}>
        {phase === "submitting" ? "Saving…" : phase === "uncertain" ? "Retry same operation" : operation.action === "unlink" ? "Confirm unlink" : "Confirm customer link"}</button>}
      {["error", "rejected"].includes(phase) && <button type="button" className="button-orange" onClick={() => setRevision(value => value + 1)}>Review again</button>}
      <button type="button" className="button-ghost" disabled={phase === "submitting"} onClick={onCancel}>{phase === "uncertain" ? "Close and refresh" : "Cancel review"}</button>
    </div>
  </section>;
}

function RecordPicker({ kind, excludedSources, contextSignal, onSelect, onInvalidated }: {
  kind: ClientKind; excludedSources: string[]; onSelect: (client: ClientSummary) => void; onInvalidated: (message: string) => void;
  contextSignal: AbortSignal;
}) {
  const [draft, setDraft] = useState(""), [query, setQuery] = useState("");
  const [rows, setRows] = useState<ClientSummary[]>([]), [next, setNext] = useState<string | null>(null);
  const [sources, setSources] = useState<Array<{ source_id: string; display_name: string }> | null>(null), [source, setSource] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [loaded, setLoaded] = useState(false);
  const pending = useRef<AbortController | null>(null), sequence = useRef(0), failedCursor = useRef<string | null>(null);
  const load = async (cursor: string | null) => {
    if (contextSignal.aborted) return;
    pending.current?.abort(); const controller = new AbortController(), request = ++sequence.current; pending.current = controller;
    setBusy(true); setError("");
    if (!cursor) { setRows([]); setNext(null); setLoaded(false); }
    try {
      const params = new URLSearchParams({ grouping: "records", kind, q: query, limit: "24" });
      if (source) params.set("source", source);
      if (cursor) params.set("cursor", cursor);
      const result = await api<{ clients: ClientSummary[]; nextCursor: string | null; sources?: Array<{ source_id: string; display_name: string }>; capabilities: { directory: boolean } }>(`/api/client-hub?${params}`, { signal: controller.signal });
      if (controller.signal.aborted || contextSignal.aborted || request !== sequence.current) return;
      if (!result.capabilities?.directory) throw new ApiError("Client-directory access is no longer available.", 403, {});
      if (!Array.isArray(result.clients) || (result.nextCursor && result.nextCursor === cursor)) throw new Error("These records could not be continued safely. Search again.");
      if (result.sources) {
        const available = result.sources.filter(row => row.source_id.startsWith("project-alpha:") && !excludedSources.includes(row.source_id));
        setSources(available);
        if (!available.length) { setRows([]); setNext(null); setLoaded(true); return; }
        // The first bounded read discovers authorized sources; subsequent reads target another source.
        if (!source && available[0]) { setSource(available[0].source_id); return; }
      }
      setRows(previous => [...new Map([...(cursor ? previous : []), ...result.clients].map(row => [JSON.stringify([row.source_id, row.root_namespace, row.kind, row.public_id]), row])).values()]);
      setNext(result.nextCursor || null); setLoaded(true); failedCursor.current = null;
    } catch (caught) {
      if (controller.signal.aborted || contextSignal.aborted || request !== sequence.current) return;
      if (isContextError(caught)) { setRows([]); setNext(null); onInvalidated(errorText(caught)); return; }
      setError(errorText(caught)); failedCursor.current = cursor;
    } finally { if (!controller.signal.aborted && !contextSignal.aborted && request === sequence.current) { pending.current = null; setBusy(false); } }
  };
  useEffect(() => {
    const abort = () => { pending.current?.abort(); sequence.current += 1; };
    contextSignal.addEventListener("abort", abort);
    void load(null);
    return () => { contextSignal.removeEventListener("abort", abort); abort(); };
  }, [query, kind, source, contextSignal]);
  const search = (event: FormEvent) => { event.preventDefault(); const value = draft.trim(); if (value === query) void load(null); else setQuery(value); };
  return <section className="business-party-picker" aria-label="Find source record" aria-busy={busy}>
    {sources && !sources.length && <p>No other visible business source is available for linking. This action does not connect or activate another source.</p>}
    {sources && sources.length > 0 && <label className="business-party-source-select">Business source<select value={source} onChange={event => setSource(event.target.value)}>
      {sources.map(row => <option key={row.source_id} value={row.source_id}>{row.display_name}</option>)}
    </select></label>}
    <form onSubmit={search} className="business-party-search"><label htmlFor="business-party-search">Find another business record</label>
      <div><input id="business-party-search" type="search" maxLength={200} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Client name, contact, or permitted project" />
        <button type="submit" className="button-ghost">Search records</button></div></form>
    <p>Choose a record from another source. Matching names or emails do not establish a link. Existing linked customers cannot be merged here.</p>
    {error && <div role="alert"><p>{error}</p><button type="button" className="button-ghost" disabled={busy} onClick={() => void load(failedCursor.current)}>Retry records</button></div>}
    <ul className="business-party-member-list">{(sources?.length === 0 ? [] : rows).map(row => {
      const reason = row.root_namespace !== "business" || row.kind !== kind ? "Not a matching business-record type"
        : row.business_party_id ? "Already part of a linked customer" : excludedSources.includes(row.source_id || "") ? "This source is already represented" : null;
      return <li key={JSON.stringify([row.source_id, row.root_namespace, row.kind, row.public_id])}><strong>{row.display_name}</strong>
        <span>{row.source_name || row.source_id}</span><small>{row.source_id} · Record {row.public_id}</small>
        {reason ? <small>{reason}</small> : <button type="button" className="button-ghost" disabled={busy} onClick={() => { if (!contextSignal.aborted) onSelect(row); }}>Choose {row.display_name}</button>}
      </li>;
    })}</ul>
    <p role="status">{busy ? "Loading source records…" : loaded ? `${rows.length} source records shown.` : "Source records are unavailable."}</p>
    {loaded && !rows.length && !busy && <p>{next ? "No records on this page. Continue checking for more." : "No matching source records."}</p>}
    {next && !error && sources?.length !== 0 && <button type="button" className="button-ghost" disabled={busy} onClick={() => void load(next)}>Load more records</button>}
  </section>;
}

function LinkEditor({ anchor, party, contextSignal, onCancel, onInvalidated, onSaved }: {
  anchor?: ClientSummary; party?: BusinessParty; onCancel: () => void; onInvalidated: (message: string) => void; onSaved: (id: string, status: "active" | "closed") => void;
  contextSignal: AbortSignal;
}) {
  const [selected, setSelected] = useState<ClientSummary | null>(null), [name, setName] = useState(party?.displayName || anchor?.display_name || "");
  const [operation, setOperation] = useState<Operation | null>(null);
  const kind = party?.kind || anchor!.kind;
  if (operation) return <PartyReview operation={operation} contextSignal={contextSignal} onInvalidated={onInvalidated} onSaved={onSaved} onCancel={onCancel} />;
  const review = (event: FormEvent) => {
    event.preventDefault(); if (contextSignal.aborted || !selected?.source_id || !name.trim()) return;
    const root: BusinessRoot = { sourceId: selected.source_id, kind: selected.kind, recordId: selected.public_id };
    if (party) setOperation({ action: "add", partyId: party.id, expectedVersion: party.version, root });
    else if (anchor?.source_id) setOperation({ action: "create", displayName: name.trim(), roots: [{ sourceId: anchor.source_id, kind: anchor.kind, recordId: anchor.public_id }, root] });
  };
  return <section className="business-party-editor" aria-label="Link a business record">
    <h3>{party ? "Add a source record" : "Link another source record"}</h3>
    {!selected ? <RecordPicker kind={kind} excludedSources={party?.members.map(member => member.root.sourceId) || [anchor?.source_id || ""]}
      contextSignal={contextSignal} onSelect={setSelected} onInvalidated={onInvalidated} /> : <form onSubmit={review}>
      <p>Selected: <strong>{selected.display_name}</strong> · {selected.source_name || selected.source_id}</p>
      <small>{selected.source_id} · Record {selected.public_id}</small>
      {!party && <label>Linked customer name<input value={name} required maxLength={160} onChange={event => setName(event.target.value)} />
        <small>This names the Client Hub grouping; it does not rename either source record.</small></label>}
      <div className="business-party-actions"><button type="submit" className="button-orange">Preview link</button>
        <button type="button" className="button-ghost" onClick={() => setSelected(null)}>Choose a different record</button></div>
    </form>}
    <button type="button" className="button-ghost" onClick={onCancel}>Cancel linking</button>
  </section>;
}

export function ClientBusinessParty({ partyId }: { partyId: string }) {
  const [party, setParty] = useState<BusinessParty | null>(null), [error, setError] = useState("");
  const [revision, setRevision] = useState(0), [editing, setEditing] = useState(false), [operation, setOperation] = useState<Operation | null>(null);
  const pending = useRef<AbortController | null>(null);
  const invalidate = (message: string) => { pending.current?.abort(); setParty(null); setEditing(false); setOperation(null); setError(message); };
  const refresh = () => { pending.current?.abort(); setParty(null); setEditing(false); setOperation(null); setError(""); setRevision(value => value + 1); };
  useEffect(() => {
    const controller = new AbortController(); pending.current = controller; setParty(null); setError("");
    void api<{ party: BusinessParty }>(`${ENDPOINT}/${encodeURIComponent(partyId)}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      const next = result.party;
      if (!next || next.id !== partyId || next.status !== "active" || typeof next.displayName !== "string" || !Number.isInteger(next.version)
        || !validMembers(next.members) || !next.members.length || next.members.some(member => !member.linkId
          || (member.availability === "unavailable" && !(next.canManage && next.needsReview === true && member.detailPath === null)))
        || typeof next.canManage !== "boolean") throw new Error("This customer grouping could not be verified. Refresh to try again.");
      setParty(next);
    }).catch(caught => { if (!controller.signal.aborted) setError(errorText(caught)); });
    return () => controller.abort();
  }, [partyId, revision]);
  const saved = (id: string, status: "active" | "closed") => { if (status === "closed") goToParty(id, status); else refresh(); };
  return <section className="business-party-workspace" aria-label="Linked customer workspace">
    <a className="button button-ghost client-hub-back" href={clientDirectoryReturnPath()}>← Client Hub</a>
    {!party && !error && <p role="status">Loading linked customer…</p>}
    {error && <Card><div role="alert"><h2>Linked customer unavailable</h2><p>{error}</p></div>
      <button type="button" className="button-orange" onClick={refresh}>Refresh linked customer</button></Card>}
    {party && <>
      <header><div><small>{party.kind === "organization" ? "Organization" : "Individual client"} · Linked customer</small><h2>{party.displayName}</h2></div>
        <button type="button" className="button-ghost" onClick={refresh}>Refresh customer</button></header>
      <p>{party.members.length} business records belong to this customer. Open a source workspace for its contacts and history. Portal logins, access, billing and notifications remain separate.</p>
      {party.needsReview && <p role="status">A linked source record is no longer available. Review and unlink that record before adding another. Unavailable record details are not shown.</p>}
      {operation ? <Card><PartyReview operation={operation} contextSignal={pending.current!.signal} onCancel={refresh} onInvalidated={invalidate} onSaved={saved} /></Card>
        : editing ? <Card><LinkEditor party={party} contextSignal={pending.current!.signal} onCancel={refresh} onInvalidated={invalidate} onSaved={saved} /></Card>
        : <>
          <div className="business-party-sources">{party.members.map(member => <Card key={member.linkId}>
            <article aria-label={`${member.sourceName} business record`}><h3>{member.displayName}</h3><p>{member.sourceName}</p>
              <small>{member.root.sourceId} · Record {member.root.recordId}</small>
              <div className="business-party-actions">{member.availability !== "unavailable" && member.detailPath && <a className="button button-orange" href={`${sourcePath(member)}${directoryFilters()}`}>Open {member.sourceName} workspace</a>}
                {party.canManage && member.linkId && <button type="button" className="button-ghost" onClick={() => setOperation({ action: "unlink", partyId: party.id, expectedVersion: party.version, linkId: member.linkId! })}>Unlink {member.sourceName} record</button>}</div>
            </article>
          </Card>)}</div>
          {party.canManage && <button type="button" className="button-ghost" disabled={party.members.length >= 32 || party.needsReview} onClick={() => setEditing(true)}>Link another source record</button>}
        </>}
    </>}
  </section>;
}

export function SourceBusinessParty({ client, party, canManage, contextSignal, onInvalidated, onRefresh }: {
  client: ClientSummary; party?: BusinessPartyReference | null; canManage?: boolean; onInvalidated: (message: string) => void; onRefresh: () => void;
  contextSignal: AbortSignal;
}) {
  const [editing, setEditing] = useState(false);
  if (client.root_namespace !== "business" || !client.source_id) return null;
  if (party) return <div className="business-party-source-note"><p>Part of linked customer <a href={businessPartyHref(party.id)}>{party.displayName}</a>. This workspace shows only {client.source_name || "this source"}'s records and access.</p>
    {party.needsReview && <p>A linked source record needs review.</p>}
    {canManage && <a className="button button-ghost" href={businessPartyHref(party.id)}>Manage customer links</a>}</div>;
  if (!canManage) return null;
  return <div className="business-party-source-note">{editing ? <LinkEditor anchor={client} contextSignal={contextSignal} onInvalidated={onInvalidated}
    onCancel={() => { setEditing(false); onRefresh(); }} onSaved={goToParty} />
    : <button type="button" className="button-ghost" onClick={() => setEditing(true)}>Link another source record</button>}</div>;
}
