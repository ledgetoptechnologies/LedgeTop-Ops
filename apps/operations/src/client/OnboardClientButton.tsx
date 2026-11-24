import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { ClientOnboardingStaff } from "./ClientOnboardingStaff";
import { endpoint, json, validSession } from "./onboarding-staff-api";
import { CLIENT_ONBOARDING_PATH } from "./operations-route";
import { readSessionTiming } from "./session-time";

/** True only when the onboarding page would open for this person: the same read-only
 * session check that page starts with. A disabled capability, a refusal or a failure hides it. */
export function useClientOnboardingAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void json(`${endpoint}/session`, { method: "GET", signal: controller.signal, headers: { "X-Native-Staff-Request": "1" } })
      .then(value => { if (!controller.signal.aborted) setAvailable(validSession(value) && Date.parse(value.verifiedUntil) > Date.now()); })
      .catch(() => { if (!controller.signal.aborted) setAvailable(false); });
    return () => controller.abort();
  }, []);
  return available;
}

const OnboardingDialog = createContext<{
  open: boolean; mounted: boolean; unavailable: boolean; error: string; dialogId: string;
  show: (opener: HTMLButtonElement) => void; dismiss: (opener: HTMLButtonElement) => void;
} | null>(null);

/** The signed-in shell owns the issuer; route-local controls can come and go. */
export function ClientOnboardingDialogProvider({ actorId, children }: { actorId: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const trigger = useRef<HTMLButtonElement | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const check = useRef<AbortController | null>(null);
  const authority = useRef<{ expiresAt: number; deadline: number } | null>(null);
  const lost = useRef(false);
  const expiryTimer = useRef<number | undefined>(undefined);

  const dialogId = useId();
  const onBusyChange = (value: boolean) => { busyRef.current = value; setBusy(value); };
  const discard = useCallback(() => {
    lost.current = true;
    authority.current = null;
    check.current?.abort();
    window.clearTimeout(expiryTimer.current);
    dialog.current?.close();
    setMounted(false);
    setOpen(false);
    setPending(false);
    setDialogError("Onboarding access could not be verified. Reload to continue.");
  }, []);
  useLayoutEffect(() => {
    // Do not carry the link across a document exit, including a bfcache restore.
    const pageHidden = () => { if (authority.current || check.current) discard(); };
    window.addEventListener("pagehide", pageHidden);
    return () => {
      window.removeEventListener("pagehide", pageHidden);
      check.current?.abort();
      check.current = null;
      authority.current = null;
      window.clearTimeout(expiryTimer.current);
    };
  }, [discard]);

  const canUseDialog = useCallback(() => Boolean(dialog.current?.open && authority.current
    && performance.now() < authority.current.deadline), []);

  const show = useCallback(() => {
    const modal = dialog.current;
    if (!modal || modal.open || !trigger.current?.isConnected) return;
    try {
      modal.showModal();
      setOpen(true);
      setDialogError("");
    } catch {
      setOpen(false);
      setDialogError("The dialog couldn't open.");
    }
  }, []);
  useLayoutEffect(() => {
    if (mounted) show();
  }, [mounted, show]);

  const openDialog = async (opener: HTMLButtonElement) => {
    if (lost.current || check.current || dialog.current?.open) return;
    if (authority.current && performance.now() >= authority.current.deadline) { discard(); return; }
    trigger.current = opener;
    const controller = new AbortController();
    check.current = controller;
    setPending(true);
    const started = performance.now();
    try {
      const value = await json("/api/session/status", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]), redirect: "error" });
      if (controller.signal.aborted) return;
      const { serverTime, expiresAt } = readSessionTiming(value, actorId);
      const previous = authority.current;
      // Access expiry is stable for a signed-in assertion, unlike a rotating CSRF token.
      // Do not rebind a retained issuer to a different assertion or actor.
      if (expiresAt === null || (previous && expiresAt !== previous.expiresAt)) { discard(); return; }
      const deadline = Math.min(started + expiresAt - serverTime, previous?.deadline ?? Infinity);
      const expire = () => {
        const remaining = deadline - performance.now();
        if (remaining <= 0) discard();
        else expiryTimer.current = window.setTimeout(expire, Math.min(remaining, 2_147_000_000));
      };
      if (deadline <= performance.now()) { discard(); return; }
      authority.current = { expiresAt, deadline };
      window.clearTimeout(expiryTimer.current);
      expire();
      if (mounted) show();
      else setMounted(true);
    } catch {
      if (!controller.signal.aborted) discard();
    } finally {
      if (check.current === controller) { check.current = null; setPending(false); }
    }
  };
  const dismiss = useCallback((opener: HTMLButtonElement) => {
    if (trigger.current !== opener) return;
    trigger.current = null;
    check.current?.abort();
    check.current = null;
    setPending(false);
    // A history/route change can remove the opener even during an in-flight write.
    dialog.current?.close();
    setOpen(false);
  }, []);
  const onClose = () => {
    if (dialog.current?.open) return;
    setOpen(false);
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (!dialog.current?.open && trigger.current?.isConnected
        && (focused === document.body || dialog.current?.contains(focused))) trigger.current.focus();
    });
  };
  return <OnboardingDialog.Provider value={{ open, mounted, unavailable: pending || lost.current, error: dialogError, dialogId, show: openDialog, dismiss }}>
    {children}
    {mounted && <dialog ref={dialog} id={dialogId} className="onboarding-dialog" aria-labelledby={dialogId + "-title"}
      onClose={onClose} onCancel={event => { if (busyRef.current) event.preventDefault(); }}>
      <header className="onboarding-dialog-header"><h2 id={dialogId + "-title"}>Onboard client</h2>
        <button type="button" className="button-ghost" disabled={busy} onClick={() => {
          if (!busyRef.current) dialog.current?.close();
        }}>Close</button></header>
      <ClientOnboardingStaff embedded onBusyChange={onBusyChange} canUseDialog={canUseDialog} />
    </dialog>}
  </OnboardingDialog.Provider>;
}

export function OnboardClientButton({ className = "button button-orange" }: { className?: string }) {
  const controller = useContext(OnboardingDialog);
  const available = useClientOnboardingAvailable();
  const dismiss = controller?.dismiss;
  const setTrigger = useCallback((opener: HTMLButtonElement | null) => {
    if (opener) return () => dismiss?.(opener);
  }, [dismiss]);
  const openReview = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.history.pushState(null, "", CLIENT_ONBOARDING_PATH);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  if (!controller || !available) return null;
  return <>
    <button ref={setTrigger} type="button" className={className + " onboarding-staff-action"} aria-haspopup="dialog"
      aria-expanded={controller.open} aria-controls={controller.mounted ? controller.dialogId : undefined}
      aria-disabled={controller.unavailable || undefined}
      onClick={event => controller.show(event.currentTarget)}>Onboard client</button>
    <a className="button button-ghost onboarding-staff-action" href={CLIENT_ONBOARDING_PATH} onClick={openReview}>Review submissions</a>
    {controller.error && <p role="alert">{controller.error}{" "}
      {controller.mounted && <><a href={CLIENT_ONBOARDING_PATH} onClick={openReview}>Open client onboarding</a>.</>}
    </p>}
  </>;
}
