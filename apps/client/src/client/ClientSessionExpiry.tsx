import { useEffect, useState } from "react";
import { formatSessionExpiry, formatSessionRemaining } from "@ltds/ui";

type Clock = { deadline: number; expiresAt: number };

/**
 * How long this browser's sign-in lasts, like the Operations account menu. Mounted only while the menu is
 * open; reads the server's view of the verified sign-in and never inspects cookies or tokens itself.
 * Until the portal reports session timing, nothing is shown rather than a guess.
 */
export function ClientSessionExpiry() {
  const [clock, setClock] = useState<Clock | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable" | "unsupported" | "expired">("loading");
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      if (controller.signal.aborted || document.visibilityState === "hidden") return;
      const started = performance.now();
      try {
        const response = await fetch("/api/client/session/status", { credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 404) { setState("unsupported"); return; }
        if (response.status === 401) { setState("expired"); return; }
        const value = response.ok ? await response.json() as { serverTime?: unknown; expiresAt?: unknown } : null;
        const serverTime = typeof value?.serverTime === "string" ? Date.parse(value.serverTime) : NaN;
        const expiresAt = typeof value?.expiresAt === "string" ? Date.parse(value.expiresAt) : NaN;
        if (!Number.isFinite(serverTime) || !Number.isFinite(expiresAt)) { setState("unavailable"); return; }
        const received = performance.now();
        // Anchor to a monotonic clock, allowing for half the round trip, so a wrong device clock can't skew it.
        setClock({ deadline: received + expiresAt - serverTime - (received - started) / 2, expiresAt });
        setNow(received);
        setState("ready");
      } catch { if (!controller.signal.aborted) setState("unavailable"); }
    };
    void refresh();
    const tick = setInterval(() => setNow(performance.now()), 1000);
    const recheck = setInterval(() => { void refresh(); }, 60_000);
    return () => { controller.abort(); clearInterval(tick); clearInterval(recheck); };
  }, []);
  if (state === "unsupported") return null;
  const expired = state === "expired" || state === "ready" && clock !== null && now >= clock.deadline;
  return <div className="account-session-status">
    {expired ? <><strong>Session expired</strong><small>Sign in again to continue.</small></>
      : state === "ready" && clock ? <>
        <small>Session valid for</small>
        <strong role="timer" aria-live="off">{formatSessionRemaining(clock.deadline - now)}</strong>
        <small>Expires <time dateTime={new Date(clock.expiresAt).toISOString()}>{formatSessionExpiry(clock.expiresAt)}</time></small>
      </> : <small>{state === "loading" ? "Checking session…" : "Session time unavailable"}</small>}
  </div>;
}
