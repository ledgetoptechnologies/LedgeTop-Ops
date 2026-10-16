import { useEffect, useId, useState, type FormEvent } from "react";
import { Card, Dialog, Skeleton } from "@ltds/ui";
import { projectAlphaSourceName } from "@ltds/shared";
import { api, ApiError } from "./api";
import { executeCreateAttempt, executeProfileAttempt, executeRelationshipAttempt,
  type FrozenCreateAttempt, type FrozenDirectoryRequest } from "./NativeDirectoryProfileAttempts";
import { DirectoryRelationshipRecoveryReview, usableRelationshipRecoveryCapability } from "./DirectoryRelationshipRecoveryReview";

type Kind = "organization" | "client";
type RouteKind = "organizations" | "standalone-clients";
type Scope = { businessAreaId: string; divisionId: string | null };
export type ProfileForm = {
  name: string; generalEmail: string; generalPhone: string; email: string; phone: string;
  clientType: "unknown" | "business" | "consumer"; addressLine1: string; addressLine2: string;
  city: string; state: string; postalCode: string; country: string;
};
type ProfileSnapshot = {
  recordId: string; kind: Kind; version: number; profile: ProfileForm; scopes: Scope[];
  linkage?: "standalone" | "linked" | "unavailable";
  relationship?: { version: number; organization: OrganizationChoice | null; organizations: OrganizationChoice[];
    editing: { available: boolean; reason: string | null }; recovery?: unknown } | null;
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
export const isStagingNativeDirectoryProfilePreparationLocation = (location: Pick<Location, "protocol" | "hostname" | "port">) =>
  location.protocol === "https:" && location.hostname === "ops-staging.ledgetopdroneservices.com" && location.port === "";
export function serializeNativeDirectoryProfile(kind: Kind, fields: ProfileForm, operation: "create" | "update") {
  const address = { addressLine1: fields.addressLine1.trim(), addressLine2: fields.addressLine2.trim(), city: fields.city.trim(),
    state: fields.state.trim(), postalCode: fields.postalCode.trim(), country: fields.country.trim() };
  return kind === "organization" ? { name: fields.name.trim(), generalEmail: fields.generalEmail.trim(), generalPhone: fields.generalPhone.trim(), ...address }
    : { name: fields.name.trim(), email: fields.email.trim(), phone: fields.phone.trim(),
      ...(operation === "create" ? { clientType: fields.clientType } : {}), ...address };
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
      && ((row.relationship as Record<string, unknown>).organizations as unknown[]).every(usableOrganizationChoice)
      && (row.relationship as Record<string, unknown>).editing !== null
      && typeof (row.relationship as Record<string, unknown>).editing === "object"
      && typeof ((row.relationship as Record<string, unknown>).editing as Record<string, unknown>).available === "boolean"
      && (((row.relationship as Record<string, unknown>).editing as Record<string, unknown>).reason === null
        || typeof ((row.relationship as Record<string, unknown>).editing as Record<string, unknown>).reason === "string")))
    && row.editing !== null && typeof row.editing === "object" && !Array.isArray(row.editing)
    && typeof (row.editing as Record<string, unknown>).available === "boolean"
    && ((row.editing as Record<string, unknown>).reason === null || typeof (row.editing as Record<string, unknown>).reason === "string");
}

