import { useState, type FormEvent } from "react";
import "./ClientOnboardingStaff.css";

const destinations = [
  { id: "project-alpha:secondary", label: "Ledge Top Technologies", color: "technologies" },
  { id: "project-alpha:primary", label: "Ledge Top Drone Services", color: "drone" },
] as const;

type Source = typeof destinations[number]["id"];
type DirectoryChoice = { id: string; label: string };
type DestinationOptions = {
  clients: readonly DirectoryChoice[];
  organizations: readonly DirectoryChoice[];
};
type Selection = { clientId?: string; organizationId?: string };
type Selections = Partial<Record<Source, Selection>>;
type Options = Partial<Record<Source, DestinationOptions>>;
type PreviewIntent = {
  destinations: Array<{ sourceId: Source; clientId: string | null; organizationId: string | null }>;
  knownEmail: string | null;
  expiresAt: string;
};

export function buildPreviewIntent(options: Options, selections: Selections, email: string, expiry: string, now = Date.now()): PreviewIntent | null {
  const expiresAt = new Date(expiry);
  if (!Number.isFinite(expiresAt.valueOf()) || expiresAt.valueOf() <= now) return null;

  const selected: PreviewIntent["destinations"] = [];
  for (const { id: sourceId } of destinations) {
    const selection = selections[sourceId];
    if (!selection) continue;
    const available = options[sourceId];
    const clientId = selection.clientId || null;
    const organizationId = selection.organizationId || null;
    if (!available || (clientId && available.clients.filter(choice => choice.id === clientId).length !== 1)
      || (organizationId && available.organizations.filter(choice => choice.id === organizationId).length !== 1)) return null;
    selected.push({ sourceId, clientId, organizationId });
  }
  return selected.length ? { destinations: selected, knownEmail: email.trim() || null, expiresAt: expiresAt.toISOString() } : null;
}

/** Synthetic design boundary. The staff route continues to use its authorized issuer. */
export function ClientOnboardingInvitePreview({ options, onPreviewIntent }: {
  options: Options;
  onPreviewIntent?: (intent: PreviewIntent) => void;
}) {
  const [selections, setSelections] = useState<Selections>({});
  const [email, setEmail] = useState("");
  const [expiry, setExpiry] = useState("");
  const intent = buildPreviewIntent(options, selections, email, expiry);

  function update(sourceId: Source, selection?: Selection) {
    setSelections(current => ({ ...current, [sourceId]: selection }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const current = buildPreviewIntent(options, selections, email, expiry);
    if (current) onPreviewIntent?.(current);
  }

  return <section className="onboarding-created">
    <h2>Invite a client</h2>
    <p>Design preview. Link generation and email require an authorized Operations connection.</p>
    <form className="onboarding-staff-form" onSubmit={submit}>
      <fieldset className="wide onboarding-destinations"><legend>Businesses</legend>
        {destinations.map(({ id, label, color }) => {
          const available = options[id];
          const selected = selections[id];
          return <div className={`onboarding-destination onboarding-destination--${color}`} key={id}>
            <label className="onboarding-destination-toggle"><input type="checkbox" checked={Boolean(selected)} disabled={!available}
              onChange={event => update(id, event.target.checked ? {} : undefined)} />{label}</label>
            {!available && <p className="onboarding-hint">Unavailable</p>}
            {available && selected && <>
              <label>Client<select value={selected.clientId ?? ""} onChange={event => update(id, { ...selected, clientId: event.target.value })}>
                <option value="">New client</option>
                {available.clients.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
              </select></label>
              {available.organizations.length > 0 && <label>Existing organization (optional)
                <select value={selected.organizationId ?? ""} onChange={event => update(id, { ...selected, organizationId: event.target.value })}>
                  <option value="">No organization</option>
                  {available.organizations.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
                </select>
              </label>}
            </>}
          </div>;
        })}
      </fieldset>
      <label>Known email (optional)<input type="email" value={email} onChange={event => setEmail(event.target.value)} /></label>
      <label>Link expires<input type="datetime-local" value={expiry} onChange={event => setExpiry(event.target.value)} required /></label>
      <div className="wide onboarding-secret-actions">
        {onPreviewIntent && <button className="button-ghost" type="submit" disabled={!intent}>Preview selection</button>}
        <button className="button-orange" type="button" disabled>Generate Link</button>
        <button className="button-ghost" type="button" disabled>Generate and Email</button>
      </div>
    </form>
  </section>;
}
