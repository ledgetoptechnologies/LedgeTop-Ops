import { useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { formatSessionExpiry } from "@ltds/ui";
import { formatSessionRemaining, readSessionTiming } from "./session-time";

type Clock = { deadline: number; expiresAt: number };

/** Mounted only while the account menu is open; never reads a cookie or JWT. */
export function SessionExpiry({ userId }: { userId: string }) {
  const [clock, setClock] = useState<Clock | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable" | "expired">("loading");
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    setClock(null);
    setState("loading");
    const controller = new AbortController();
    let busy = false;
    const refresh = async () => {
      if (busy || controller.signal.aborted || document.visibilityState === "hidden") return;
      busy = true;
      const started = performance.now();
      try {
        const result = await api<unknown>("/api/session/status", {
          signal: controller.signal, cache: "no-store", redirect: "error",
        });
        const timing = readSessionTiming(result, userId);
        if (controller.signal.aborted) return;
        if (timing.expiresAt === null) { setState("unavailable"); return; }
        const received = performance.now();
        // Anchor elapsed time to a monotonic clock, allowing for round-trip time.
        setClock({ deadline: received + timing.expiresAt - timing.serverTime - (received - started) / 2,
          expiresAt: timing.expiresAt });
        setNow(received);
        setState("ready");
      } catch (error) {
        if (!controller.signal.aborted)
          setState(error instanceof ApiError && error.status === 401 ? "expired" : "unavailable");
      } finally { busy = false; }
    };
    const foreground = () => { if (document.visibilityState !== "hidden") void refresh(); };
    void refresh();
    const tick = setInterval(() => setNow(performance.now()), 1000);
    const recheck = setInterval(() => { void refresh(); }, 60_000);
    addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      controller.abort();
      clearInterval(tick);
      clearInterval(recheck);
      removeEventListener("focus", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [userId]);
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