function ProfileFields({ kind, value, onChange, prefix, creating, disabled = false }: { kind: Kind; value: ProfileForm;
  onChange: (field: keyof ProfileForm, value: string) => void; prefix: string; creating: boolean; disabled?: boolean }) {
  const field = (key: keyof ProfileForm, label: string, maxLength: number, required = false, wide = false) =>
    <label htmlFor={`${prefix}-${key}`} className={`ltds-field${wide ? " ltds-span-2" : ""}`}>{label}
    <input id={`${prefix}-${key}`} maxLength={maxLength} required={required} value={value[key]} disabled={disabled}
      onChange={event => onChange(key, event.target.value)} /></label>;
  return <div className="client-directory-profile-fields ltds-form-grid">
    {field("name", kind === "organization" ? "Organization name" : "Client name", 150, true, true)}
    {kind === "organization" ? <>{field("generalEmail", "General email", 255)}{field("generalPhone", "General phone", 50)}</>
      : <>{field("email", "Email", 255)}{field("phone", "Phone", 50)}{creating && <label htmlFor={`${prefix}-clientType`} className="ltds-field">Client type
        <select id={`${prefix}-clientType`} value={value.clientType} disabled={disabled} onChange={event => onChange("clientType", event.target.value)}>
          <option value="unknown">Unknown</option><option value="business">Business</option><option value="consumer">Consumer</option>
        </select></label>}</>}
    {field("addressLine1", "Address line 1", 255, false, true)}{field("addressLine2", "Address line 2", 255, false, true)}
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
  const [attempt, setAttempt] = useState<FrozenCreateAttempt | null>(null);
  const [optionsError, setOptionsError] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [success, setSuccess] = useState("");
  const [open, setOpen] = useState(false);
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
    event.preventDefault(); if (busy || (!attempt && (!sourceIds.length || !selectedScope))) return;
    let current = attempt;
    if (!current) {
      const [businessAreaId, divisionId] = selectedScope.split("\0"), mutationId = crypto.randomUUID(),
        profile = serializeNativeDirectoryProfile(kind, fields, "create");
      if (!businessAreaId) return;
      const scopes = [{ businessAreaId, divisionId: divisionId || null }], selectedOrganization = options?.organizations.find(value => value.recordId === organizationId);
      const relationship = selectedOrganization
        ? { organizationRecordId: selectedOrganization.recordId, expectedOrganizationVersion: selectedOrganization.expectedVersion }
        : { organizationRecordId: null, expectedOrganizationVersion: null };
      const common = { mutationId, sourceIds, scopes, profile, ...(kind === "client" ? { relationship } : {}) };
      current = { mutationId, phase: "admission", sourceIds: [...sourceIds],
        admission: { path: "/api/client-hub/directory/create-admissions", method: "POST", mutationId,
          body: JSON.stringify({ kind, ...common }) },
        write: { path: `/api/client-hub/directory/${routeKind(kind)}`, method: "POST", mutationId,
          body: JSON.stringify(common) } };
      setAttempt(current);
    }
    let reachedWrite = current.phase === "write";
    setBusy(true); setError(""); setSuccess("");
    try {
      const frozen = current;
      const result = await executeCreateAttempt(frozen, request => api(request.path, { method: request.method,
        headers: { "Idempotency-Key": request.mutationId }, body: request.body }),
      { recordId: frozen.mutationId, kind, version: 1, sourceIds: frozen.sourceIds }, value => {
        reachedWrite = true; setAttempt(value);
      });
      setAttempt(null); setSuccess(status(result as { status?: unknown })); setFields(EMPTY); setSourceIds([]); setSelectedScope(""); setOpen(false);
    } catch (caught) {
      const invalidAdmission = !reachedWrite && caught instanceof ApiError && caught.status === 400;
      if (invalidAdmission) setAttempt(null);
      setError(invalidAdmission
        ? `${message(caught, "The client profile request was invalid.")} Review the form before submitting a new operation.`
        : `${message(caught, "The client profile could not be created.")} Retry sends the same frozen operation. Reload this page to abandon it and review current state before starting another mutation.`);
    }
    finally { setBusy(false); }
  };
  const scopeOptions = options?.scopes.flatMap(area => [{ value: `${area.id}\0`, label: area.name },
    ...area.divisions.map(division => ({ value: `${area.id}\0${division.id}`, label: `${area.name} · ${division.name}` }))]) ?? [];
  const selectedOrganization = options?.organizations.find(value => value.recordId === organizationId), availableSources = selectedOrganization
    ? options?.sources.filter(source => selectedOrganization.sourceIds.includes(source.id)) ?? [] : options?.sources ?? [];
  const kindLabel = kind === "organization" ? "organization" : "client";
  const toggleSource = (sourceId: string, checked: boolean) => setSourceIds(previous =>
    checked ? [...new Set([...previous, sourceId])] : previous.filter(value => value !== sourceId));
  const formId = `${id}-create-form`;
  return <div className="client-directory-create">
    <div className="client-directory-create-bar">
      <button type="button" className="button-orange" onClick={() => { setSuccess(""); setOpen(true); }}>
        {attempt ? "Resume client profile" : "Add client profile"}
      </button>
      {success && <p role="status" className="notice ok">{success}</p>}
    </div>
    <Dialog open={open} onClose={() => { if (!busy) setOpen(false); }} dismissible={!busy} size="lg" title="Add client profile"
      description="Create an organization or client in Client Hub and send it to the Project Alpha destinations you choose."
      footer={options && options.sources.length > 0 && scopeOptions.length > 0 ? <>
        <button type="button" className="button-ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
        <button type="submit" form={formId} className="button-orange" disabled={busy || (!attempt && (!sourceIds.length || !selectedScope))}>
          {busy ? "Saving profile…" : attempt ? "Retry same profile creation" : `Create ${kindLabel}`}</button>
      </> : undefined}>
      {optionsError && <p role="alert" className="notice error">{optionsError}</p>}
      {!options && !optionsError && <Skeleton variant="form" rows={6} label="Loading client profile choices…" />}
      {options && (!options.sources.length || !scopeOptions.length)
        ? <p role="status" className="notice">No permitted Project Alpha destinations and business scopes are available for a new client profile.</p>
        : options && <form id={formId} onSubmit={event => void submit(event)} className="client-directory-profile-form ltds-form">
        {attempt && <p role="status" className="notice warning">This profile is waiting to be retried. Its details are locked so the retry sends exactly the same request.</p>}
        <section className="ltds-form-section" aria-label="Destination">
          <h3>Destination</h3>
          <div className="ltds-form-grid">
            <label htmlFor={`${id}-kind`} className="ltds-field">Profile type<select id={`${id}-kind`} value={kind} disabled={Boolean(attempt)} onChange={event => setKind(event.target.value === "client" ? "client" : "organization")}>
              <option value="organization">Organization</option><option value="client">Client</option>
            </select></label>
            <label htmlFor={`${id}-scope`} className="ltds-field">Business scope<select id={`${id}-scope`} required value={selectedScope} disabled={Boolean(attempt)} onChange={event => setSelectedScope(event.target.value)}>
              <option value="">Choose a business scope</option>{scopeOptions.map(scope => <option key={scope.value} value={scope.value}>{scope.label}</option>)}</select></label>
            {kind === "client" && <label htmlFor={`${id}-organization`} className="ltds-field ltds-span-2">Organization relationship<select id={`${id}-organization`} value={organizationId} disabled={Boolean(attempt)}
              onChange={event => { setOrganizationId(event.target.value); setSourceIds(previous => {
                const next = options.organizations.find(value => value.recordId === event.target.value);
                return next ? previous.filter(sourceId => next.sourceIds.includes(sourceId)) : previous;
              }); }}>
              <option value="">No organization (standalone client)</option>
              {options.organizations.map(organization => <option key={organization.recordId} value={organization.recordId}>{organization.name}</option>)}
            </select><small>Choose an organization to create a linked client, or leave this standalone.</small></label>}
            <fieldset className="ltds-check-list ltds-span-2">
              <legend>Project Alpha destinations</legend>
              {availableSources.map(source => <label key={source.id} className="ltds-check-option">
                <input type="checkbox" value={source.id} checked={sourceIds.includes(source.id)} disabled={Boolean(attempt)}
                  onChange={event => toggleSource(source.id, event.target.checked)} />
                <span>{projectAlphaSourceName(source.id)}</span>
              </label>)}
              <small className="ltds-field-hint">Choose every destination that should receive this profile.</small>
            </fieldset>
          </div>
        </section>
        <section className="ltds-form-section" aria-label="Profile details">
          <h3>{kind === "organization" ? "Organization details" : "Client details"}</h3>
          <ProfileFields kind={kind} value={fields} onChange={change} prefix={id} creating disabled={Boolean(attempt)} />
        </section>
        {error && <p role="alert" className="notice error">{error}</p>}
      </form>}
    </Dialog>
  </div>;
}

