import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { ClientOnboardingStaff } from "./ClientOnboardingStaff";
import { endpoint, json, validSession } from "./onboarding-staff-api";

import { CLIENT_ONBOARDING_PATH } from "./operations-route";

/** True only when the onboarding page would open for this person: the same read-only
 * session check that page starts with. A disabled capability, a refusal or a failure hides it. */
export function useClientOnboardingAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void json(`${endpoint}/session`, { method: "GET", signal: controller.signal, headers: { "X-Native-Staff-Request": "1" } })
      .then(value => { if (!controller.signal.aborted) setAvailable(validSession(value)); })
      .catch(() => { if (!controller.signal.aborted) setAvailable(false); });
    return () => controller.abort();
  }, []);
  return available;
}

/** Keep the issuer mounted across every way the native dialog can close. */
export function OnboardClientButton({ className = "button button-orange" }: { className?: string }) {
  const available = useClientOnboardingAvailable();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const openAfterMount = useRef(false);
  const dialogId = useId();
  const onBusyChange = (value: boolean) => { busyRef.current = value; setBusy(value); };

  const show = useCallback(() => {
    const modal = dialog.current;
    if (!modal || modal.open) return;
    try {
      modal.showModal();
      setOpen(true);
      setDialogError(false);
    } catch {
      setOpen(false);
      setDialogError(true);
    }
  }, []);
  useLayoutEffect(() => {
    if (!mounted || !openAfterMount.current) return;
    openAfterMount.current = false;
    show();
  }, [mounted, show]);

  const openDialog = () => {
    if (mounted) show();
    else {
      openAfterMount.current = true;
      setMounted(true);
    }
  };
  const onClose = () => {
    if (dialog.current?.open) return;
    setOpen(false);
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (!dialog.current?.open && trigger.current?.isConnected
        && (focused === document.body || dialog.current?.contains(focused))) trigger.current.focus();
    });
  };
  const openReview = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.history.pushState(null, "", CLIENT_ONBOARDING_PATH);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  if (!available) return null;
  return <>
    <button ref={trigger} type="button" className={className + " onboarding-staff-action"} aria-haspopup="dialog"
      aria-expanded={open} aria-controls={mounted ? dialogId : undefined} onClick={openDialog}>Onboard client</button>
    <a className="button button-ghost onboarding-staff-action" href={CLIENT_ONBOARDING_PATH} onClick={openReview}>Review submissions</a>
    {dialogError && <p role="alert">The dialog couldn't open. <a href={CLIENT_ONBOARDING_PATH} onClick={openReview}>Open client onboarding</a>.</p>}
    {mounted && <dialog ref={dialog} id={dialogId} className="onboarding-dialog" aria-labelledby={dialogId + "-title"}
      onClose={onClose} onCancel={event => { if (busyRef.current) event.preventDefault(); }}>
      <header className="onboarding-dialog-header"><h2 id={dialogId + "-title"}>Onboard client</h2>
        <button type="button" className="button-ghost" disabled={busy} onClick={() => {
          if (!busyRef.current) dialog.current?.close();
        }}>Close</button></header>
      <ClientOnboardingStaff embedded onBusyChange={onBusyChange} />
    </dialog>}
  </>;
}
