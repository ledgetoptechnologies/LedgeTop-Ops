import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { RequestError } from "./bulk-download";
import {
  addressBookContactMatches,
  createAddressBookContact,
  deleteAddressBookContact,
  loadAddressBookContacts,
  updateAddressBookContact,
  type AddressBookContact,
  type AddressBookContactInput,
} from "./address-book-api";
import "./PortalAddressBook.css";

type AddressBookProps = {
  workspaceId: string;
  sourceId: string;
  locked: boolean;
  onLock: (locked: boolean) => void;
  onInvalidated: (message: string) => void;
  onContactsChanged: () => void;
};

type SaveOperation = {kind: "create"; input: AddressBookContactInput; key: string}
  | {kind: "update"; id: string; expectedVersion: number; input: AddressBookContactInput; key: string}
  | {kind: "delete"; contact: AddressBookContact; key: string};

const emptyInput = (): AddressBookContactInput => ({displayName: "", email: "", phone: null, company: null, roleOrTrade: null});
const bodyCode = (caught: unknown) => {
  const error = caught as RequestError;
  return error.body?.code ?? (typeof error.body?.error === "object" ? error.body.error.code : error.body?.error);
};
const invalidContext = (caught: unknown) => [401, 403, 404, 410].includes((caught as RequestError).status ?? 0);
const normalized = (value: string) => value.normalize("NFC").trim();
const clean = (value: string) => normalized(value) || null;
const inputFromContact = (contact: AddressBookContact): AddressBookContactInput => ({
  displayName: contact.displayName, email: contact.email, phone: contact.phone, company: contact.company, roleOrTrade: contact.roleOrTrade,
});
const inviteHistory = (contact: AddressBookContact) => contact.previousInvitation
  ? `Latest invitation to this email: ${contact.previousInvitation.status} · ${new Date(contact.previousInvitation.lastInvitedAt).toLocaleDateString()}`
  : "No earlier invitation to this email in this workspace";
const matchesInput = (contact: AddressBookContact, input: AddressBookContactInput) => contact.displayName === input.displayName
  && contact.email.toLocaleLowerCase() === input.email.toLocaleLowerCase() && contact.phone === input.phone
  && contact.company === input.company && contact.roleOrTrade === input.roleOrTrade;

function ContactSummary({contact}: {contact: AddressBookContact}) {
  return <div className="portal-address-contact-summary">
    <strong>{contact.displayName}</strong>
    {(contact.company || contact.roleOrTrade) && <span>{[contact.company, contact.roleOrTrade].filter(Boolean).join(" · ")}</span>}
    {contact.email && <span>{contact.email}</span>}
    {contact.phone && <span>{contact.phone}</span>}
    <small>{inviteHistory(contact)}</small>
  </div>;
}

