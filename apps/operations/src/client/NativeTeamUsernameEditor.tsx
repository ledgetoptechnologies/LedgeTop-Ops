import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";

type UsernameItem = { id: string; displayName: string; username: string | null };
type UsernameList = { items: UsernameItem[] };
type UsernameResult = { id: string; username: string | null };
const normalize = (value: string) => value.trim().toLowerCase();
const validUsername = (value: string) => /^[a-z0-9][a-z0-9._-]{1,31}$/.test(value);
const validItem = (value: unknown): value is UsernameItem => !!value && typeof value === "object"
  && typeof (value as UsernameItem).id === "string" && typeof (value as UsernameItem).displayName === "string"
  && ((value as UsernameItem).username === null || typeof (value as UsernameItem).username === "string");

export function NativeTeamUsernameEditor({ staffId }: { staffId: string }) {
  const [item, setItem] = useState<UsernameItem | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const desired = useRef<string | null>(null);
  const busyRef = useRef(false);
  const epoch = useRef(0);
  const mounted = useRef(true);
  const staffRef = useRef(staffId);
  staffRef.current = staffId;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; epoch.current++; };
  }, []);
  useEffect(() => {
    epoch.current++;
    setItem(null); setDraft(""); setLoaded(false); setError(""); setNotice(""); setUncertain(false);
    desired.current = null;
  }, [staffId]);

  const load = async () => {
    if (busyRef.current || !staffId || staffRef.current !== staffId) return;
    busyRef.current = true;
    const requestEpoch = epoch.current;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<UsernameList>("/api/admin/flight-logs/usernames");
      if (!Array.isArray(result.items) || result.items.some(value => !validItem(value))) throw new Error("Invalid username list response.");
      if (result.items.some(value => value.username !== null && (normalize(value.username) !== value.username || !validUsername(value.username)))) throw new Error("Invalid username value in response.");
      const matches = result.items.filter(value => value.id === staffId);
      if (matches.length > 1) throw new Error("The username list contains duplicate staff records.");
      if (!mounted.current || epoch.current !== requestEpoch || staffRef.current !== staffId) return;
      const found = matches[0] ?? null;
      setItem(found); setDraft(found?.username ?? ""); setLoaded(true);
      if (uncertain) setNotice(`Current server value reviewed: ${found?.username ?? "no username"}. The earlier request to ${desired.current === null ? "clear the username" : `set “${desired.current}”`} remains unresolved. Use the reviewed current value to acknowledge it before another edit.`);
      else setNotice(found ? "Username record loaded." : "No username record exists for this staff ID; editing is unavailable.");
    } catch (cause) {
      if (!mounted.current || epoch.current !== requestEpoch || staffRef.current !== staffId) return;
      setError(cause instanceof ApiError ? cause.message : "Username records could not be safely loaded.");
    } finally {
      busyRef.current = false;
      if (mounted.current && epoch.current === requestEpoch && staffRef.current === staffId) setBusy(false);
    }
  };

  const save = async () => {
    if (busyRef.current || !item || uncertain || !loaded || staffRef.current !== staffId) return;
    const normalized = normalize(draft);
    const value = normalized || null;
    if (value !== null && !validUsername(value)) {
      setError("Username must be 2–32 characters, start with a letter or digit, and contain only lowercase letters, digits, dot, underscore, or hyphen."); return;
    }
    busyRef.current = true;
    const requestEpoch = epoch.current;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<UsernameResult>(`/api/admin/flight-logs/usernames/${encodeURIComponent(staffId)}`, {
        method: "PUT", body: JSON.stringify({ username: value }),
      });
      if (result.id !== staffId || result.username !== value || (result.username !== null && (typeof result.username !== "string" || normalize(result.username) !== result.username || !validUsername(result.username)))) throw new Error("The save response did not match the requested staff username.");
      if (!mounted.current || epoch.current !== requestEpoch || staffRef.current !== staffId) return;
      setItem(current => current ? { ...current, username: result.username } : current);
      setDraft(result.username ?? ""); setNotice("Username save acknowledged by the server.");
    } catch (cause) {
      if (!mounted.current || epoch.current !== requestEpoch || staffRef.current !== staffId) return;
      setLoaded(false);
      if (cause instanceof ApiError && [400, 409].includes(cause.status)) setError(`${cause.message} The server rejected this save; reload before making another change.`);
      else {
        desired.current = value;
        setUncertain(true); setLoaded(false);
        setError(`The save outcome for ${value === null ? "clearing the username" : `“${value}”`} is unknown. This endpoint has no command ID or safe retry contract, so edits are frozen. Reload the current value, then explicitly acknowledge it before starting a new edit.`);
      }
    } finally {
      busyRef.current = false;
      if (mounted.current && epoch.current === requestEpoch && staffRef.current === staffId) setBusy(false);
    }
  };

  const clear = async () => {
    if (busyRef.current || !item || item.username === null || uncertain || !loaded || staffRef.current !== staffId) return;
    busyRef.current = true;
    const requestEpoch = epoch.current;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<UsernameResult>(`/api/admin/flight-logs/usernames/${encodeURIComponent(staffId)}`, {
        method: "PUT", body: JSON.stringify({ username: null }),
      });
      if (result.id !== staffId || result.username !== null) throw new Error("The clear response did not match the requested staff username.");
      if (!mounted.current || epoch.current !== requestEpoch || staffRef.current !== staffId) return;
      setItem(current => current ? { ...current, username: null } : current);
      setDraft(""); setNotice("Username cleared; this does not change Logs eligibility.");
    } catch (cause) {
      if (!mounted.current || epoch.current !== requestEpoch || staffRef.current !== staffId) return;
      if (cause instanceof ApiError && [400, 409].includes(cause.status)) setError(`${cause.message} The server rejected this clear; reload before making another change.`);
      else {
        desired.current = null;
        setUncertain(true); setLoaded(false);
        setError("The clear outcome is unknown. This endpoint has no command ID or safe retry contract, so edits are frozen. Reload the current value, then explicitly acknowledge it before starting a new edit.");
      }
    } finally {
      busyRef.current = false;
      if (mounted.current && epoch.current === requestEpoch && staffRef.current === staffId) setBusy(false);
    }
  };

  const acknowledge = () => {
    if (busyRef.current || !item || !loaded || !uncertain) return;
    desired.current = null; setUncertain(false); setDraft(item.username ?? ""); setError("");
    setNotice("Reviewed server value acknowledged. You may now make a new username change.");
  };

  return <section aria-label="Flight Logs username" aria-busy={busy}>
    <h4>Flight Logs username</h4>
    <p>A username identifies this staff account for Logs. It does not grant Logs access or eligibility.</p>
    <button type="button" className="button-ghost" disabled={busy} onClick={() => void load()}>{busy ? "Working…" : "Load username"}</button>
    {loaded && item && <div>
      <p>{item.displayName} <span>({item.id})</span></p>
      <p>Current username: {item.username ?? "None"}</p>
      <label>Username<input value={draft} maxLength={32} disabled={busy || uncertain} onChange={event => setDraft(event.target.value)} /></label>
      <button type="button" className="button-orange" disabled={busy || uncertain || normalize(draft) === (item.username ?? "")} onClick={() => void save()}>{busy ? "Saving…" : "Save username"}</button>
      <button type="button" className="button-ghost" disabled={busy || uncertain || item.username === null} onClick={() => void clear()}>Clear username</button>
      {uncertain && <button type="button" className="button-ghost" disabled={busy} onClick={acknowledge}>Use reviewed current value</button>}
    </div>}
    {loaded && !item && <p>No active-account username editor is available for this staff ID.</p>}
    {error && <div className="notice error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
  </section>;
}
