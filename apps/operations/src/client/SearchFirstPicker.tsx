import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export type PickerOption = { value: string; label: string; detail?: string; disabled?: boolean };
const LIMIT = 50;

/** Nothing until the user types; then label or detail matches, case-insensitive, capped. */
export function filterPickerOptions(options: readonly PickerOption[], query: string): PickerOption[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  return options.filter(item => `${item.label} ${item.detail ?? ""}`.toLocaleLowerCase().includes(needle)).slice(0, LIMIT);
}

/** Type to filter, scroll the matches, pick one. Never lists every client up front. */
export function SearchFirstPicker({ id, label, options, value, onChange, disabled = false, placeholder }: {
  id: string; label: string; options: readonly PickerOption[]; value: string; onChange: (value: string) => void;
  disabled?: boolean; placeholder?: string;
}) {
  const selected = options.find(item => item.value === value) ?? null;
  const [query, setQuery] = useState(selected?.label ?? "");
  const typing = useRef(false), input = useRef<HTMLInputElement>(null);
  // A choice made or cleared by the parent shows in the box, so an automatic choice is never hidden.
  // A clear caused by the user's own typing keeps what they typed.
  useEffect(() => {
    if (typing.current) { typing.current = false; if (!selected) return; }
    setQuery(selected?.label ?? "");
  }, [selected?.value, selected?.label]);
  const matches = selected && query === selected.label ? [] : filterPickerOptions(options, query);
  const listId = `${id}-options`;
  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowDown", "ArrowUp", "Escape"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Escape") { input.current?.focus(); return; }
    const all = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="option"]:not([disabled])') ?? []);
    const index = all.indexOf(event.currentTarget);
    if (event.key === "ArrowUp" && index <= 0) { input.current?.focus(); return; }
    all[event.key === "ArrowDown" ? Math.min(all.length - 1, index + 1) : index - 1]?.focus();
  };
  return <div className="search-first-picker">
    <label htmlFor={id}>{label}</label>
    <input ref={input} id={id} type="search" role="combobox" aria-autocomplete="list" aria-expanded={matches.length > 0} aria-controls={listId}
      autoComplete="off" value={query} placeholder={placeholder ?? "Type to search"} disabled={disabled} maxLength={100}
      onKeyDown={event => { if (event.key !== "ArrowDown") return; const first = document.getElementById(listId)?.querySelector<HTMLButtonElement>('[role="option"]:not([disabled])'); if (first) { event.preventDefault(); first.focus(); } }}
      onChange={event => { setQuery(event.target.value); if (value) { typing.current = true; onChange(""); } }} />
    {matches.length > 0 && <div id={listId} className="search-first-picker-list" role="listbox" aria-label={label}>
      {matches.map(item => <button type="button" role="option" key={item.value} aria-selected={item.value === value} disabled={disabled || item.disabled}
        onKeyDown={move} onClick={() => { onChange(item.value); setQuery(item.label); input.current?.focus(); }}>
        <strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}
      </button>)}
    </div>}
    {query.trim() && !selected && matches.length === 0 && <small role="status">No match.</small>}
  </div>;
}