export function PortalAddressBook({workspaceId, sourceId, locked, onLock, onInvalidated, onContactsChanged}: AddressBookProps) {
  const [expanded, setExpanded] = useState(false), [rows, setRows] = useState<AddressBookContact[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [draftQuery, setDraftQuery] = useState(""), [query, setQuery] = useState(""), [contextVersion, setContextVersion] = useState<string | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<{contact: AddressBookContact | null; input: AddressBookContactInput} | null>(null), [deleting, setDeleting] = useState<AddressBookContact | null>(null);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const read = useRef<AbortController | null>(null), mutation = useRef<AbortController | null>(null), generation = useRef(0), pending = useRef<SaveOperation | null>(null);
  const retryCursor = useRef<string | null>(null), callbacks = useRef({onLock, onInvalidated, onContactsChanged}); callbacks.current = {onLock, onInvalidated, onContactsChanged};
  const addButton = useRef<HTMLButtonElement>(null);

  async function load(next: string | null = null, nextQuery = query) {
    if (mutation.current || pending.current || next && read.current) return;
    read.current?.abort(); const controller = new AbortController(), run = ++generation.current; read.current = controller; retryCursor.current = next;
    setLoading(true); setError(""); if (!next) {setRows([]); setCursor(null); setContextVersion(null);}
    try {
      const page = await loadAddressBookContacts(workspaceId, {q: nextQuery, cursor: next}, controller.signal);
      if (controller.signal.aborted || run !== generation.current) return;
      if (next && contextVersion && page.contextVersion !== contextVersion) throw Object.assign(new Error("Address book context changed."), {status: 409});
      if (page.items.some(contact => !addressBookContactMatches(contact, workspaceId, sourceId))) throw Object.assign(new Error("Address book context changed."), {status: 403});
      setRows(previous => [...new Map((next ? [...previous, ...page.items] : page.items).map(contact => [contact.id, contact])).values()]);
      setCursor(page.nextCursor); setContextVersion(page.contextVersion);
    } catch (caught) {
      if (!controller.signal.aborted && run === generation.current) {
        if (invalidContext(caught)) {setRows([]); setCursor(null); callbacks.current.onInvalidated("The address book or your workspace access changed. Refresh team access.");}
        else if ((caught as RequestError).status === 409) {setRows([]); setCursor(null); setContextVersion(null); setError("The address book changed. Search again for current contacts.");}
        else setError("Organization contacts could not be loaded. Retry to check current records.");
      }
    } finally {if (!controller.signal.aborted && run === generation.current) {read.current = null; setLoading(false);}}
  }

  useEffect(() => () => {generation.current++; read.current?.abort(); mutation.current?.abort(); callbacks.current.onLock(false);}, []);
  useEffect(() => {
    generation.current++; read.current?.abort(); mutation.current?.abort(); pending.current = null; setExpanded(false); setRows([]); setCursor(null); setEditor(null); setDeleting(null); setUncertain(false); setBusy(false); callbacks.current.onLock(false);
  }, [workspaceId, sourceId]);

  const open = () => {setExpanded(true); setNotice(""); void load(null, query);};
  const search = (event?: FormEvent) => {event?.preventDefault(); if (locked || busy || uncertain) return; const next = draftQuery.trim(); setQuery(next); setNotice(""); void load(null, next);};
  const startCreate = () => {setEditor({contact: null, input: emptyInput()}); setDeleting(null); setError(""); setNotice("");};
  const startEdit = (contact: AddressBookContact) => {setEditor({contact, input: inputFromContact(contact)}); setDeleting(null); setError(""); setNotice("");};
  const updateField = (field: keyof AddressBookContactInput, value: string) => setEditor(current => current ? {...current, input: {...current.input, [field]: value}} : current);

  async function execute(operation = pending.current) {
    if (!operation || mutation.current) return;
    pending.current = operation; read.current?.abort(); read.current = null; const controller = new AbortController(), run = ++generation.current; mutation.current = controller;
    setBusy(true); setError(""); setUncertain(false); callbacks.current.onLock(true);
    try {
      if (operation.kind === "delete") {
        const result = await deleteAddressBookContact(workspaceId, operation.contact.id, operation.contact.version, operation.key, controller.signal);
        if (controller.signal.aborted || run !== generation.current) return;
        if (result.contact.workspaceId !== workspaceId || result.contact.sourceId !== sourceId || result.contact.id !== operation.contact.id || result.contact.version !== operation.contact.version + 1) throw Object.assign(new Error("Deletion context changed."), {status: 409});
        setDeleting(null); setNotice(`${operation.contact.displayName} was deleted from the address book. Existing invitations and access were not changed.`);
      } else {
        const result = operation.kind === "create"
          ? await createAddressBookContact(workspaceId, operation.input, operation.key, controller.signal)
          : await updateAddressBookContact(workspaceId, operation.id, operation.input, operation.expectedVersion, operation.key, controller.signal);
        if (controller.signal.aborted || run !== generation.current) return;
        if (!addressBookContactMatches(result.contact, workspaceId, sourceId) || !matchesInput(result.contact, operation.input) || operation.kind === "update" && (result.contact.id !== operation.id || result.contact.version !== operation.expectedVersion + 1)) throw Object.assign(new Error("Saved contact context changed."), {status: 409});
        setEditor(null); setNotice(`${result.contact.displayName} was ${operation.kind === "create" ? "added" : "updated"}. Address-book records do not grant portal access.`);
      }
      pending.current = null; setUncertain(false); setRows([]); setCursor(null); setContextVersion(null); callbacks.current.onContactsChanged(); callbacks.current.onLock(false); queueMicrotask(() => {void load(null, query); addButton.current?.focus();});
    } catch (caught) {
      if (!controller.signal.aborted && run === generation.current) {
        const status = (caught as RequestError).status, code = bodyCode(caught);
        if (invalidContext(caught)) {pending.current = null; callbacks.current.onLock(false); setRows([]); setCursor(null); callbacks.current.onInvalidated("The address book or your workspace access changed. Refresh team access.");}
        else if (code === "address_book_capacity") {pending.current = null; callbacks.current.onLock(false); setError("This address book has reached its contact limit. Delete an unused contact before adding another. Your entered fields are still here.");}
        else if (status === 409 || code === "address_contact_changed" || code === "address_book_cursor_changed") {pending.current = null; callbacks.current.onLock(false); setDeleting(null); setError("This contact changed. Your unsaved fields are still here; refresh the address book before saving again."); queueMicrotask(() => void load(null, query));}
        else if (status && status < 500 && status !== 429) {pending.current = null; callbacks.current.onLock(false); setError("The contact change was not accepted. Review the fields and try again.");}
        else {setUncertain(true); setError("The contact change is not confirmed. Retry the same change before editing another contact or switching workspaces.");}
      }
    } finally {if (!controller.signal.aborted && run === generation.current) {mutation.current = null; setBusy(false);}}
  }

  const save = (event: FormEvent) => {
    event.preventDefault(); if (!editor || locked || busy || uncertain) return;
    const input: AddressBookContactInput = {displayName: normalized(editor.input.displayName), email: normalized(editor.input.email), phone: clean(editor.input.phone ?? ""), company: clean(editor.input.company ?? ""), roleOrTrade: clean(editor.input.roleOrTrade ?? "")};
    if (!input.displayName || !input.email) {setError("Enter a name and valid email address."); return;}
    const operation: SaveOperation = editor.contact
      ? {kind: "update", id: editor.contact.id, expectedVersion: editor.contact.version, input, key: crypto.randomUUID()}
      : {kind: "create", input, key: crypto.randomUUID()};
    void execute(operation);
  };
  const confirmDelete = () => {if (!deleting || locked || busy || uncertain) return; void execute({kind: "delete", contact: deleting, key: crypto.randomUUID()});};

  return <section className="portal-address-book" aria-label="Organization address book">
    <header><div><h3>Organization address book</h3><p>Reusable contact details only. Contacts are not portal users, access grants, billing roles, or notification recipients.</p></div>
      {!expanded && <button type="button" className="button-ghost" onClick={open} disabled={locked}>Manage address book</button>}
    </header>
    {expanded && <>
      <div className="portal-address-book-toolbar"><div role="search" aria-label="Search organization contacts"><label htmlFor="address-book-search">Search contacts</label><div><input id="address-book-search" type="search" maxLength={100} value={draftQuery} disabled={loading || busy || uncertain || locked} onChange={event => setDraftQuery(event.target.value)} onKeyDown={event => {if (event.key === "Enter") search();}} /><button type="button" className="button-ghost" disabled={loading || busy || uncertain || locked} onClick={() => search()}>Search</button></div></div>
        <button ref={addButton} type="button" className="button-orange" disabled={busy || uncertain || locked || Boolean(editor)} onClick={startCreate}>Add contact</button></div>
      {notice && <p role="status" className="portal-address-book-notice">{notice}</p>}
      {error && <div role="alert" className="portal-address-book-error"><p>{error}</p>{uncertain ? <button type="button" className="button-primary" disabled={busy} onClick={() => void execute()}>{busy ? "Saving…" : "Retry same change"}</button> : !editor && !deleting && <button type="button" className="button-ghost" disabled={loading || busy || locked} onClick={() => void load(retryCursor.current, query)}>Retry contacts</button>}</div>}
      {editor && <form className="portal-address-book-editor" onSubmit={save} aria-label={editor.contact ? `Edit ${editor.contact.displayName}` : "Add organization contact"}><h4>{editor.contact ? "Edit contact" : "Add contact"}</h4>
        <div className="portal-address-book-fields"><label>Name<input required maxLength={160} disabled={busy || uncertain} value={editor.input.displayName} onChange={event => updateField("displayName", event.target.value)} /></label><label>Email<input type="email" required maxLength={320} disabled={busy || uncertain} value={editor.input.email} onChange={event => updateField("email", event.target.value)} /></label><label>Phone<input type="tel" maxLength={64} disabled={busy || uncertain} value={editor.input.phone ?? ""} onChange={event => updateField("phone", event.target.value)} /></label><label>Company <span>(optional)</span><input maxLength={160} disabled={busy || uncertain} value={editor.input.company ?? ""} onChange={event => updateField("company", event.target.value)} /></label><label>Role or trade <span>(descriptive only)</span><input maxLength={160} disabled={busy || uncertain} value={editor.input.roleOrTrade ?? ""} onChange={event => updateField("roleOrTrade", event.target.value)} /></label></div>
        <p>Email is required. Company and role or trade are labels only and never grant authority.</p><div className="actions"><button className="button-primary" disabled={busy || uncertain}>{busy ? "Saving…" : editor.contact ? "Save contact" : "Add contact"}</button><button type="button" className="button-ghost" disabled={busy || uncertain} onClick={() => {setEditor(null); setError(""); queueMicrotask(() => addButton.current?.focus());}}>Cancel</button></div></form>}
      {loading && <p role="status">Loading organization contacts…</p>}
      <div className="portal-address-book-list" aria-live="polite">{rows.map(contact => <article key={contact.id}><ContactSummary contact={contact}/><div className="actions"><button type="button" className="button-ghost button-small" disabled={busy || uncertain || locked || Boolean(editor) || Boolean(deleting)} onClick={() => startEdit(contact)}>Edit {contact.displayName}</button><button type="button" className="button-ghost button-small" disabled={busy || uncertain || locked || Boolean(editor) || Boolean(deleting)} onClick={() => {setDeleting(contact); setError("");}}>Delete {contact.displayName}</button></div></article>)}</div>
      {!loading && !error && !rows.length && <p>{cursor ? "No contacts in this page. Load more to continue checking." : query ? "No matching active contacts." : "No active contacts yet."}</p>}
      {cursor && <button type="button" className="button-ghost" disabled={loading || busy || uncertain || locked || Boolean(error)} onClick={() => void load(cursor, query)}>Load more contacts</button>}
      {deleting && <section className="portal-address-book-confirm" aria-label="Confirm contact deletion"><h4>Delete {deleting.displayName}?</h4><p>The contact details will be removed from this address book. This does not revoke invitations, memberships or access, and it does not change earlier service requests.</p><div className="actions"><button type="button" className="button-primary" disabled={busy || uncertain} onClick={confirmDelete}>{busy ? "Deleting…" : uncertain ? "Retry deletion" : "Delete contact"}</button><button type="button" className="button-ghost" disabled={busy || uncertain} onClick={() => setDeleting(null)}>Keep contact</button></div></section>}
    </>}
  </section>;
}

export function PortalAddressBookPicker({workspaceId, sourceId, disabled, selected, onSelect, onClear, onInvalidated}: {
  workspaceId: string; sourceId: string; disabled: boolean; selected: AddressBookContact | null; onSelect: (contact: AddressBookContact) => void; onClear: () => void; onInvalidated: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null), input = useRef<HTMLInputElement>(null), read = useRef<AbortController | null>(null), generation = useRef(0);
  const titleId = useId(), [open, setOpen] = useState(false), [draftQuery, setDraftQuery] = useState(""), [query, setQuery] = useState("");
  const [rows, setRows] = useState<AddressBookContact[]>([]), [cursor, setCursor] = useState<string | null>(null), [contextVersion, setContextVersion] = useState<string | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  async function load(next: string | null = null, nextQuery = query) {
    if (next && read.current) return; read.current?.abort(); const controller = new AbortController(), run = ++generation.current; read.current = controller;
    setLoading(true); setError(""); if (!next) {setRows([]); setCursor(null); setContextVersion(null);}
    try {const page = await loadAddressBookContacts(workspaceId, {q: nextQuery, cursor: next}, controller.signal); if (controller.signal.aborted || run !== generation.current) return;
      if (page.items.some(contact => !addressBookContactMatches(contact, workspaceId, sourceId))) throw Object.assign(new Error("Context changed"), {status: 403});
      if (next && contextVersion && contextVersion !== page.contextVersion) throw Object.assign(new Error("Context changed"), {status: 409});
      setRows(previous => [...new Map((next ? [...previous, ...page.items] : page.items).map(contact => [contact.id, contact])).values()]); setCursor(page.nextCursor); setContextVersion(page.contextVersion);
    } catch (caught) {if (!controller.signal.aborted && run === generation.current) {if (invalidContext(caught)) {setRows([]); setCursor(null); onInvalidated("The address book or your workspace access changed. Refresh team access.");} else setError((caught as RequestError).status === 409 ? "This address book changed. Close the picker and refresh team access." : "Contacts could not be loaded. Retry the search.");}}
    finally {if (!controller.signal.aborted && run === generation.current) {read.current = null; setLoading(false);}}
  }
  const close = () => {read.current?.abort(); generation.current++; setOpen(false); dialog.current?.close(); queueMicrotask(() => trigger.current?.focus());};
  const show = () => {setOpen(true); setQuery(""); setDraftQuery(""); void load(null, "");};
  const search = () => {const next = draftQuery.trim(); setQuery(next); void load(null, next);};
  useEffect(() => {if (open && dialog.current && !dialog.current.open) {dialog.current.showModal(); queueMicrotask(() => input.current?.focus());}}, [open]);
  useEffect(() => () => {generation.current++; read.current?.abort();}, []);
  useEffect(() => {if (open) close(); setRows([]); setCursor(null);}, [workspaceId, sourceId]);
  const keySearch = (event: KeyboardEvent<HTMLInputElement>) => {if (event.key === "Enter") {event.preventDefault(); search();}};
  return <div className="portal-address-book-picker">
    <button ref={trigger} type="button" className="button-ghost" disabled={disabled} onClick={show}>Choose saved contact</button>
    {selected && <div className="portal-address-book-selection" role="status"><span><strong>Copied from {selected.displayName}</strong><small>The email is a snapshot only. This contact is not an identity or access grant.</small></span><button type="button" className="button-ghost button-small" disabled={disabled} onClick={onClear}>Clear saved contact</button></div>}
    {open && <dialog ref={dialog} className="portal-address-book-dialog" aria-labelledby={titleId} onCancel={event => {event.preventDefault(); close();}} onClose={() => setOpen(false)}><header><div><h3 id={titleId}>Choose an organization contact</h3><p>This copies the current email into the invitation. The invitation remains independent from the address-book record.</p></div><button type="button" className="button-ghost" onClick={close} aria-label="Close saved contact picker">Close</button></header>
      <div role="search" aria-label="Search saved contacts" className="portal-address-book-dialog-search"><label htmlFor={`${titleId}-search`}>Search contacts</label><div><input ref={input} id={`${titleId}-search`} type="search" maxLength={100} value={draftQuery} onChange={event => setDraftQuery(event.target.value)} onKeyDown={keySearch}/><button type="button" className="button-ghost" disabled={loading} onClick={search}>Search</button></div></div>
      {loading && <p role="status">Loading saved contacts…</p>}{error && <div role="alert"><p>{error}</p><button type="button" className="button-ghost" disabled={loading} onClick={() => void load(null, query)}>Retry saved contacts</button></div>}
      <div className="portal-address-book-picker-results">{rows.map(contact => <article key={contact.id}><ContactSummary contact={contact}/><button type="button" className="button-orange" aria-label={`Use ${contact.displayName}${contact.company ? ` at ${contact.company}` : ""} — ${contact.email}`} onClick={() => {onSelect(contact); close();}}>Use {contact.displayName} — {contact.email}</button></article>)}</div>
      {!loading && !error && !rows.length && <p>{cursor ? "No contacts in this page. Load more to continue checking." : query ? "No matching contacts." : "No saved contacts with this access."}</p>}
      {cursor && <button type="button" className="button-ghost" disabled={loading || Boolean(error)} onClick={() => void load(cursor, query)}>Load more saved contacts</button>}
    </dialog>}
  </div>;
}
