import { useState, type FormEvent } from "react";
import { Card } from "@ltds/ui";
import { api, ApiError } from "./api";
import { serializeNativeDirectoryProfile, type ProfileForm } from "./NativeDirectoryProfileEditor";
import { RETAINED_SYNTHETIC_CLIENT_ID } from "./DirectoryReplayAcceptanceRoute";

const DETAIL = `/api/client-hub/directory/standalone-clients/${RETAINED_SYNTHETIC_CLIENT_ID}`;
const RETAINED_AREA = "staging-native-only-portal-acceptance-20261008-window-1";

type Snapshot = { recordId: string; kind: "client"; version: number; profile: ProfileForm;
  scopes: Array<{ businessAreaId: string; divisionId: string | null }>; linkage: "standalone";
  relationship: { version: number; organization: null; organizations: unknown[] };
  editing: { available: boolean; reason: string | null } };
type Write = { status: "pending" | "written"; recordId: string; kind: "client"; version: number;
  replayed: boolean; destinations: Array<{ sourceId: string; state: string }> };
type Frozen = { key: string; body: string; conflictBody: string; expectedVersion: number; target: ProfileForm;
  original: ProfileForm; phase: "write" | "replay" | "conflict" | "readback" };
export type DirectoryAcceptanceRequest = typeof api;

const profileKeys: Array<keyof ProfileForm> = ["name", "email", "phone", "clientType", "addressLine1", "addressLine2",
  "city", "state", "postalCode", "country"];
const validSnapshot = (value: unknown): value is Snapshot => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>, profile = row.profile, editing = row.editing;
  return row.recordId === RETAINED_SYNTHETIC_CLIENT_ID && row.kind === "client"
    && Number.isSafeInteger(row.version) && Number(row.version) > 0
    && !!profile && typeof profile === "object" && !Array.isArray(profile)
    && profileKeys.every(key => typeof (profile as Record<string, unknown>)[key] === "string")
    && (profile as Record<string, unknown>).clientType === "unknown"
    && Array.isArray(row.scopes) && row.scopes.length === 1
    && (row.scopes[0] as Record<string, unknown>)?.businessAreaId === RETAINED_AREA
    && (row.scopes[0] as Record<string, unknown>)?.divisionId === null
    && row.linkage === "standalone" && !!row.relationship && typeof row.relationship === "object"
    && !Array.isArray(row.relationship) && Number.isSafeInteger((row.relationship as Record<string, unknown>).version)
    && Number((row.relationship as Record<string, unknown>).version) > 0
    && (row.relationship as Record<string, unknown>).organization === null
    && Array.isArray((row.relationship as Record<string, unknown>).organizations)
    && !!editing && typeof editing === "object" && !Array.isArray(editing)
    && typeof (editing as Record<string, unknown>).available === "boolean";
};
const validWrite = (value: unknown, expectedVersion: number, replayed: boolean): value is Write => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Write;
  return (row.status === "pending" || row.status === "written") && row.recordId === RETAINED_SYNTHETIC_CLIENT_ID
    && row.kind === "client" && row.version === expectedVersion && row.replayed === replayed
    && Array.isArray(row.destinations) && row.destinations.length === 1
    && row.destinations[0]?.sourceId === "project-alpha:staging"
    && ["pending", "acknowledged"].includes(row.destinations[0]?.state);
};
const acknowledged = (value: Write) => value.status === "written"
  && value.destinations.every(destination => destination.state === "acknowledged");
const ACCEPTANCE_SUFFIX = " [staging replay acceptance]";
const changedName = (name: string) => `${name.slice(0, 150 - ACCEPTANCE_SUFFIX.length)}${ACCEPTANCE_SUFFIX}`;

