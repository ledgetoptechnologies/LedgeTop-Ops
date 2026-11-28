import { useEffect, useRef, useState } from "react";
import { ClientSearchBox } from "./ClientSearchBox";
import { api } from "./api";
import { anyTruncated, recipientDetail, recipientDetails, validClientShareRecipientSearch, type ClientShareBackendState, type ClientShareRecipient } from "./client-share-routing";

const INPUT_ID = "client-share-recipient-search";

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
          setPartial(result.primary === "failed" || result.native === "failed" ? "Some clients could not be searched right now. Try again shortly." : "");
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
  const details = recipientDetails(options);
  return <div className="client-share-picker">
    <ClientSearchBox id={INPUT_ID} query={query} disabled={disabled}
      onQueryChange={value => { typed.current = true; setQuery(value); setStatus(""); setError(""); setPartial(""); if (selected) onSelect(null); }}
      items={options} itemKey={option => option.key}
      renderItem={option => <><strong>{option.displayName}</strong><small>{details.get(option.key)}</small></>}
      onPick={option => { onSelect(option); setQuery(option.displayName); setOptions([]); setStatus(""); }}
      status={loading ? "Searching clients…" : status}
      error={error || partial ? <>{error}{error && partial ? " " : ""}{partial}</> : undefined} />
    {selected && <small className="selected-audience-note" data-testid="client-share-selection">Selected: {selected.displayName} · {details.get(selected.key) ?? recipientDetail(selected)}</small>}
  </div>;
}
