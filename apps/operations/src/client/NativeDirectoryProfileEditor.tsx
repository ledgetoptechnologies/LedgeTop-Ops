import { useEffect, useId, useState, type FormEvent } from "react";
import { Card } from "@ltds/ui";
import { api, ApiError } from "./api";

type Kind = "organization" | "client";
type RouteKind = "organizations" | "standalone-clients";
type Scope = { businessAreaId: string; divisionId: string | null };
type ProfileForm = {
  name: string; generalEmail: string; generalPhone: string; email: string; phone: string;
  clientType: "unknown" | "business" | "consumer"; addressLine1: string; addressLine2: string;
  city: string; state: string; postalCode: string; country: string;
};
type ProfileSnapshot = {
  recordId: string; kind: Kind; version: number; profile: ProfileForm; scopes: Scope[];
  linkage?: "standalone" | "linked" | "unavailable";
  relationship?: { version: number; organization: OrganizationChoice | null; organizations: OrganizationChoice[] } | null;
  editing: { available: boolean; reason: string | null };
};
type OrganizationChoice = { recordId: string; expectedVersion: number; name: string };
interface CreateOptions { kind: Kind; sources: Array<{ id: string; name: string }>;
  scopes: Array<{ id: string; name: string; divisions: Array<{ id: string; name: string }> }>;
  organizations: Array<OrganizationChoice & { sourceIds: string[] }> }

const EMPTY: ProfileForm = { name: "", generalEmail: "", generalPhone: "", email: "", phone: "", clientType: "unknown",
  addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", country: "" };
const routeKind = (kind: Kind): RouteKind => kind === "organization" ? "organizations" : "standalone-clients";
const message = (caught: unknown, fallback: string) => caught instanceof Error ? caught.message : fallback;
function profileFor(kind: Kind, fields: ProfileForm) {
  const address = { addressLine1: fields.addressLine1.trim(), addressLine2: fields.addressLine2.trim(), city: fields.city.trim(),
    state: fields.state.trim(), postalCode: fields.postalCode.trim(), country: fields.country.trim() };
  return kind === "organization" ? { name: fields.name.trim(), generalEmail: fields.generalEmail.trim(), generalPhone: fields.generalPhone.trim(), ...address }
    : { name: fields.name.trim(), email: fields.email.trim(), phone: fields.phone.trim(), clientType: fields.clientType, ...address };
}
function usableOrganizationChoice(value: unknown): value is OrganizationChoice {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).recordId === "string"
    && Number.isSafeInteger((value as Record<string, unknown>).expectedVersion)
    && Number((value as Record<string, unknown>).expectedVersion) > 0
    && typeof (value as Record<string, unknown>).name === "string";
}
function usableSnapshot(value: unknown, kind: Kind, recordId: string): value is ProfileSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>, profile = row.profile;
  const profileKeys = kind === "organization"
    ? ["name", "generalEmail", "generalPhone", "addressLine1", "addressLine2", "city", "state", "postalCode", "country"]
    : ["name", "email", "phone", "clientType", "addressLine1", "addressLine2", "city", "state", "postalCode", "country"];
  return row.recordId === recordId && row.kind === kind && Number.isSafeInteger(row.version) && Number(row.version) > 0
    && profile !== null && typeof profile === "object" && !Array.isArray(profile)
    && profileKeys.every(key => typeof (profile as Record<string, unknown>)[key] === "string")
    && Array.isArray(row.scopes) && row.scopes.length > 0 && row.scopes.every(scope => scope && typeof scope === "object"
      && typeof (scope as Record<string, unknown>).businessAreaId === "string"
      && ((scope as Record<string, unknown>).divisionId === null || typeof (scope as Record<string, unknown>).divisionId === "string"))
    && (kind !== "client" || (row.relationship !== null && typeof row.relationship === "object" && !Array.isArray(row.relationship)
      && Number.isSafeInteger((row.relationship as Record<string, unknown>).version)
      && Number((row.relationship as Record<string, unknown>).version) > 0
      && ((row.relationship as Record<string, unknown>).organization === null
        || usableOrganizationChoice((row.relationship as Record<string, unknown>).organization))
      && Array.isArray((row.relationship as Record<string, unknown>).organizations)
      && ((row.relationship as Record<string, unknown>).organizations as unknown[]).every(usableOrganizationChoice)))
    && row.editing !== null && typeof row.editing === "object" && !Array.isArray(row.editing)
    && typeof (row.editing as Record<string, unknown>).available === "boolean"
    && ((row.editing as Record<string, unknown>).reason === null || typeof (row.editing as Record<string, unknown>).reason === "string");
}

