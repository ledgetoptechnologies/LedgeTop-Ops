import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

interface Person { id: string; displayName: string; username: string | null }

/**
 * Administrators give each pilot a short username (for example "bkoltz") to type on a controller.
 * Only shown when the server says you may manage them; everyone else never sees this section.
 */
export function UsernamesPanel() {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const list = await api<{ items: Person[] }>("/api/admin/flight-logs/usernames");
      setPeople(list.items);
      setDrafts(Object.fromEntries(list.items.map(p => [p.id, p.username ?? ""])));
    } catch { setPeople(null); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(person: Person) {
    const value = (drafts[person.id] ?? "").trim().toLowerCase();
    if (value === (person.username ?? "")) return;
    setBusy(person.id); setMessage("");
    try {
      await api(`/api/admin/flight-logs/usernames/${encodeURIComponent(person.id)}`,
        { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: value || null }) });
      setMessage(value ? `${person.displayName} signs in on controllers as ${value}.` : `${person.displayName} no longer has a controller username.`);
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "That didn't save. Try again."); }
    setBusy("");
  }

  if (!people) return null;
  const missing = people.filter(p => !p.username).length;
  return <details className="flight-controller-list flight-usernames">
    <summary>Controller usernames <small>{missing ? `${missing} without one` : "everyone has one"}</small></summary>
    <p className="flight-logs-status">Pilots type their username on a controller to sign in. Keep them short: lowercase letters, numbers, dots, dashes or underscores.</p>
    {message && <p className="flight-logs-status" role="status">{message}</p>}
    <ul>{people.map(person => {
      const draft = drafts[person.id] ?? "", changed = draft.trim().toLowerCase() !== (person.username ?? "");
      return <li key={person.id}>
        <label htmlFor={`username-${person.id}`}><strong>{person.displayName}</strong></label>
        <form className="flight-username-form" onSubmit={event => { event.preventDefault(); void save(person); }}>
          <input id={`username-${person.id}`} value={draft} placeholder="No username" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={32}
            onChange={event => { const value = event.currentTarget.value; setDrafts(current => ({ ...current, [person.id]: value })); }} />
          <button type="submit" className="button-ghost button-small" disabled={!changed || !!busy}>{busy === person.id ? "Saving…" : "Save"}</button>
        </form>
      </li>;
    })}</ul>
  </details>;
}
