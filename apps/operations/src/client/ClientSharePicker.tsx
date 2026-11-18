import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api } from "./api";
import { anyTruncated, recipientDetail, validClientShareRecipientSearch, type ClientShareBackendState, type ClientShareRecipient } from "./client-share-routing";

const INPUT_ID = "client-share-recipient-search", LIST_ID = "client-share-recipient-options";

/** One client search across both grant back ends. Filters as you type; the
 * chosen row is carried by its id-based key, never by its display text. */
export function ClientSharePicker({ folderId, disabled, selected, onSelect, onPrimaryState }: {
  folderId: string; disabled: boolean; selected: ClientShareRecipient | null;
  onSelect: (recipient: ClientShareRecipient | null) => void; onPrimaryState?: (state: ClientShareBackendState) => void;
}) {
  const [query, setQuery] = useState(""), [options, setOptions] = useState<ClientShareRecipient[]>([]);
  const [status, setStatus] = useState(""), [error, setError] = useState(""), [loading, setLoading] = useState(false), [partial, setPartial] = useState("");
  const request = useRef<AbortController | null>(null), typed = useRef(false), lastKey = useRef<string | null>(null);
  // A selection cleared by the dialog (a grant finished, access refreshed) also clears the search text.
  useEffect(() => {
    const key = selected?.key ?? null;
    if (key === null && lastKey.current !== null && !typed.current) { setQuery(""); setOptions([]); setStatus(""); }
    lastKey.current = key; typed.current = false;
  }, [selected?.key]);
  useEffect(() => {
    const value = query.trim();
    request.current?.abort();
    if (selected || disabled || value.length < 2 || value.length > 100) { setOptions([]); setLoading(false); if (value.length < 2) setStatus(""); return; }
    const controller = new AbortController(); request.current = controller;
    const timer = window.setTimeout(() => {
      setLoading(true); setError("");
      api<unknown>(`/api/delivery/client-share-recipients?${new URLSearchParams({ folderRef: folderId, q: value })}`, { signal: controller.signal })
        .then(result => {
          if (controller.signal.aborted) return;
          if (!validClientShareRecipientSearch(result)) throw new Error("Client choices could not be verified. Search again.");
          setOptions(result.recipients); onPrimaryState?.(result.primary);
          // A failed half is said out loud; it never looks like "no matches".
          const failed = [result.primary === "failed" ? "Ledge Top Drone Services" : "", result.native === "failed" ? "connected workspace" : ""].filter(Boolean);
          setPartial(failed.length ? `Some ${failed.join(" and ")} clients could not be searched right now. Try again shortly.` : "");
          setStatus(result.truncated.connected ? "Some connected-workspace clients may not be listed. Type more of the name to narrow the search."
            : result.recipients.length === 0 ? "No client you can share with matches this search."
            : anyTruncated(result.truncated) ? "More clients match. Keep typing to narrow the list." : "");
        })
        .catch(caught => { if (!controller.signal.aborted) { setOptions([]); setError((caught as Error).message || "Clients could not be loaded."); } })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [folderId, query, selected, disabled, onPrimaryState]);
  useEffect(() => () => request.current?.abort(), []);
  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowDown", "ArrowUp", "Escape"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Escape") { event.stopPropagation(); document.getElementById(INPUT_ID)?.focus(); return; }
    const all = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
    const index = all.indexOf(event.currentTarget);
    all[event.key === "ArrowDown" ? Math.min(all.length - 1, index + 1) : Math.max(0, index - 1)]?.focus();
  };
  return <div className="client-share-picker">
    <label htmlFor={INPUT_ID}>Client</label>
    <input id={INPUT_ID} type="search" role="combobox" aria-autocomplete="list" aria-expanded={options.length > 0} aria-controls={LIST_ID}
      autoComplete="off" placeholder="Type a client, organization or email" value={query} disabled={disabled} maxLength={100}
      onKeyDown={event => { if (event.key !== "ArrowDown") return; const first = document.getElementById(LIST_ID)?.querySelector<HTMLButtonElement>('[role="option"]'); if (first) { event.preventDefault(); first.focus(); } }}
      onChange={event => { typed.current = true; setQuery(event.target.value); setStatus(""); setError(""); setPartial(""); if (selected) onSelect(null); }} />
    {loading && <small role="status">Searching clients…</small>}
    {options.length > 0 && <div id={LIST_ID} className="client-workspace-typeahead" role="listbox" aria-label="Matching clients">
      {options.map(option => <button type="button" role="option" key={option.key} aria-selected={selected?.key === option.key} disabled={disabled}
        onKeyDown={move} onClick={() => { onSelect(option); setQuery(option.displayName); setOptions([]); setStatus(""); }}>
        <strong>{option.displayName}</strong><small>{recipientDetail(option)}</small>
      </button>)}
    </div>}
    {status && <small className="workspace-search-guidance" role="status">{status}</small>}
    {error && <small className="error" role="alert">{error}</small>}
    {partial && <small className="error" role="alert">{partial}</small>}
    {selected && <small className="selected-audience-note" data-testid="client-share-selection">Selected: {selected.displayName} · {recipientDetail(selected)}</small>}
  </div>;
}
