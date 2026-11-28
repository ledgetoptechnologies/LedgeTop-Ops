import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";

export const CLIENT_SEARCH_LABEL = "Client";

/** The match an arrow, Home or End key moves to; null for other keys or an empty list. */
export function nextActiveOption(active: number, key: string, count: number): number | null {
  if (!count) return null;
  if (key === "ArrowDown") return active < 0 ? 0 : Math.min(count - 1, active + 1);
  if (key === "ArrowUp") return active < 0 ? count - 1 : Math.max(0, active - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/** The one client search box for every Share dialog. Each dialog runs its own search and
 * passes the matches in; focus stays in the box, arrows move the highlight, Enter picks it.
 * Nothing is highlighted until an arrow key is pressed, and typing drops the highlight, so
 * Enter never picks from an older list. */
export function ClientSearchBox<T>({ id, query, onQueryChange, items, itemKey, renderItem, onPick, status, error, onRetry, disabled = false }: {
  id: string; query: string; onQueryChange: (value: string) => void;
  /** Matches for the current text; null before a search has answered. */
  items: readonly T[] | null; itemKey: (item: T) => string; renderItem: (item: T) => ReactNode; onPick: (item: T) => void;
  status?: string; error?: ReactNode; onRetry?: () => void; disabled?: boolean;
}) {
  const [active, setActive] = useState(-1);
  const count = items?.length ?? 0;
  const listId = `${id}-options`, optionId = (index: number) => `${id}-option-${index}`;
  // A new answer never carries a highlight over from the old list.
  useEffect(() => { setActive(-1); }, [items]);
  // The list scrolls, so the highlighted match is kept in view.
  useEffect(() => { if (active >= 0) document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" }); }, [active]);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const moved = nextActiveOption(active, event.key, count);
    if (moved !== null) { event.preventDefault(); setActive(moved); return; }
    if (event.key === "Enter") { event.preventDefault(); const chosen = items?.[active]; if (chosen && !disabled) onPick(chosen); return; }
    // Escape with matches showing clears the search; otherwise it is left to the dialog (which closes).
    if (event.key === "Escape" && count > 0) { event.preventDefault(); event.stopPropagation(); setActive(-1); onQueryChange(""); }
  };
  return <div className="client-search">
    <label htmlFor={id}>{CLIENT_SEARCH_LABEL}</label>
    <input id={id} type="search" role="combobox" aria-autocomplete="list" aria-controls={listId} aria-expanded={count > 0}
      aria-activedescendant={active >= 0 && active < count ? optionId(active) : undefined}
      value={query} onChange={event => { setActive(-1); onQueryChange(event.target.value); }} onKeyDown={onKeyDown} disabled={disabled}
      placeholder="Type a client or organization" maxLength={100} autoComplete="off" />
    {error && <div className="notice error" role="alert">{error}{onRetry && <> <button type="button" className="button-ghost button-small" onClick={onRetry}>Retry</button></>}</div>}
    <ul id={listId} className="client-search-list" role="listbox" aria-label="Matching clients" hidden={!count}>
      {(items ?? []).map((item, index) => <li key={itemKey(item)} id={optionId(index)} role="option" aria-selected={index === active}
        aria-disabled={disabled || undefined} className={index === active ? "active" : undefined}
        onMouseDown={event => event.preventDefault()}
        onClick={() => { if (!disabled) onPick(item); }}>{renderItem(item)}</li>)}
    </ul>
    {status && <small className="client-search-status" role="status">{status}</small>}
  </div>;
}
