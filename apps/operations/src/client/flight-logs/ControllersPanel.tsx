import { withOperationKey } from "./operation-keys";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, sessionScope } from "../api";
import { requestChoice } from "@ltds/ui";

interface SignIn { id: string; code: string; model: string | null; name: string | null; createdAt: string; expiresAt: string }
interface Controller { id: string; pilotId: string; pilotName?: string | null; model: string | null; name: string | null; status: "active" | "revoked"; signedInAt: string; lastSeenAt: string | null; rawLogs: number }

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never");

/**
 * Controller sign-in for the signed-in staff member: approve a code shown on a controller where you typed
 * your username, and see or sign out your controllers. Requests only ever come to the person they were
 * addressed to, so there is nothing to choose here.
 */
export function ControllersPanel({ canManageAll, alertsOnly = false, expanded = false }: { canManageAll: boolean; alertsOnly?: boolean; expanded?: boolean }) {
  const [username, setUsername] = useState<string | null | undefined>(undefined);
  const [signIns, setSignIns] = useState<SignIn[]>([]);
  const [controllers, setControllers] = useState<Controller[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const [pending, list] = await Promise.all([
        api<{ username: string | null; items: SignIn[] }>("/api/flight-logs/controller-sign-ins"),
        api<{ items: Controller[] }>(`/api/flight-logs/controllers${showAll ? "?all=1" : ""}`),
      ]);
      setUsername(pending.username); setSignIns(pending.items); setControllers(list.items); setState("ready");
    } catch (error) {
      setState(error instanceof ApiError && (error.status === 503 || error.status === 404) ? "unavailable" : "ready");
    }
  }, [showAll]);
  useEffect(() => { void load(); }, [load]);
  // While a code is waiting, check every few seconds so approving feels immediate on the controller.
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, signIns.length ? 4000 : 20000);
    return () => window.clearInterval(timer);
  }, [load, signIns.length]);

  async function decide(signIn: SignIn, approve: boolean) {
    setBusy(signIn.id); setMessage("");
    try {
      await withOperationKey(sessionScope(), `decide:${signIn.id}:${approve ? "approve" : "deny"}`, key =>
        api(`/api/flight-logs/controller-sign-ins/${encodeURIComponent(signIn.id)}/${approve ? "approve" : "deny"}`, { method: "POST", headers: { "Idempotency-Key": key } }));
      setMessage(approve ? `Approved. The controller (${signIn.code}) will sign in as you within a few seconds.` : "Denied. The controller won't sign in.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That didn't work. Try again.");
    }
    setBusy(""); void load();
  }
  async function revoke(controller: Controller) {
    const choice = await requestChoice({ title: "Sign this controller out?", description: `${controller.model ?? "This controller"} will stop uploading flight logs until someone signs in on it again. Logs already uploaded stay.`,
      choices: [{ value: "revoke", label: "Sign out controller", tone: "danger" }] });
    if (choice !== "revoke") return;
    setBusy(controller.id);
    try {
      await withOperationKey(sessionScope(), `revoke:${controller.id}`, key =>
        api(`/api/flight-logs/controllers/${encodeURIComponent(controller.id)}/revoke`, { method: "POST", headers: { "Idempotency-Key": key } }));
      setMessage("Controller signed out.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That didn't work. Try again.");
    }
    setBusy(""); void load();
  }

  if (state === "loading" || state === "unavailable") return null;
  if (alertsOnly && !signIns.length && !message) return null;
  const active = controllers.filter(c => c.status === "active");
  return <section className="flight-controllers" aria-label="Controllers">
    {signIns.map(signIn => <div key={signIn.id} className="flight-controller-request" role="alert">
      <div>
        <strong>Controller sign-in: <span className="flight-controller-code">{signIn.code}</span></strong>
        <p>{signIn.model ?? "A controller"} wants to sign in as you{username ? ` (${username})` : ""}. Approve only if this code is on the controller in front of you.</p>
      </div>
      <div className="flight-controller-actions">
        <button type="button" className="button-orange" disabled={!!busy} onClick={() => void decide(signIn, true)}>Approve</button>
        <button type="button" className="button-ghost" disabled={!!busy} onClick={() => void decide(signIn, false)}>Deny</button>
      </div>
    </div>)}
    {message && <p className="flight-logs-status" role="status">{message}</p>}
    {!alertsOnly && <details className="flight-controller-list" open={expanded || undefined}>
      <summary>Controllers <small>{active.length} signed in</small></summary>
      {username === null && <p className="flight-logs-status">You don't have a Ledge Top username yet, so you can't sign in on a controller. Ask an admin to set one.</p>}
      {username && <p className="flight-logs-status">To sign a controller in as you, open Ledge Top Logs on it and type <strong>{username}</strong>.</p>}
      {canManageAll && <label className="flight-controller-all"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.currentTarget.checked)} /> Show every pilot's controllers</label>}
      {controllers.length ? <ul>{controllers.map(c => <li key={c.id} className={c.status}>
        <span><strong>{c.model ?? "Controller"}</strong>{showAll && c.pilotName ? ` · ${c.pilotName}` : ""}
          <small>{c.status === "active" ? `Signed in ${when(c.signedInAt)} · last seen ${when(c.lastSeenAt)}` : "Signed out"} · {c.rawLogs.toLocaleString()} logs uploaded</small></span>
        {c.status === "active" && <button type="button" className="button-ghost button-small" disabled={!!busy} onClick={() => void revoke(c)}>Sign out</button>}
      </li>)}</ul> : <p className="flight-logs-status">No controllers yet.</p>}
    </details>}
  </section>;
}
