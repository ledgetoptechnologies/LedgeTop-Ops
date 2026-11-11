import { useCallback, useEffect, useState } from "react";
import { Card, EmptyState, Loading, StatusPill } from "@ltds/ui";
import { api, ApiError } from "./api";
import "./CrmPreview.css";

/**
 * Read-only preview of the synthetic CRM import (draft backend: GET /api/admin/crm/synthetic/*,
 * schema ops.crm.synthetic-read.v1). Owner-only and switched off outside local/dev/test. It shows
 * imported sample records exactly as stored: no matching to clients, no outreach, no edits.
 */
type Row = Record<string, unknown> & { source_record_id: number };
type Page = { schema: string; sourceSystem: string; items: Row[]; page: { nextAfter: number | null } };
type Kind = "contacts" | "contact-log" | "followups" | "interactions" | "status-history";

const text = (value: unknown) => typeof value === "string" && value.trim() ? value : null;
const flag = (value: unknown) => value === true || value === 1;
/** Source codes such as "draft_created" read as "Draft created"; the stored value is unchanged. */
const label = (value: unknown) => { const raw = text(value); return raw ? raw.replace(/_/g, " ").replace(/^./, first => first.toUpperCase()) : null; };
const readFailure = (error: unknown) => error instanceof ApiError
  ? error.status === 404 ? "The CRM preview is switched off here. It only runs in local, development and test setups."
    : error.status === 403 || error.status === 401 ? "Only the Ledge Top owner can open the CRM preview."
    : "The CRM preview couldn't be loaded. Try again in a moment."
  : "The CRM preview couldn't be loaded. Check your connection and try again.";

async function readPage(kind: Kind, params: Record<string, string | number | null>): Promise<Page> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== null) query.set(key, String(value));
  return api<Page>(`/api/admin/crm/synthetic/${kind}${query.size ? `?${query}` : ""}`);
}

