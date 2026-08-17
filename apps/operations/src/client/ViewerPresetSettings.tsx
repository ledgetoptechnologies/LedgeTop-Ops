import { useEffect, useId, useMemo, useState, type ReactElement } from "react";
import type { ViewerProcessingPreset, ViewerProviderCapabilityOption, ViewerProviderSummary } from "@ltds/shared";
import { Card, EmptyState, StatusPill } from "@ltds/ui";
import { ViewerAdminClient } from "./viewer-admin-client";

type Mutate = (action: (client: ViewerAdminClient) => Promise<unknown>, success: string) => Promise<void>;

function optionSection(name: string): string {
  if (/gcp/i.test(name)) return "GCP";
  if (/geo|coordinate|epsg|utm|datum/i.test(name)) return "Georeferencing";
  if (/ortho/i.test(name)) return "Orthophoto";
  if (/point|pc-/i.test(name)) return "Point cloud";
  if (/mesh|texture|3d-/i.test(name)) return "Mesh";
  if (/dsm|dtm|dem|terrain/i.test(name)) return "Terrain/DEM";
  if (/quality|resolution|depthmap|feature/i.test(name)) return "Quality";
  if (/skip|rerun|debug|experimental|smrf|matcher|radiometric|optimi/i.test(name)) return "Advanced";
  return "General";
}

function coerce(option: ViewerProviderCapabilityOption, value: string | boolean): unknown {
  if (option.type === "bool") return Boolean(value);
  if (option.type === "int") return Number.parseInt(String(value), 10);
  if (option.type === "float") return Number.parseFloat(String(value));
  return value;
}

export function OptionEditor({ provider, value, onChange }: { provider: ViewerProviderSummary | undefined; value: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void }): ReactElement {
  const groups = useMemo(() => {
    const result = new Map<string, ViewerProviderCapabilityOption[]>();
    for (const option of provider?.capabilities?.options || []) {
      const section = optionSection(option.name); result.set(section, [...(result.get(section) || []), option]);
    }
    return result;
  }, [provider]);
  const ordered = ["General", "Quality", "Orthophoto", "Point cloud", "Mesh", "Terrain/DEM", "Georeferencing", "GCP", "Advanced"];
  return <div className="viewer-option-groups">{ordered.filter(section => groups.has(section)).map(section => <details key={section} open={section === "General"}><summary>{section}</summary><div className="viewer-processing-form">{groups.get(section)!.map(option => {
    const domain = option.domain;
    const numericDomain = domain && typeof domain === "object" && !Array.isArray(domain) ? domain as { min?: unknown; max?: unknown } : null;
    const choices = Array.isArray(domain) && option.type !== "bool" ? domain : null;
    return <label key={option.name}>{option.help || option.name}<small><code>{option.name}</code>{option.value !== undefined && option.value !== null ? ` · provider default ${String(option.value)}` : ""}{typeof domain === "string" && domain ? ` · provider domain: ${domain}` : ""}</small>{option.type === "bool" ? <select value={value[option.name] === undefined ? "" : String(value[option.name])} onChange={event => { const next = { ...value }; if (!event.target.value) delete next[option.name]; else next[option.name] = event.target.value === "true"; onChange(next); }}><option value="">Provider default</option><option value="true">Explicit true</option><option value="false">Explicit false</option></select> : choices ? <select value={value[option.name] === undefined ? "" : String(value[option.name])} onChange={event => { const next = { ...value }; if (!event.target.value) delete next[option.name]; else next[option.name] = coerce(option, event.target.value); onChange(next); }}><option value="">Provider default</option>{choices.map(choice => <option key={String(choice)} value={String(choice)}>{String(choice)}</option>)}</select> : <input type={option.type === "int" || option.type === "float" ? "number" : "text"} step={option.type === "int" ? 1 : option.type === "float" ? "any" : undefined} min={typeof numericDomain?.min === "number" ? numericDomain.min : undefined} max={typeof numericDomain?.max === "number" ? numericDomain.max : undefined} value={value[option.name] === undefined ? "" : String(value[option.name])} onChange={event => { const next = { ...value }; if (!event.target.value) delete next[option.name]; else next[option.name] = coerce(option, event.target.value); onChange(next); }} />}</label>;
  })}</div></details>)}</div>;
}

export function AdvancedJsonEditor({ value, onApply, label = "Advanced preset JSON overrides" }: { value: Record<string, unknown>; onApply: (value: Record<string, unknown>) => void; label?: string }): ReactElement {
  const inputId = useId();
  const [draft, setDraft] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState("");
  useEffect(() => { setDraft(JSON.stringify(value, null, 2)); setError(""); }, [value]);
  return <div><label htmlFor={inputId}>{label}</label><textarea id={inputId} value={draft} onChange={event => setDraft(event.target.value)} rows={5} /><button type="button" className="button-ghost button-small" onClick={() => {
    try {
      const parsed = JSON.parse(draft) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Enter one JSON object of option overrides.");
      onApply(parsed as Record<string, unknown>); setError("");
    } catch (caught) { setError((caught as Error).message); }
  }}>Apply expert JSON</button>{error && <small className="viewer-processing-error" role="alert">{error}</small>}</div>;
}

