import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Card, EmptyState, StatusPill } from "@ltds/ui";
import { api, ApiError } from "./api";
import "./OrganizationOperationalContacts.css";

type OrganizationContactRole = "primary_operational" | "delivery";
interface CanonicalRoot { sourceId: string; rootNamespace: "business"; kind: "organization"; publicId: string }
interface ContactOption {
  public_id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  record_type: "business_contact";
}
interface ContactAssignment {
  id: string;
  role: OrganizationContactRole;
  sortOrder: number;
  availability: "available" | "unavailable";
  contact: { id: string; displayName: string; email: string | null; phone: string | null } | null;
}
interface ContactPage {
  available: boolean;
  reason: "permission_required" | "workspace_unavailable" | "not_applicable" | null;
  nextCursor: string | null;
  hasMore: boolean;
  returned: number;
  limit: number;
}
interface OrganizationContactWorkspace {
  canonicalRoot: CanonicalRoot;
  contextVersion: string;
  organization: { id: string; sourceId: string; revision: string };
  contacts: {
    version: number;
    assignments: ContactAssignment[];
    revisions: Array<{ version: number; actorId: string; createdAt: string }>;
  };
  capabilities: { canManageOrganizationContacts: boolean };
  contactOptions: ContactOption[];
  contactPage: ContactPage;
}
interface ContactDraft {
  assignmentId: string | null;
  contactId: string;
  role: OrganizationContactRole;
  unavailable: boolean;
  unavailableName: string | null;
}
interface Attempt { fingerprint: string; key: string }
interface MutationResult { sourceId: string; organizationId: string; version: number; replayed: boolean }

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const rootKey = (root: CanonicalRoot) => JSON.stringify([root.sourceId, root.rootNamespace, root.kind, root.publicId]);
const invalidatesWorkspace = (error: unknown): error is ApiError => error instanceof ApiError && [401, 403, 404, 409].includes(error.status);
const mutationKey = (attempt: MutableRefObject<Attempt | null>, payload: unknown) => {
  const fingerprint = JSON.stringify(payload);
  if (attempt.current?.fingerprint === fingerprint) return attempt.current.key;
  const key = crypto.randomUUID();
  attempt.current = { fingerprint, key };
  return key;
};
const displayDate = (value: string) => {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.valueOf()) ? parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Date unavailable";
};

function validContact(value: unknown): value is ContactAssignment["contact"] {
  return value === null || (object(value) && typeof value.id === "string" && typeof value.displayName === "string"
    && (value.email === null || typeof value.email === "string") && (value.phone === null || typeof value.phone === "string"));
}

function validWorkspace(value: unknown, root: CanonicalRoot, contextVersion: string, previousCursor?: string): value is OrganizationContactWorkspace {
  if (!object(value) || !object(value.canonicalRoot) || !object(value.organization) || !object(value.contacts)
    || !object(value.capabilities) || !object(value.contactPage)) return false;
  const candidate = value as unknown as OrganizationContactWorkspace;
  const assignments = candidate.contacts.assignments;
  const assignmentIds = new Set<string>(), pairs = new Set<string>(), sortOrders = new Set<number>();
  const validAssignments = Array.isArray(assignments) && assignments.length <= 100 && assignments.every(item => {
    if (!object(item) || typeof item.id !== "string" || !["primary_operational", "delivery"].includes(item.role)
      || !Number.isSafeInteger(item.sortOrder) || item.sortOrder < 0 || item.sortOrder > 99
      || !["available", "unavailable"].includes(item.availability) || !validContact(item.contact)
      || (item.availability === "available") !== (item.contact !== null)) return false;
    const pair = `${item.role}\u0000${item.contact?.id || item.id}`;
    if (assignmentIds.has(item.id) || pairs.has(pair) || sortOrders.has(item.sortOrder)) return false;
    assignmentIds.add(item.id); pairs.add(pair); sortOrders.add(item.sortOrder); return true;
  });
  const validOptions = Array.isArray(candidate.contactOptions) && candidate.contactOptions.every(option => object(option)
    && option.record_type === "business_contact" && typeof option.public_id === "string" && typeof option.display_name === "string"
    && (option.email === null || typeof option.email === "string") && (option.phone === null || typeof option.phone === "string"));
  const validRevisions = Array.isArray(candidate.contacts.revisions) && candidate.contacts.revisions.every(item => object(item)
    && Number.isSafeInteger(item.version) && item.version > 0 && typeof item.actorId === "string" && typeof item.createdAt === "string");
  const page = candidate.contactPage;
  return rootKey(candidate.canonicalRoot) === rootKey(root) && candidate.contextVersion === contextVersion
    && candidate.organization.id === root.publicId && candidate.organization.sourceId === root.sourceId
    && typeof candidate.organization.revision === "string" && candidate.organization.revision.length > 0
    && Number.isSafeInteger(candidate.contacts.version) && candidate.contacts.version >= 0 && validAssignments
    && assignments.filter(item => item.role === "primary_operational").length <= 1 && validRevisions
    && typeof candidate.capabilities.canManageOrganizationContacts === "boolean" && validOptions
    && typeof page.available === "boolean" && [null, "permission_required", "workspace_unavailable", "not_applicable"].includes(page.reason)
    && (page.nextCursor === null || typeof page.nextCursor === "string") && typeof page.hasMore === "boolean"
    && Number.isSafeInteger(page.limit) && page.limit > 0 && page.limit <= 25
    && Number.isSafeInteger(page.returned) && page.returned === candidate.contactOptions.length && page.returned <= page.limit
    && (!page.hasMore || (page.available && Boolean(page.nextCursor) && page.nextCursor !== previousCursor))
    && (page.available ? page.reason === null : page.reason !== null && !page.hasMore && page.nextCursor === null && page.returned === 0);
}