function ProfileFields({ kind, value, onChange, prefix, creating }: { kind: Kind; value: ProfileForm;
  onChange: (field: keyof ProfileForm, value: string) => void; prefix: string; creating: boolean }) {
  const field = (key: keyof ProfileForm, label: string, maxLength: number, required = false) => <label htmlFor={`${prefix}-${key}`}>{label}
    <input id={`${prefix}-${key}`} maxLength={maxLength} required={required} value={value[key]}
      onChange={event => onChange(key, event.target.value)} /></label>;
  return <div className="client-directory-profile-fields">
    {field("name", kind === "organization" ? "Organization name" : "Client name", 150, true)}
    {kind === "organization" ? <>{field("generalEmail", "General email", 255)}{field("generalPhone", "General phone", 50)}</>
      : <>{field("email", "Email", 255)}{field("phone", "Phone", 50)}{creating && <label htmlFor={`${prefix}-clientType`}>Client type
        <select id={`${prefix}-clientType`} value={value.clientType} onChange={event => onChange("clientType", event.target.value)}>
          <option value="unknown">Unknown</option><option value="business">Business</option><option value="consumer">Consumer</option>
        </select></label>}</>}
    {field("addressLine1", "Address line 1", 255)}{field("addressLine2", "Address line 2", 255)}
    {field("city", "City", 100)}{field("state", "State", kind === "client" ? 2 : 100)}
    {field("postalCode", "Postal code", kind === "client" ? 20 : 32)}{field("country", "Country", 100)}
  </div>;
}

function status(result: { status?: unknown }): string {
  return result.status === "written" ? "Saved in Client Hub." : "Saved in Client Hub and queued for Project Alpha delivery.";
}