export function DirectoryReplayAcceptance({ request = api }: { request?: DirectoryAcceptanceRequest }) {
  const [recordConfirmation, setRecordConfirmation] = useState(""), [nameConfirmation, setNameConfirmation] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [proposedName, setProposedName] = useState("");
  const [attempt, setAttempt] = useState<Frozen | null>(null), [restore, setRestore] = useState<Frozen | null>(null);
  const [restored, setRestored] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [result, setResult] = useState("");

  const load = async () => {
    setBusy(true); setError(""); setResult(""); setAttempt(null); setRestore(null); setRestored(false);
    try {
      const value = await request<unknown>(DETAIL);
      if (!validSnapshot(value)) throw new Error("The retained synthetic client response could not be verified.");
      if (!value.editing.available) throw new Error(`The retained synthetic client is pending or unavailable (${value.editing.reason ?? "unknown"}).`);
      setSnapshot(value); setProposedName(changedName(value.profile.name));
    } catch (caught) { setSnapshot(null); setError(caught instanceof Error ? caught.message : "The retained synthetic client could not be loaded."); }
    finally { setBusy(false); }
  };

  const send = (body: string, key: string) => request<unknown>(DETAIL,
    { method: "PATCH", headers: { "Idempotency-Key": key }, body });

  const advance = async (current: Frozen, restoring = false) => {
    if (current.phase === "write") {
      const value = await send(current.body, current.key);
      if (!validWrite(value, current.expectedVersion, false) && !validWrite(value, current.expectedVersion, true))
        throw new Error("The first write response could not be verified.");
      return { ...current, phase: "replay" as const };
    }
    if (current.phase === "replay") {
      const value = await send(current.body, current.key);
      if (!validWrite(value, current.expectedVersion, true)) throw new Error("The exact replay response could not be verified.");
      return acknowledged(value) ? { ...current, phase: restoring ? "readback" as const : "conflict" as const } : current;
    }
    if (current.phase === "conflict") {
      try { await send(current.conflictBody, current.key); }
      catch (caught) {
        if (caught instanceof ApiError && caught.status === 409 && caught.payload.status === "conflict"
          && caught.payload.reason === "idempotency_body_conflict") return { ...current, phase: "readback" as const };
        throw caught;
      }
      throw new Error("The changed-body request did not return the required idempotency conflict.");
    }
    const value = await request<unknown>(DETAIL);
    if (!validSnapshot(value) || value.version !== current.expectedVersion
      || JSON.stringify(serializeNativeDirectoryProfile("client", value.profile, "update"))
        !== JSON.stringify(serializeNativeDirectoryProfile("client", current.target, "update")))
      throw new Error("The final local profile readback did not match the acknowledged operation.");
    return null;
  };

  const run = async (event: FormEvent) => {
    event.preventDefault(); if (!snapshot || busy) return;
    let current = attempt;
    if (!current) {
      if (recordConfirmation !== RETAINED_SYNTHETIC_CLIENT_ID || nameConfirmation !== snapshot.profile.name)
        return setError("Enter the exact retained record ID and current name before starting.");
      const name = proposedName.trim();
      if (!name || name.length > 150 || name === snapshot.profile.name || !name.endsWith(" [staging replay acceptance]"))
        return setError("Use the bounded staging replay acceptance name shown for this synthetic client.");
      const key = crypto.randomUUID(), target = { ...snapshot.profile, name };
      const body = JSON.stringify({ mutationId: key, expectedLocalVersion: snapshot.version,
        profile: serializeNativeDirectoryProfile("client", target, "update") });
      const conflictTarget = { ...target, name: `${name.slice(0, 146)}-bad` };
      current = { key, body, conflictBody: JSON.stringify({ mutationId: key, expectedLocalVersion: snapshot.version,
        profile: serializeNativeDirectoryProfile("client", conflictTarget, "update") }), expectedVersion: snapshot.version + 1,
        target, original: snapshot.profile, phase: "write" };
      setAttempt(current);
    }
    setBusy(true); setError("");
    try {
      const next = await advance(current);
      setAttempt(next);
      if (!next) { setResult(`Passed local replay/conflict/readback at version ${current.expectedVersion}. This is not independent Project Alpha readback proof.`); }
    } catch (caught) { setError(`${caught instanceof Error ? caught.message : "Acceptance step failed."} Retry retains the exact operation and key.`); }
    finally { setBusy(false); }
  };

  const runRestore = async () => {
    if (!attempt && !restore && snapshot && result && !restored) {
      const key = crypto.randomUUID(), body = JSON.stringify({ mutationId: key, expectedLocalVersion: snapshot.version + 1,
        profile: serializeNativeDirectoryProfile("client", snapshot.profile, "update") });
      setRestore({ key, body, conflictBody: "", expectedVersion: snapshot.version + 2, target: snapshot.profile,
        original: snapshot.profile, phase: "write" }); return;
    }
    if (!restore || busy) return;
    setBusy(true); setError("");
    try { const next = await advance(restore, true); setRestore(next); if (!next) { setRestored(true); setResult(`Original profile restored and locally verified at version ${restore.expectedVersion}. This is not independent Project Alpha readback proof.`); } }
    catch (caught) { setError(`${caught instanceof Error ? caught.message : "Restore step failed."} Retry retains the exact restore operation and key.`); }
    finally { setBusy(false); }
  };

  return <main className="page"><Card title="Staging Directory replay acceptance">
    <p>This fixed staging tool can update only the retained synthetic standalone client. It proves local replay/conflict handling and acknowledged delivery state, not independent Project Alpha readback.</p>
    {!snapshot ? <><button onClick={() => void load()} disabled={busy}>{busy ? "Loading…" : "Load retained synthetic client"}</button>{error && <p role="alert">{error}</p>}</>
      : <form onSubmit={event => void run(event)}>
        <p>Current version: {snapshot.version}. Current name: <strong>{snapshot.profile.name}</strong></p>
        <label>Confirm exact record ID<input value={recordConfirmation} disabled={Boolean(attempt)} onChange={event => setRecordConfirmation(event.target.value)} /></label>
        <label>Confirm current name<input value={nameConfirmation} disabled={Boolean(attempt)} onChange={event => setNameConfirmation(event.target.value)} /></label>
        <label>Reviewed synthetic name change<input maxLength={150} value={proposedName} disabled={Boolean(attempt)} onChange={event => setProposedName(event.target.value)} /></label>
        {error && <p role="alert">{error}</p>}{result && <p role="status">{result}</p>}
        {!result && <button disabled={busy}>{busy ? "Running fixed step…" : attempt ? "Retry same frozen step" : "Start reviewed acceptance"}</button>}
      </form>}
    {result && !restored && <button onClick={() => void runRestore()} disabled={busy}>{restore ? "Continue same frozen restore" : "Prepare explicit fresh-key restore"}</button>}
  </Card></main>;
}
