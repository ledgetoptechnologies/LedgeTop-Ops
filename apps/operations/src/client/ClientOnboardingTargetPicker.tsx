import { useEffect, useRef, useState } from "react";
import { post, record, type StaffSession } from "./onboarding-staff-api";

export type TargetKind = "client" | "organization";
type Target = { sourceId: string; kind: TargetKind; publicId: string; displayName: string };
export type TargetProof = Pick<Target, "sourceId" | "kind" | "publicId"> & { choice: string };
type TargetPage = { targets: Target[]; nextCursor: string | null };

export function readTargetPage(value: Record<string, unknown>, sourceId: string, kind: TargetKind): TargetPage | null {
  if (Object.keys(value).length !== 2 || !Array.isArray(value.targets) || value.targets.length > 12) return null;
  const ids = new Set<string>();
  for (const row of value.targets) {
    if (!record(row) || Object.keys(row).length !== 4 || row.sourceId !== sourceId || row.kind !== kind
      || typeof row.publicId !== "string" || !/^[a-f0-9]{32}$/.test(row.publicId) || ids.has(row.publicId)
      || typeof row.displayName !== "string" || !row.displayName.trim() || row.displayName.length > 200) return null;
    ids.add(row.publicId);
  }
  if (value.nextCursor !== null && (typeof value.nextCursor !== "string" || value.targets.length !== 12
    || !/^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(value.nextCursor)
    || !value.nextCursor.startsWith(`${value.targets.at(-1).publicId}.`))) return null;
  return { targets: value.targets as Target[], nextCursor: value.nextCursor };
}

export function ClientOnboardingTargetPicker({ sourceId, kind, business, session, disabled, onChoice, onRefused }: {
  sourceId: string; kind: TargetKind; business: string; session: StaffSession; disabled: boolean;
  onChoice: (value: TargetProof | null) => void; onRefused: (caught: unknown) => void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<TargetPage | null>(null);
  const [selected, setSelected] = useState<Target | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  const reset = () => {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setSelected(null);
    setPage(null);
    setError("");
    onChoice(null);
  };

  const run = async (request: (signal: AbortSignal) => Promise<void>) => {
    if (disabled || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    try {
      await request(controller.signal);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setPage(null);
      setSelected(null);
      onChoice(null);
      setError("The directory selection could not be verified. Search again or check your access.");
      onRefused(caught);
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  };
  const search = (cursor: string | null = null) => {
    if (query.trim().length < 3) return;
    void run(async signal => {
      const value = await post(session, "target-search", { sourceId, kind, query: query.trim(), cursor }, signal);
      if (signal.aborted) return;
      const result = readTargetPage(value, sourceId, kind);
      if (!result) throw new Error("invalid_response");
      setPage(result);
    });
  };
  const choose = (target: Target) => {
    onChoice(null);
    void run(async signal => {
      const value = await post(session, "target-choices", { sourceId, kind, publicId: target.publicId }, signal);
      if (signal.aborted) return;
      if (Object.keys(value).length !== 1 || typeof value.choice !== "string" || !/^[a-f0-9]{64}$/.test(value.choice))
        throw new Error("invalid_response");
      setSelected(target);
      setPage(null);
      onChoice({ sourceId, kind, publicId: target.publicId, choice: value.choice });
    });
  };

  return <fieldset className="onboarding-target-picker" disabled={disabled}>
    <legend>{business}</legend>
    {selected ? <>
      <p>Selected {selected.displayName}</p>
      <button className="button-ghost" type="button" onClick={reset}>Change selection</button>
    </> : <>
      <label>{kind === "client" ? "Search for a client" : "Search for an organization"}
        <input type="search" value={query} maxLength={100} autoComplete="off"
          onChange={event => { reset(); setQuery(event.target.value); }}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); search(); } }} />
      </label>
      <button className="button-ghost" type="button" disabled={busy || query.trim().length < 3} onClick={() => search()}>Search</button>
      {busy && <p role="status">Checking the directory…</p>}
      {page && (page.targets.length ? <ul>
        {page.targets.map(target => <li key={target.publicId}><button className="button-ghost" type="button" disabled={busy}
          onClick={() => choose(target)}>{target.displayName}</button></li>)}
      </ul> : <p role="status">No matching records.</p>)}
      {page?.nextCursor && <button className="button-ghost" type="button" disabled={busy} onClick={() => search(page.nextCursor)}>Next results</button>}
    </>}
    {error && <p className="onboarding-staff-error" role="alert">{error}</p>}
  </fieldset>;
}