export function NativeDirectoryProfileCreate() {
  const id = useId(), [kind, setKind] = useState<Kind>("organization"), [fields, setFields] = useState<ProfileForm>(EMPTY);
  const [sourceIds, setSourceIds] = useState<string[]>([]), [selectedScope, setSelectedScope] = useState(""), [options, setOptions] = useState<CreateOptions | null>(null);
  const [organizationId, setOrganizationId] = useState("");
  const [optionsError, setOptionsError] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [success, setSuccess] = useState("");
  useEffect(() => {
    let active = true; setOptions(null); setOptionsError(""); setSourceIds([]); setSelectedScope(""); setOrganizationId("");
    void api<unknown>(`/api/client-hub/directory/create-options?kind=${kind}`).then(value => {
      if (!active || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Client profile setup choices could not be verified.");
      const result = value as CreateOptions;
      if (result.kind !== kind || !Array.isArray(result.sources) || !Array.isArray(result.scopes)
        || !Array.isArray(result.organizations)) throw new Error("Client profile setup choices could not be verified.");
      setOptions(result);
    }).catch(caught => { if (active) setOptionsError(message(caught, "Client profile setup choices could not be loaded.")); });
    return () => { active = false; };
  }, [kind]);
  const change = (field: keyof ProfileForm, value: string) => setFields(previous => ({ ...previous,
    [field]: field === "clientType" && ["unknown", "business", "consumer"].includes(value) ? value : value }));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy || !sourceIds.length || !selectedScope) return;
    const [businessAreaId, divisionId] = selectedScope.split("\0"), mutationId = crypto.randomUUID(), profile = profileFor(kind, fields);
    if (!businessAreaId) return;
    const scopes = [{ businessAreaId, divisionId: divisionId || null }], selectedOrganization = options?.organizations.find(value => value.recordId === organizationId);
    const relationship = selectedOrganization
      ? { organizationRecordId: selectedOrganization.recordId, expectedOrganizationVersion: selectedOrganization.expectedVersion }
      : { organizationRecordId: null, expectedOrganizationVersion: null };
    const intent = { kind, mutationId, sourceIds, scopes, profile, ...(kind === "client" ? { relationship } : {}) };
    setBusy(true); setError(""); setSuccess("");
    try {
      await api("/api/client-hub/directory/create-admissions", { method: "POST", headers: { "Idempotency-Key": mutationId }, body: JSON.stringify(intent) });
      const result = await api<{ status?: unknown }>(`/api/client-hub/directory/${routeKind(kind)}`, { method: "POST",
        headers: { "Idempotency-Key": mutationId }, body: JSON.stringify({ mutationId, sourceIds, scopes, profile,
          ...(kind === "client" ? { relationship } : {}) }) });
      setSuccess(status(result)); setFields(EMPTY); setSourceIds([]); setSelectedScope("");
    } catch (caught) { setError(message(caught, "The client profile could not be created.")); }
    finally { setBusy(false); }
  };
  const scopeOptions = options?.scopes.flatMap(area => [{ value: `${area.id}\0`, label: area.name },
    ...area.divisions.map(division => ({ value: `${area.id}\0${division.id}`, label: `${area.name} · ${division.name}` }))]) ?? [];
  const selectedOrganization = options?.organizations.find(value => value.recordId === organizationId), availableSources = selectedOrganization
    ? options?.sources.filter(source => selectedOrganization.sourceIds.includes(source.id)) ?? [] : options?.sources ?? [];
  return <Card title="Add client profile"><p>Create a Project Alpha-backed organization or client. Client Hub derives source authority on the server; this form records the selected destination, business scope, profile, and optional organization relationship.</p>
    {optionsError && <p role="alert">{optionsError}</p>}{!options && !optionsError && <p role="status">Loading client profile choices…</p>}
    {options && (!options.sources.length || !scopeOptions.length) ? <p role="status">No permitted Project Alpha destinations and business scopes are available for a new client profile.</p> : options && <form onSubmit={event => void submit(event)} className="client-directory-profile-form">
      <label htmlFor={`${id}-kind`}>Profile type<select id={`${id}-kind`} value={kind} onChange={event => setKind(event.target.value === "client" ? "client" : "organization")}>
        <option value="organization">Organization</option><option value="client">Client</option>
      </select></label>
      {kind === "client" && <label htmlFor={`${id}-organization`}>Organization relationship<select id={`${id}-organization`} value={organizationId}
        onChange={event => { setOrganizationId(event.target.value); setSourceIds(previous => {
          const next = options.organizations.find(value => value.recordId === event.target.value);
          return next ? previous.filter(sourceId => next.sourceIds.includes(sourceId)) : previous;
        }); }}>
        <option value="">No organization (standalone client)</option>
        {options.organizations.map(organization => <option key={organization.recordId} value={organization.recordId}>{organization.name}</option>)}
      </select><small>Choose an organization to create a linked client, or leave this standalone.</small></label>}
      <label htmlFor={`${id}-sources`}>Project Alpha destinations<select id={`${id}-sources`} multiple required value={sourceIds}
        onChange={event => setSourceIds([...event.currentTarget.selectedOptions].map(option => option.value))}>
        {availableSources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
      </select><small>Choose every Project Alpha destination that should receive this profile.</small></label>
      <label htmlFor={`${id}-scope`}>Business scope<select id={`${id}-scope`} required value={selectedScope} onChange={event => setSelectedScope(event.target.value)}>
        <option value="">Choose a business scope</option>{scopeOptions.map(scope => <option key={scope.value} value={scope.value}>{scope.label}</option>)}</select></label>
      <ProfileFields kind={kind} value={fields} onChange={change} prefix={id} creating />
      {error && <p role="alert">{error}</p>}{success && <p role="status">{success}</p>}
      <button className="button-orange" disabled={busy || !sourceIds.length || !selectedScope}>{busy ? "Saving profile…" : `Create ${kind === "organization" ? "organization" : "client"}`}</button>
    </form>}
  </Card>;
}