function assignedOptions(workspace: OrganizationContactWorkspace): ContactOption[] {
  const options = new Map(workspace.contactOptions.map(option => [option.public_id, option]));
  for (const assignment of workspace.contacts.assignments) {
    if (assignment.availability !== "available" || !assignment.contact || options.has(assignment.contact.id)) continue;
    options.set(assignment.contact.id, { public_id: assignment.contact.id, display_name: assignment.contact.displayName,
      email: assignment.contact.email, phone: assignment.contact.phone, record_type: "business_contact" });
  }
  return [...options.values()];
}

function drafts(workspace: OrganizationContactWorkspace): ContactDraft[] {
  return workspace.contacts.assignments.map(item => ({ assignmentId: item.id, contactId: item.contact?.id || "", role: item.role,
    unavailable: item.availability === "unavailable", unavailableName: item.contact?.displayName || (item.availability === "unavailable" ? "Unavailable synchronized contact" : null) }));
}

function ContactSummary({ assignment }: { assignment: ContactAssignment }) {
  return <article>
    <div><strong>{assignment.contact?.displayName || "Unavailable synchronized contact"}</strong>
      {assignment.contact && <small>{[assignment.contact.email, assignment.contact.phone].filter(Boolean).join(" · ") || "No contact details provided"}</small>}
    </div>
    <StatusPill tone={assignment.availability === "available" ? "neutral" : "warning"}>{assignment.availability}</StatusPill>
  </article>;
}