/** Dates arrive as stored: a DATE stays a day, an instant shows its time. Nothing is invented. */
function when(value: unknown) {
  const raw = text(value);
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Date(`${raw}T12:00:00Z`).toLocaleDateString(undefined, { dateStyle: "medium", timeZone: "UTC" });
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The owner-only CRM import permission (added by the CRM backend, PR 497); the server checks it again. */
export const canOpenCrmPreview = (user: { permissions: readonly string[] }) => user.permissions.includes("crm.import.manage");

export function CrmPreview() {
  const [contacts, setContacts] = useState<Row[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<Row | null>(null);

  const load = useCallback(async (after: number | null) => {
    setError("");
    try {
      const page = await readPage("contacts", { limit: 50, after });
      setContacts(previous => after === null ? page.items : [...(previous ?? []), ...page.items]);
      setNext(page.page.nextAfter);
    } catch (failure) {
      setError(readFailure(failure));
      if (after === null) setContacts([]);
    }
  }, []);
  useEffect(() => { void load(null); }, [load]);

  return <div className="crm-preview">
    <p className="crm-preview-notice" role="note">
      <strong>Sample data preview.</strong> These records come from the synthetic CRM import. They aren't linked to clients,
      nothing here contacts anyone, and Project Alpha still owns clients and billing.
    </p>
    {error && <p className="crm-preview-error" role="alert">{error} <button type="button" className="button-ghost button-small" onClick={() => void load(null)}>Try again</button></p>}
    <div className="crm-preview-layout">
      <Card title="Contacts">
        {contacts === null ? <Loading /> : !contacts.length ? (!error && <EmptyState title="No imported contacts" detail="Import the synthetic fixture to see sample contacts here." />) : <>
          <ul className="crm-contact-list">
            {contacts.map(contact => <li key={contact.source_record_id}>
              <button type="button" aria-pressed={selected?.source_record_id === contact.source_record_id} onClick={() => setSelected(contact)}>
                <strong>{text(contact.company_name) ?? `Contact ${contact.source_record_id}`}</strong>
                <span>{[text(contact.contact_name), text(contact.contact_type)].filter(Boolean).join(" · ") || "No contact name"}</span>
                <span className="crm-contact-tags">
                  {text(contact.status) && <StatusPill tone="neutral">{String(contact.status)}</StatusPill>}
                  {flag(contact.outreach_paused) && <StatusPill tone="warning">Outreach paused</StatusPill>}
                  <StatusPill tone="neutral">Not linked to a client</StatusPill>
                </span>
              </button>
            </li>)}
          </ul>
          {next !== null && <button type="button" className="button-ghost" disabled={loadingMore}
            onClick={async () => { setLoadingMore(true); await load(next); setLoadingMore(false); }}>{loadingMore ? "Loading…" : "Load more contacts"}</button>}
        </>}
      </Card>
      {selected ? <ContactDetail key={selected.source_record_id} contact={selected} /> :
        <Card title="Contact"><EmptyState title="Choose a contact" detail="Its history, follow-ups and status changes appear here." /></Card>}
    </div>
  </div>;
}

function ContactDetail({ contact }: { contact: Row }) {
  const id = contact.source_record_id;
  const [data, setData] = useState<{ log: Row[]; interactions: Row[]; followups: Row[]; history: Row[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    // Each list stays separate: log entries, interactions and status changes are different source records.
    Promise.all((["contact-log", "interactions", "followups", "status-history"] as const).map(kind => readPage(kind, { contact_id: id, limit: 100 })))
      .then(([log, interactions, followups, history]) => { if (active) setData({ log: log!.items, interactions: interactions!.items, followups: followups!.items, history: history!.items }); })
      .catch(failure => { if (active) setError(readFailure(failure)); });
    return () => { active = false; };
  }, [id]);
  const name = text(contact.company_name) ?? `Contact ${id}`;
  return <Card title={name} className="crm-contact-detail">
    <dl className="crm-facts">
      {([["Contact", contact.contact_name], ["Email", contact.email], ["Phone", contact.phone], ["Website", contact.website], ["Location", contact.location],
        ["Type", contact.contact_type], ["Sport", contact.sport], ["Priority", contact.priority], ["Status", contact.status]] as const)
        .filter(([, value]) => text(value) || typeof value === "number").map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}
      <div><dt>Website</dt><dd>{contact.has_website === 1 ? "Has a website" : contact.has_website === 0 ? "No website" : "Unknown"}</dd></div>
      <div><dt>Source</dt><dd>{String(contact.source_system)} · {String(contact.source_table)} #{id}</dd></div>
    </dl>
    {text(contact.notes) && <p className="crm-notes">{String(contact.notes)}</p>}
    {error ? <p className="crm-preview-error" role="alert">{error}</p> : !data ? <Loading /> : <>
      <Section title="Contact log" rows={data.log} empty="No logged contact." render={row => <>
        <strong>{text(row.subject) ?? label(row.log_type) ?? "Entry"}</strong>
        <span>{[when(row.occurred_at) ?? when(row.log_date), text(row.direction), text(row.channel) ?? text(row.source), text(row.account)].filter(Boolean).join(" · ")}</span>
        {text(row.outcome) && <StatusPill tone={row.outcome === "draft" ? "warning" : "neutral"}>{row.outcome === "draft" ? "Draft, not sent" : label(row.outcome)}</StatusPill>}
      </>} />
      <Section title="Follow-ups" rows={data.followups} empty="No follow-ups." render={row => <>
        <strong>{label(row.action_kind) ?? text(row.method) ?? "Follow-up"}</strong>
        <span>{[when(row.follow_up_date), text(row.responsibility), text(row.notes)].filter(Boolean).join(" · ")}</span>
        <StatusPill tone={flag(row.completed) ? "success" : "neutral"}>{flag(row.completed) ? "Completed" : "Open"}</StatusPill>
      </>} />
      <Section title="Interactions" rows={data.interactions} empty="No interactions." render={row => <>
        <strong>{text(row.type) ?? "Interaction"}</strong><span>{[when(row.interaction_date), text(row.notes)].filter(Boolean).join(" · ")}</span>
      </>} />
      <Section title="Status history" rows={data.history} empty="No status changes." render={row => <>
        <strong>{`${text(row.old_status) ?? "—"} → ${text(row.new_status) ?? "—"}`}</strong><span>{[when(row.changed_at), text(row.changed_by)].filter(Boolean).join(" · ")}</span>
      </>} />
    </>}
  </Card>;
}

function Section({ title, rows, empty, render }: { title: string; rows: Row[]; empty: string; render: (row: Row) => React.ReactNode }) {
  return <section className="crm-section" aria-label={title}>
    <h3>{title}</h3>
    {rows.length ? <ul>{rows.map(row => <li key={row.source_record_id}>{render(row)}</li>)}</ul> : <p className="crm-empty">{empty}</p>}
  </section>;
}
