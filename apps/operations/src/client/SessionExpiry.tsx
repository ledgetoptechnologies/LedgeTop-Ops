import { useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { ACCESS_LOGOUT, formatSessionExpiry, useAccessSignOut } from "@ltds/ui";
import { readSessionTiming } from "./session-time";

type Clock = { deadline: number; expiresAt: number };

/** Mounted only while the account menu is open; never reads a cookie or JWT. */
export function SessionExpiry({ userId }: { userId: string }) {
  const [clock, setClock] = useState<Clock | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable" | "expired">("loading");
  const [now, setNow] = useState(() => performance.now());
  const [signingOut, signOut] = useAccessSignOut();
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
    const recheck = setInterval(() => { void refresh(); }, 60_000);
    addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      controller.abort();
      clearInterval(recheck);
      removeEventListener("focus", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [userId]);
  // No countdown is shown, so the clock only needs to move once: when the sign-in runs out.
  useEffect(() => {
    if (!clock) return;
    const timer = setTimeout(() => setNow(performance.now()), Math.max(0, clock.deadline - performance.now()) + 50);
    return () => clearTimeout(timer);
  }, [clock]);
  const expired = state === "expired" || state === "ready" && clock !== null && now >= clock.deadline;
  return <div className="account-session-status">
    {expired ? <><strong>Session expired</strong><small>Sign in again to continue.</small>
      <a role="menuitem" className="account-session-sign-in" href={ACCESS_LOGOUT} onClick={signOut} aria-disabled={signingOut || undefined}>
        {signingOut ? "Signing out…" : "Sign in again"}</a></>
      : state === "ready" && clock ? <>
        <small>Signed in</small>
        <strong>Expires <time dateTime={new Date(clock.expiresAt).toISOString()}>{formatSessionExpiry(clock.expiresAt)}</time></strong>
      </> : <small>{state === "loading" ? "Checking session…" : "Session time unavailable"}</small>}
  </div>;
}