export function OrganizationOperationalContacts({ root, contextVersion, contextSignal, onInvalidated }: {
  root: CanonicalRoot;
  contextVersion: string;
  contextSignal: AbortSignal;
  onInvalidated: (message: string) => void;
}) {
  const endpoint = `/api/client-hub/sources/${encodeURIComponent(root.sourceId)}/business/organizations/${encodeURIComponent(root.publicId)}/organization-operational-contacts`;
  const [state, setState] = useState<{ data: OrganizationContactWorkspace | null; busy: boolean; error: string }>({ data: null, busy: true, error: "" });
  const [revision, setRevision] = useState(0), [editing, setEditing] = useState(false), [draft, setDraft] = useState<ContactDraft[]>([]);
  const [options, setOptions] = useState<ContactOption[]>([]), [page, setPage] = useState<ContactPage | null>(null);
  const [optionsBusy, setOptionsBusy] = useState(false), [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState(""), [status, setStatus] = useState("");
  const active = useRef(true), pending = useRef<AbortController | null>(null), sequence = useRef(0), attempt = useRef<Attempt | null>(null);

  useEffect(() => {
    active.current = true;
    const controller = new AbortController(), request = ++sequence.current;
    pending.current?.abort(); pending.current = controller;
    const abort = () => controller.abort(); contextSignal.addEventListener("abort", abort);
    setState(previous => ({ data: previous.data, busy: true, error: "" }));
    const query = new URLSearchParams({ expectedContextVersion: contextVersion });
    void api<unknown>(`${endpoint}?${query}`, { signal: controller.signal }).then(result => {
      if (!active.current || controller.signal.aborted || request !== sequence.current) return;
      if (!validWorkspace(result, root, contextVersion)) throw new ApiError("Organization ownership or contact context changed. Refresh the client workspace.", 409, {});
      setState({ data: result, busy: false, error: "" }); setOptions(assignedOptions(result)); setPage(result.contactPage); setDraft(drafts(result));
    }).catch(error => {
      if (!active.current || controller.signal.aborted || request !== sequence.current) return;
      const message = error instanceof Error ? error.message : "Organization contacts could not be loaded.";
      if (invalidatesWorkspace(error)) onInvalidated(message); else setState(previous => ({ data: previous.data, busy: false, error: message }));
    });
    return () => { active.current = false; controller.abort(); contextSignal.removeEventListener("abort", abort); };
  }, [endpoint, contextVersion, revision]);

  const refresh = () => {
    if (state.busy) return;
    pending.current?.abort(); sequence.current += 1; setEditing(false); setEditorError(""); attempt.current = null;
    setRevision(value => value + 1);
  };
  const begin = () => {
    if (!state.data) return;
    setDraft(drafts(state.data)); setEditorError(""); setStatus(""); attempt.current = null; setEditing(true);
  };
  const cancel = () => { setEditing(false); setEditorError(""); setStatus("Changes cancelled."); attempt.current = null; };

  const loadMore = async () => {
    const data = state.data;
    if (!data || optionsBusy || !page?.hasMore || !page.nextCursor || contextSignal.aborted) return;
    const controller = new AbortController(), request = ++sequence.current, previousCursor = page.nextCursor;
    pending.current?.abort(); pending.current = controller; setOptionsBusy(true); setEditorError("");
    const abort = () => controller.abort(); contextSignal.addEventListener("abort", abort, { once: true });
    try {
      const query = new URLSearchParams({ expectedContextVersion: contextVersion, contactCursor: previousCursor });
      const result = await api<unknown>(`${endpoint}?${query}`, { signal: controller.signal });
      if (!active.current || controller.signal.aborted || request !== sequence.current) return;
      if (!validWorkspace(result, root, contextVersion, previousCursor)
        || result.contacts.version !== data.contacts.version || result.organization.revision !== data.organization.revision
        || result.capabilities.canManageOrganizationContacts !== data.capabilities.canManageOrganizationContacts)
        throw new ApiError("Organization contacts changed. Refresh the client workspace before continuing.", 409, {});
      setOptions(current => {
        const merged = new Map(current.map(option => [option.public_id, option]));
        for (const option of assignedOptions(result)) merged.set(option.public_id, option);
        return [...merged.values()];
      });
      setPage(result.contactPage);
    } catch (error) {
      if (!active.current || controller.signal.aborted || request !== sequence.current) return;
      const message = error instanceof Error ? error.message : "More organization contacts could not be loaded.";
      if (invalidatesWorkspace(error)) onInvalidated(message); else setEditorError(message);
    } finally {
      contextSignal.removeEventListener("abort", abort);
      if (active.current && request === sequence.current) setOptionsBusy(false);
    }
  };

  const save = async () => {
    const data = state.data;
    if (!data || saving || contextSignal.aborted) return;
    if (draft.length > 100) { setEditorError("An organization can have at most 100 operational contact assignments."); return; }
    if (draft.some(item => item.unavailable || !item.contactId)) { setEditorError("Replace or remove unavailable assignments and choose a contact for every delivery row before saving."); return; }
    if (draft.some(item => !options.some(option => option.public_id === item.contactId))) { setEditorError("Every assignment must use an active contact from this exact organization and source."); return; }
    if (draft.filter(item => item.role === "primary_operational").length > 1) { setEditorError("Choose at most one primary operational contact."); return; }
    const pairs = draft.map(item => `${item.role}\u0000${item.contactId}`);
    if (new Set(pairs).size !== pairs.length) { setEditorError("The same contact cannot be assigned to the same role twice."); return; }
    const payload = { expectedContextVersion: contextVersion, expectedVersion: data.contacts.version,
      assignments: draft.map(item => ({ contactId: item.contactId, role: item.role })) };
    const idempotencyKey = mutationKey(attempt, payload);
    const controller = new AbortController(), request = ++sequence.current;
    pending.current?.abort(); pending.current = controller;
    const abort = () => controller.abort(); contextSignal.addEventListener("abort", abort, { once: true });
    setSaving(true); setEditorError(""); setStatus("Saving organization contacts…");
    try {
      const result = await api<unknown>(endpoint, { method: "POST", body: JSON.stringify({ ...payload, idempotencyKey }), signal: controller.signal });
      if (!active.current || controller.signal.aborted || request !== sequence.current) return;
      if (!object(result) || result.sourceId !== root.sourceId || result.organizationId !== root.publicId
        || result.version !== data.contacts.version + 1 || typeof result.replayed !== "boolean")
        throw new Error("The organization-contact save response could not be verified. Your edits are still available.");
      const query = new URLSearchParams({ expectedContextVersion: contextVersion });
      const verified = await api<unknown>(`${endpoint}?${query}`, { signal: controller.signal });
      if (!active.current || controller.signal.aborted || request !== sequence.current) return;
      if (!validWorkspace(verified, root, contextVersion) || verified.contacts.version !== result.version)
        throw new ApiError("Organization contacts changed before the save could be verified. Refresh the client workspace.", 409, {});
      attempt.current = null; setState({ data: verified, busy: false, error: "" }); setOptions(assignedOptions(verified));
      setPage(verified.contactPage); setDraft(drafts(verified)); setEditing(false); setStatus("Organization contacts saved.");
    } catch (error) {
      if (!active.current || controller.signal.aborted || request !== sequence.current) return;
      const message = error instanceof Error ? error.message : "Organization contacts could not be saved.";
      if (invalidatesWorkspace(error)) onInvalidated(message); else { setEditorError(message); setStatus(""); }
    } finally {
      contextSignal.removeEventListener("abort", abort);
      if (active.current && request === sequence.current) setSaving(false);
    }
  };

  const data = state.data;
  const primary = data?.contacts.assignments.find(item => item.role === "primary_operational") || null;
  const deliveries = data?.contacts.assignments.filter(item => item.role === "delivery") || [];
  const primaryDraft = draft.find(item => item.role === "primary_operational") || null;
  const deliveryDrafts = draft.filter(item => item.role === "delivery");
  const replaceDraft = (target: ContactDraft, patch: Partial<ContactDraft>) => setDraft(current => current.map(item => item === target ? { ...item, ...patch } : item));

  return <Card title="Organization contacts">
    <section className="organization-operational-contacts" aria-label="Organization operational contacts" aria-busy={state.busy || saving || optionsBusy}>
      <p>These contacts are operational reference roles only. They do not grant portal access, delivery access, billing authority, or notification authority.</p>
      {!data && state.busy && <p role="status">Loading organization contacts…</p>}
      {!data && state.error && <><div role="alert"><EmptyState title="Organization contacts unavailable" detail={state.error} /></div>
        <button type="button" className="button-ghost" onClick={refresh}>Retry organization contacts</button></>}
      {data && <>
        {state.error && <div className="organization-operational-banner" role="alert"><span>{state.error}</span><button type="button" className="button-ghost" onClick={refresh}>Retry refresh</button></div>}
        {!editing ? <>
          <div className="organization-operational-groups">
            <section aria-labelledby="primary-operational-heading"><h3 id="primary-operational-heading">Primary operational contact</h3>
              {primary ? <ContactSummary assignment={primary} /> : <EmptyState title="No primary operational contact assigned" detail="This role is optional and does not control portal administration." />}</section>
            <section aria-labelledby="delivery-contacts-heading"><h3 id="delivery-contacts-heading">Delivery contacts</h3>
              {deliveries.length ? <div className="organization-operational-list">{deliveries.map(item => <ContactSummary key={item.id} assignment={item} />)}</div>
                : <EmptyState title="No delivery contacts assigned" detail="Delivery contacts are reference information, not notification recipients." />}</section>
          </div>
          {data.capabilities.canManageOrganizationContacts && <button type="button" className="button-orange" onClick={begin}>Edit organization contacts</button>}
        </> : <form onSubmit={event => { event.preventDefault(); void save(); }}>
          {!page?.available && <p className="organization-operational-banner" role="status">The exact-source contact directory is unavailable. Existing assignments remain visible, but new contacts cannot be selected.</p>}
          <div className="organization-operational-editor">
            <fieldset><legend>Primary operational contact</legend>
              {primaryDraft?.unavailable && <p role="alert">{primaryDraft.unavailableName} is no longer active in this organization. Choose a replacement or clear this role.</p>}
              <label>Primary operational contact<select aria-label="Primary operational contact" value={primaryDraft?.contactId || ""}
                disabled={!page?.available}
                onChange={event => setDraft(current => {
                  const withoutPrimary = current.filter(item => item.role !== "primary_operational");
                  return event.target.value ? [{ assignmentId: primaryDraft?.assignmentId || null, contactId: event.target.value,
                    role: "primary_operational", unavailable: false, unavailableName: null }, ...withoutPrimary] : withoutPrimary;
                })}>
                <option value="">No primary operational contact</option>{options.map(option => <option key={option.public_id} value={option.public_id}>{option.display_name}</option>)}</select></label>
              {primaryDraft?.unavailable && <button type="button" className="button-ghost"
                onClick={() => setDraft(current => current.filter(item => item.role !== "primary_operational"))}>Clear unavailable primary contact</button>}
              <small>This role is an Operations reference. It is not a portal organization administrator.</small>
            </fieldset>
            <fieldset><legend>Delivery contacts</legend>
              {deliveryDrafts.length ? <div className="organization-operational-delivery-editor">{deliveryDrafts.map((item, index) => <div key={item.assignmentId || `delivery-${index}`}>
                {item.unavailable && <p role="alert">{item.unavailableName} is no longer active. Choose a replacement or remove this delivery contact.</p>}
                <label>{`Delivery contact ${index + 1}`}<select aria-label={`Delivery contact ${index + 1}`} value={item.contactId} disabled={!page?.available}
                  onChange={event => replaceDraft(item, { contactId: event.target.value, unavailable: false, unavailableName: null })}>
                  <option value="">Choose an active contact</option>{options.map(option => <option key={option.public_id} value={option.public_id}>{option.display_name}</option>)}</select></label>
                <button type="button" className="button-ghost" onClick={() => setDraft(current => current.filter(entry => entry !== item))}>{`Remove delivery contact ${index + 1}`}</button>
              </div>)}</div> : <p>No delivery contact rows. Add one only when an operational reference is useful.</p>}
              <button type="button" className="button-ghost" disabled={!page?.available || draft.length >= 100}
                onClick={() => setDraft(current => [...current, { assignmentId: null, contactId: "", role: "delivery", unavailable: false, unavailableName: null }])}>Add delivery contact</button>
              <small>These assignments do not subscribe anyone to delivery notifications.</small>
            </fieldset>
          </div>
          <div className="organization-operational-actions">
            {page?.hasMore && <button type="button" className="button-ghost" aria-disabled={optionsBusy} onClick={() => { if (!optionsBusy) void loadMore(); }}>
              {optionsBusy ? "Loading contacts…" : "Load more available contacts"}</button>}
            <button type="submit" className="button-orange" disabled={saving}>{saving ? "Saving contacts…" : "Save organization contacts"}</button>
            <button type="button" className="button-ghost" disabled={saving} onClick={cancel}>Cancel contact changes</button>
          </div>
        </form>}
        {editorError && <p className="organization-operational-error" role="alert">{editorError}</p>}
        <p role="status">{status}</p>
        {data.contacts.revisions.length > 0 && <details><summary>Organization contact history</summary><ol>
          {data.contacts.revisions.map(item => <li key={item.version}>Version {item.version} · {displayDate(item.createdAt)}</li>)}</ol></details>}
      </>}
    </section>
  </Card>;
}