export function ViewerPresetSettings({ presets, providers, canWrite, busy, mutate }: { presets: ViewerProcessingPreset[]; providers: ViewerProviderSummary[]; canWrite: boolean; busy: boolean; mutate: Mutate }): ReactElement {
  const [name, setName] = useState(""), [description, setDescription] = useState(""), [providerId, setProviderId] = useState(providers[0]?.id || ""), [enabled, setEnabled] = useState(true), [options, setOptions] = useState<Record<string, unknown>>({});
  useEffect(() => { if (!providers.some(item => item.id === providerId)) setProviderId(providers[0]?.id || ""); }, [providerId, providers]);
  const provider = providers.find(item => item.id === providerId);
  return <Card title="Processing presets"><p>Build reusable option sets from the selected provider's probed capabilities. Viewer validates names, types, ranges, and the current capability fingerprint before saving or running them.</p>
    {canWrite && <form className="viewer-processing-form" onSubmit={event => { event.preventDefault(); void mutate(client => client.request("/api/v1/processing/presets", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ displayName: name.trim(), description: description.trim() || null, providerId, options, enabled }) }), "Custom processing preset saved."); }}><label>Friendly name<input maxLength={160} value={name} onChange={event => setName(event.target.value)} /></label><label>Description<input maxLength={500} value={description} onChange={event => setDescription(event.target.value)} /></label><label>Provider<select value={providerId} onChange={event => { setProviderId(event.target.value); setOptions({}); }}>{providers.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label><label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> Available for new tasks</label><div className="viewer-processing-wide"><OptionEditor provider={provider} value={options} onChange={setOptions} /></div><div className="viewer-processing-wide"><AdvancedJsonEditor value={options} onApply={setOptions} /></div><button className="button-orange" disabled={busy || !name.trim() || !providerId || !provider?.capabilities}>Save custom preset</button></form>}
    {!presets.length ? <EmptyState title="No presets available" detail="Probe a provider, then create a reusable preset." /> : <div className="viewer-processing-list">{presets.map(preset => <PresetRow key={preset.id} preset={preset} providers={providers} canWrite={canWrite} busy={busy} mutate={mutate} />)}</div>}
  </Card>;
}

function PresetRow({ preset, providers, canWrite, busy, mutate }: { preset: ViewerProcessingPreset; providers: ViewerProviderSummary[]; canWrite: boolean; busy: boolean; mutate: Mutate }): ReactElement {
  const matchingProvider = providers.find(provider => provider.type === preset.providerType && provider.capabilityFingerprint === preset.capabilityFingerprint);
  const [name, setName] = useState(preset.displayName), [description, setDescription] = useState(preset.description || ""), [providerId, setProviderId] = useState(matchingProvider?.id || ""), [enabled, setEnabled] = useState(preset.enabled), [options, setOptions] = useState<Record<string, unknown>>(preset.options);
  return <article><div><StatusPill tone={preset.enabled ? "success" : "warning"}>{preset.builtIn ? "built-in" : preset.enabled ? "enabled" : "disabled"}</StatusPill><h3>{preset.displayName}</h3><p>{preset.description || "No description"} · {Object.keys(preset.options).length} option override{Object.keys(preset.options).length === 1 ? "" : "s"}</p></div><div>{canWrite && !preset.builtIn && <details className="viewer-task-catalog"><summary>Edit preset</summary><form onSubmit={event => { event.preventDefault(); void mutate(client => client.request(`/api/v1/processing/presets/${encodeURIComponent(preset.id)}`, { method: "PATCH", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ displayName: name.trim(), description: description.trim() || null, providerId, options, enabled }) }), "Custom preset updated and revalidated."); }}><label>Name<input value={name} onChange={event => setName(event.target.value)} /></label><label>Description<textarea rows={2} value={description} onChange={event => setDescription(event.target.value)} /></label><label>Provider<select value={providerId} onChange={event => { setProviderId(event.target.value); setOptions({}); }}>{providers.map(provider => <option key={provider.id} value={provider.id}>{provider.displayName}</option>)}</select></label><label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> Enabled</label><OptionEditor provider={providers.find(provider => provider.id === providerId)} value={options} onChange={setOptions} /><AdvancedJsonEditor label={`Advanced options for ${preset.displayName} (expert fallback)`} value={options} onApply={setOptions} /><button className="button-orange button-small" disabled={busy || !name.trim() || !providerId}>Save</button><button type="button" className="button-danger button-small" disabled={busy} onClick={() => { if (window.confirm(`Delete custom preset ${preset.displayName}? Existing immutable attempts retain their option snapshot.`)) void mutate(client => client.request(`/api/v1/processing/presets/${encodeURIComponent(preset.id)}`, { method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() } }), "Custom preset deleted; prior attempts are unchanged."); }}>Delete</button></form></details>}</div></article>;
}