export function NativeDirectoryProfileEdit({ kind, recordId, allowPreparedAttempt = false }: { kind: Kind; recordId: string; allowPreparedAttempt?: boolean }) {
  return <NativeDirectoryProfileEditBound key={`${kind}\0${recordId}`} kind={kind} recordId={recordId} allowPreparedAttempt={allowPreparedAttempt} />;
}

function NativeDirectoryProfileEditBound({ kind, recordId, allowPreparedAttempt = false }: { kind: Kind; recordId: string; allowPreparedAttempt?: boolean }) {
  const id = useId(), [snapshot, setSnapshot] = useState<ProfileSnapshot | null>(null), [fields, setFields] = useState<ProfileForm>(EMPTY);
  const [loading, setLoading] = useState(true), [missing, setMissing] = useState(false), [error, setError] = useState(""), [success, setSuccess] = useState(""), [busy, setBusy] = useState(false);
  const [relationshipOrganizationId, setRelationshipOrganizationId] = useState(""), [relationshipBusy, setRelationshipBusy] = useState(false);
  const [profileAttempt, setProfileAttempt] = useState<{ request: FrozenDirectoryRequest; expectedVersion: number; intendedProfile: ReturnType<typeof serializeNativeDirectoryProfile> } | null>(null);
  const [profileAttemptTransmitted, setProfileAttemptTransmitted] = useState(false);
  const [relationshipAttempt, setRelationshipAttempt] = useState<{ request: FrozenDirectoryRequest; expectedVersion: number } | null>(null);
  const load = async (): Promise<boolean> => {
    setLoading(true); setError("");
    try {
      const value = await api<unknown>(`/api/client-hub/directory/${routeKind(kind)}/${encodeURIComponent(recordId)}`);
      if (!usableSnapshot(value, kind, recordId)) throw new Error("The client profile could not be verified.");
      setSnapshot(value); setFields({ ...EMPTY, ...value.profile }); setRelationshipOrganizationId(value.relationship?.organization?.recordId ?? ""); setMissing(false);
      return true;
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 404) { setMissing(true); setSnapshot(null); }
      else setError(message(caught, "The client profile could not be loaded."));
      return false;
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [kind, recordId]);
  const change = (field: keyof ProfileForm, value: string) => setFields(previous => ({ ...previous, [field]: value }));
  const freezeProfileAttempt = () => {
    if (!snapshot) return null;
    const mutationId = crypto.randomUUID(), intendedProfile = serializeNativeDirectoryProfile(kind, fields, "update");
    return { expectedVersion: snapshot.version + 1, intendedProfile,
      request: { path: `/api/client-hub/directory/${routeKind(kind)}/${encodeURIComponent(recordId)}`, method: "PATCH" as const, mutationId,
        body: JSON.stringify({ mutationId, expectedLocalVersion: snapshot.version, profile: intendedProfile }) } };
  };
  const prepareProfileAttempt = () => {
    if (!allowPreparedAttempt || !snapshot || busy || relationshipAttempt || profileAttempt) return;
    const frozen = freezeProfileAttempt();
    if (frozen) { setProfileAttempt(frozen); setProfileAttemptTransmitted(false); setError(""); setSuccess(""); }
  };
  const cancelPreparedProfileAttempt = () => {
    if (!profileAttempt || profileAttemptTransmitted || busy) return;
    setProfileAttempt(null); setError(""); setSuccess("");
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!snapshot || busy || relationshipAttempt) return;
    const frozen = profileAttempt ?? freezeProfileAttempt();
    if (!frozen) return;
    if (!profileAttempt) setProfileAttempt(frozen);
    setProfileAttemptTransmitted(true);
    setBusy(true); setError(""); setSuccess("");
    try {
      const result = await executeProfileAttempt(frozen.request, request => api(request.path, { method: request.method,
        headers: { "Idempotency-Key": request.mutationId }, body: request.body }),
      { recordId, kind, version: frozen.expectedVersion });
      if (await load()) { setProfileAttempt(null); setProfileAttemptTransmitted(false); setSuccess(status(result as { status?: unknown })); }
    } catch (caught) { setError(`${message(caught, "The client profile could not be updated.")} Retry sends the same frozen operation. Reload this page to abandon it and review current state before starting another mutation.`); }
    finally { setBusy(false); }
  };
  const submitRelationship = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!snapshot?.relationship || relationshipBusy || profileAttempt) return;
    const frozen = relationshipAttempt ?? (() => {
      const selected = snapshot.relationship!.organizations.find(value => value.recordId === relationshipOrganizationId) ?? null;
      const mutationId = crypto.randomUUID();
      return { expectedVersion: snapshot.relationship!.version + 1, request: {
        path: `/api/client-hub/directory/standalone-clients/${encodeURIComponent(recordId)}/relationship`, method: "POST" as const,
        mutationId, body: JSON.stringify({ mutationId, expectedRelationshipVersion: snapshot.relationship!.version,
          organization: selected ? { recordId: selected.recordId, expectedVersion: selected.expectedVersion } : null }),
      } };
    })();
    if (!relationshipAttempt) setRelationshipAttempt(frozen);
    setRelationshipBusy(true); setError(""); setSuccess("");
    try {
      const result = await executeRelationshipAttempt(frozen.request, request => api(request.path, { method: request.method,
        headers: { "Idempotency-Key": request.mutationId }, body: request.body }),
      { mutationId: frozen.request.mutationId, relationshipVersion: frozen.expectedVersion }) as { status?: unknown };
      if (await load()) {
        setRelationshipAttempt(null); setSuccess(result.status === "written" ? "Organization relationship saved." : "Organization relationship saved and queued for Project Alpha delivery.");
      }
    } catch (caught) { setError(`${message(caught, "The organization relationship could not be updated.")} Retry sends the same frozen operation. Reload this page to abandon it and review current state before starting another mutation.`); }
    finally { setRelationshipBusy(false); }
  };
  if (missing) return null;
  if (loading) return <Card title="Client profile"><Skeleton variant="form" rows={6} label="Loading client profile…" /></Card>;
  if (error && !snapshot) return <Card title="Client profile"><p role="alert">{error}</p><button type="button" className="button-ghost" onClick={() => void load()}>Retry profile</button></Card>;
  if (!snapshot) return null;
  const recovery = kind === "client" && usableRelationshipRecoveryCapability(snapshot.relationship?.recovery)
    && snapshot.relationship?.organization ? snapshot.relationship.recovery : null;
  const recoveryTarget = kind === "client" ? snapshot.relationship?.organization ?? null : null;
  if (!snapshot.editing.available) return <Card title="Client profile"><p>This client profile is read-only because its current relationship or destination evidence is unavailable.</p>
    {recoveryTarget && <DirectoryRelationshipRecoveryReview recordId={recordId}
      intendedOrganizationName={recoveryTarget.name}
      intendedOrganizationRecordId={recoveryTarget.recordId} capability={recovery} />}</Card>;
  return <Card title="Edit client profile"><p>Editing version {snapshot.version}. The current server-owned profile is loaded before any change is submitted.</p>
    <form onSubmit={event => void submit(event)} className="client-directory-profile-form"><ProfileFields kind={kind} value={fields} onChange={change} prefix={id} creating={false} disabled={Boolean(profileAttempt || relationshipAttempt)} />
      {allowPreparedAttempt && !profileAttempt && <button type="button" className="button-ghost" disabled={busy || Boolean(relationshipAttempt)}
        onClick={prepareProfileAttempt}>Prepare update reference</button>}
      {profileAttempt && !profileAttemptTransmitted && <section aria-label="Prepared profile update"><p>This local staging preparation has not sent a request.</p>
        <dl><dt>Update reference</dt><dd><code>{profileAttempt.request.mutationId}</code></dd><dt>Intended profile</dt>
          <dd><pre>{JSON.stringify(profileAttempt.intendedProfile, null, 2)}</pre></dd></dl>
        <button type="button" className="button-ghost" disabled={busy} onClick={cancelPreparedProfileAttempt}>Cancel prepared update</button>
      </section>}
      {error && <p role="alert">{error}</p>}{success && <p role="status">{success}</p>}
      <button className="button-orange" disabled={busy || Boolean(relationshipAttempt)}>{busy ? "Saving profile…" : profileAttempt
        ? profileAttemptTransmitted ? "Retry same profile update" : "Submit prepared profile update" : "Save client profile"}</button>
    </form>
    {kind === "client" && snapshot.relationship && (snapshot.relationship.editing.available
      ? <form onSubmit={event => void submitRelationship(event)} className="client-directory-profile-form">
      <h3>Organization relationship</h3><p>This is separate from profile editing. Saving here will assign, move, or remove the client’s organization relationship.</p>
      <label htmlFor={`${id}-relationship`}>Organization<select id={`${id}-relationship`} value={relationshipOrganizationId} disabled={Boolean(profileAttempt || relationshipAttempt)}
        onChange={event => setRelationshipOrganizationId(event.target.value)}>
        <option value="">No organization (standalone client)</option>
        {snapshot.relationship.organizations.map(organization => <option key={organization.recordId} value={organization.recordId}>{organization.name}</option>)}
      </select></label>
      <button className="button-ghost" disabled={relationshipBusy || Boolean(profileAttempt)
        || (!relationshipAttempt && relationshipOrganizationId === (snapshot.relationship.organization?.recordId ?? ""))}>
        {relationshipBusy ? "Saving relationship…" : relationshipAttempt ? "Retry same relationship update" : snapshot.relationship.organization
          ? relationshipOrganizationId ? "Move client to organization" : "Remove organization relationship"
          : "Assign client to organization"}
      </button>
    </form>
      : <section><h3>Organization relationship</h3><p>The organization relationship is read-only because current relationship authority or destination evidence is unavailable.</p></section>)}
    {recoveryTarget && <DirectoryRelationshipRecoveryReview recordId={recordId}
      intendedOrganizationName={recoveryTarget.name}
      intendedOrganizationRecordId={recoveryTarget.recordId} capability={recovery} />}
  </Card>;
}