export function NativeDirectoryProfileEdit({ kind, recordId }: { kind: Kind; recordId: string }) {
  const id = useId(), [snapshot, setSnapshot] = useState<ProfileSnapshot | null>(null), [fields, setFields] = useState<ProfileForm>(EMPTY);
  const [loading, setLoading] = useState(true), [missing, setMissing] = useState(false), [error, setError] = useState(""), [success, setSuccess] = useState(""), [busy, setBusy] = useState(false);
  const [relationshipOrganizationId, setRelationshipOrganizationId] = useState(""), [relationshipBusy, setRelationshipBusy] = useState(false);
  const load = async () => {
    setLoading(true); setError("");
    try {
      const value = await api<unknown>(`/api/client-hub/directory/${routeKind(kind)}/${encodeURIComponent(recordId)}`);
      if (!usableSnapshot(value, kind, recordId)) throw new Error("The client profile could not be verified.");
      setSnapshot(value); setFields({ ...EMPTY, ...value.profile }); setRelationshipOrganizationId(value.relationship?.organization?.recordId ?? ""); setMissing(false);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 404) { setMissing(true); setSnapshot(null); }
      else setError(message(caught, "The client profile could not be loaded."));
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [kind, recordId]);
  const change = (field: keyof ProfileForm, value: string) => setFields(previous => ({ ...previous, [field]: value }));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!snapshot || busy) return;
    const mutationId = crypto.randomUUID(); setBusy(true); setError(""); setSuccess("");
    try {
      const result = await api<{ status?: unknown }>(`/api/client-hub/directory/${routeKind(kind)}/${encodeURIComponent(recordId)}`, {
        method: "PATCH", headers: { "Idempotency-Key": mutationId },
        body: JSON.stringify({ mutationId, expectedLocalVersion: snapshot.version, profile: profileFor(kind, fields) }),
      });
      setSuccess(status(result)); await load();
    } catch (caught) { setError(message(caught, "The client profile could not be updated.")); }
    finally { setBusy(false); }
  };
  const submitRelationship = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!snapshot?.relationship || relationshipBusy) return;
    const selected = snapshot.relationship.organizations.find(value => value.recordId === relationshipOrganizationId) ?? null;
    const mutationId = crypto.randomUUID(); setRelationshipBusy(true); setError(""); setSuccess("");
    try {
      const result = await api<{ status?: unknown }>(`/api/client-hub/directory/standalone-clients/${encodeURIComponent(recordId)}/relationship`, {
        method: "POST", headers: { "Idempotency-Key": mutationId }, body: JSON.stringify({ mutationId,
          expectedRelationshipVersion: snapshot.relationship.version,
          organization: selected ? { recordId: selected.recordId, expectedVersion: selected.expectedVersion } : null }),
      });
      setSuccess(result.status === "written" ? "Organization relationship saved." : "Organization relationship saved and queued for Project Alpha delivery.");
      await load();
    } catch (caught) { setError(message(caught, "The organization relationship could not be updated.")); }
    finally { setRelationshipBusy(false); }
  };
  if (missing) return null;
  if (loading) return <Card title="Client profile"><p role="status">Loading client profile…</p></Card>;
  if (error && !snapshot) return <Card title="Client profile"><p role="alert">{error}</p><button type="button" className="button-ghost" onClick={() => void load()}>Retry profile</button></Card>;
  if (!snapshot) return null;
  if (!snapshot.editing.available) return <Card title="Client profile"><p>This client profile is read-only because its current relationship or destination evidence is unavailable.</p></Card>;
  return <Card title="Edit client profile"><p>Editing version {snapshot.version}. The current server-owned profile is loaded before any change is submitted.</p>
    <form onSubmit={event => void submit(event)} className="client-directory-profile-form"><ProfileFields kind={kind} value={fields} onChange={change} prefix={id} creating={false} />
      {error && <p role="alert">{error}</p>}{success && <p role="status">{success}</p>}
      <button className="button-orange" disabled={busy}>{busy ? "Saving profile…" : "Save client profile"}</button>
    </form>
    {kind === "client" && snapshot.relationship && <form onSubmit={event => void submitRelationship(event)} className="client-directory-profile-form">
      <h3>Organization relationship</h3><p>This is separate from profile editing. Saving here will assign, move, or remove the client’s organization relationship.</p>
      <label htmlFor={`${id}-relationship`}>Organization<select id={`${id}-relationship`} value={relationshipOrganizationId}
        onChange={event => setRelationshipOrganizationId(event.target.value)}>
        <option value="">No organization (standalone client)</option>
        {snapshot.relationship.organizations.map(organization => <option key={organization.recordId} value={organization.recordId}>{organization.name}</option>)}
      </select></label>
      <button className="button-ghost" disabled={relationshipBusy
        || relationshipOrganizationId === (snapshot.relationship.organization?.recordId ?? "")}>
        {relationshipBusy ? "Saving relationship…" : snapshot.relationship.organization
          ? relationshipOrganizationId ? "Move client to organization" : "Remove organization relationship"
          : "Assign client to organization"}
      </button>
    </form>}
  </Card>;
}
